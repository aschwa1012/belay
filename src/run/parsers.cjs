'use strict';
// Per-substrate stream parsers, one event vocabulary. ADR 0001 §Consequences: "the two event
// vocabularies do not overlap", so the translation lives here and nothing downstream reads a
// substrate-shaped line.
//
// Vocabulary (every event also carries `at`, `substrate` and `raw_type`):
//   ready         { session_id, repeat, answers_write }  system/init | thread.started (answers_write
//                                                         is Claude Code only, 5b-2; so are
//                                                         permission_mode and claude_code_version,
//                                                         ADR 0021)
//   write_done    { answers_write, command_uuid, state }     command_lifecycle `completed`\|`cancelled`
//                                                         (Claude Code only, for a write noted with a
//                                                         uuid; `cancelled` build step 6f, ADR 0023
//                                                         decision 8)
//   tool_use      { tool, args }
//   tool_result   { tool, bytes, shown? }          shown: { route, ids } of a memory_search or memory_retrieve answer (shown-ids.cjs)
//   assistant_text{ text, usage, context_tokens }   per-call usage, ADR 0007 §3
//   turn_end      { usage, cost_usd, num_turns, is_error, subtype, externally_triggered, answers_write,
//                   correlation, open_turns_after }  the last four are Claude Code only (`subtype`
//                   build step 6f, ADR 0023 amendment 3 decision 7: the result's own, so an
//                   interrupted turn is named by the substrate's own word, not inferred from is_error)
//   turn_failed   { error }
//   control_response { request_id, subtype, error }  a stream-json control_response (Claude Code only,
//                                                     build step 6e, ADR 0023 decision 1: the answer to
//                                                     an interrupt control_request the adapter sent)
//   bg_task       { op, task_id, tasks, status, is_backgrounded, description }  Claude Code only, build
//                 step 6e-3, ADR 0023 amendment 1: task_started (only when is_backgrounded),
//                 background_tasks_changed, task_updated, task_notification
//   (ADR 0041 Â§2, capture on only: tool_use gains tool_use_id and command; tool_result gains tool_use_id,
//   exit_code, exit_code_source, head, tail, files; see capture-fields.cjs)
//   raw           { line }                      anything unrecognised, including non-JSON
//
// ADR 0008 §5: a second `system/init` for a session id already seen is NOT a restart. It is emitted
// once per user message, and an inbound cross-session message injects a whole turn the harness
// never wrote to stdin. The parser keys on session id, marks the repeat, and correlates turns to
// the harness's own stdin writes so an uncorrelated turn is reported as externally triggered.
//
// 5b-2/5b-3: the real stream echoes no `user` message (A10's receipt), so a turn is matched to a
// write by order, not content. Claude Code only: `noteStdinWrite()` returns a write index and how
// many `system/init` had been seen at write time; each `system/init` pushes one entry onto
// `openTurns`, a FIFO of `{ answers_write, correlation }` — the oldest write made before that init,
// or `null` when none is left to claim — so a second init arriving before the first init's result
// cannot overwrite or strand either match (5b-2 review, FINDINGS.json finding 1: a single slot did
// exactly that). A `result` shifts the oldest open entry off the queue and answers it
// (`open_turns_after` names the queue length once shifted); with no entry open, correlation falls
// back to the oldest still-unanswered write by count (`correlation: 'count'`), as before. Undecidable,
// recorded limit, unchanged by this step: an unsolicited turn's own init arriving after a wake's
// write and before its real answer is indistinguishable from the answer, and is attributed to it.
// `pendingTurns` alone still drives the Codex branch, whose one-process-per-turn model has no
// unsolicited turn.

const { StringDecoder } = require('node:string_decoder');

const SUBSTRATES = ['claude-code', 'codex'];

const CF = require('./capture-fields.cjs');
const SH = require('./shown-ids.cjs');
const { textOf, byteLength } = require('./parser-text.cjs');

// Per-call context size from an assistant usage block. `result.usage` sums the assistant calls
// inside one turn, so it cannot give the size of the last call, which is what the compaction budget
// needs (ADR 0007 §3; measured in tests/run/fixtures/claude-stream.jsonl, where a turn's result
// usage equals the sum of its two assistant iterations).
// Claude Code: input + cache_read + cache_creation. Codex reports the total already in
// `input_tokens` with `cached_input_tokens` as a subset, so adding them would double count.
function contextTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (x) => (typeof x === 'number' ? x : 0);
  const total =
    'cached_input_tokens' in usage
      ? n(usage.input_tokens)
      : n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
  return total > 0 ? total : null;
}

// Any turn reporting a 5-minute cache write is a TTL degradation (ADR 0001 §7).
function fiveMinuteCacheWrite(usage) {
  const c = usage && usage.cache_creation;
  return !!(c && typeof c.ephemeral_5m_input_tokens === 'number' && c.ephemeral_5m_input_tokens > 0);
}

class Parser {
  constructor(substrate, opts = {}) {
    if (!SUBSTRATES.includes(substrate)) throw new Error('unknown substrate: ' + substrate);
    this.substrate = substrate;
    // ADR 0041 Â§2: with capture off no state is kept and no event changes. `opts.redact` replaces the
    // default redactor (tests); production uses src/core/redact.cjs.
    this.capture = opts && opts.capture ? { calls: new Map(), redact: opts.redact || null } : null;
    this.sessionId = null;
    this.initCount = 0;
    this.pendingTurns = 0; // Codex branch only: stdin writes made and not yet seen a turn for
    this.writeIndex = 0; // running count of stdin writes noted, both branches
    this.writeUuids = new Map(); // Claude Code only: a write's uuid -> its index, for command_lifecycle
    this.unansweredWrites = []; // Claude Code only: [{ index, inits_seen }], oldest first
    this.openTurns = []; // Claude Code only: FIFO of { answers_write, correlation }, one entry pushed
                          // per system/init since the last result, oldest first (5b-3)
    this.toolNames = new Map(); // tool_use_id -> tool name (Claude Code)
    this.lastCallUsage = null;
    this.contextTokens = null;
    this.lastMessage = '';
    this.buf = '';
    // A multi-byte character can straddle two stdout chunks. Decoding each chunk on its own would
    // corrupt it, which mangles the line written to stream.jsonl and can turn a `result` line into
    // a `raw` event, losing a turn end. StringDecoder holds the partial sequence across chunks.
    this.decoder = new StringDecoder('utf8');
  }

  // Called by the run manager every time it writes a user message to the worker's stdin. Returns the
  // write's index (5b-2), so a caller can key its own bookkeeping to the exact write, not the oldest.
  // `uuid` is the one the caller put on the user message, when it put one there.
  noteStdinWrite(uuid = null) {
    this.writeIndex += 1;
    if (this.substrate === 'codex') {
      this.pendingTurns += 1;
      return this.writeIndex;
    }
    if (uuid) this.writeUuids.set(uuid, this.writeIndex);
    this.unansweredWrites.push({ index: this.writeIndex, inits_seen: this.initCount });
    return this.writeIndex;
  }

  // Feed a chunk of stdout. Returns { lines, events }: the complete raw lines (for stream.jsonl)
  // and the events they produced, in order.
  pushChunk(chunk) {
    this.buf += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    const lines = [];
    const events = [];
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(line);
      for (const e of this.pushLine(line)) events.push(e);
    }
    return { lines, events };
  }

  // Called once when the stream closes. A worker killed mid-line leaves a partial line in the
  // buffer and a partial multi-byte sequence in the decoder; both are real output and belong in
  // stream.jsonl, so they are flushed rather than dropped.
  flush() {
    this.buf += this.decoder.end();
    const rest = this.buf;
    this.buf = '';
    if (!rest.trim()) return { lines: [], events: [] };
    const line = rest.replace(/\r$/, '');
    return { lines: [line], events: this.pushLine(line) };
  }

  pushLine(line) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return [this.ev('raw', { line: line.slice(0, 2000) }, null)];
    }
    return this.substrate === 'claude-code' ? this.claude(j) : this.codex(j);
  }

  ev(kind, fields, rawType) {
    return { kind, at: Date.now(), substrate: this.substrate, raw_type: rawType, ...fields };
  }

  // ------------------------------------------------------------- Claude Code

  claude(j) {
    const out = [];
    const rawType = j.type + (j.subtype ? '/' + j.subtype : '');

    // Emitted for a user message that carried a `uuid`: `queued`,
    // `started`, then `completed` once the turn that consumed it ends, whether the message ran as its
    // own turn or was folded into one already running. Only `completed` for a write this parser was
    // told about becomes an event; the substrate's own id names the write, never its content.
    // build step 6f, ADR 0023 decision 8: an interrupted write never completes — it ends `cancelled`
    // instead (the probe behind ADR 0023) — and `write_done` is emitted for that state exactly as for
    // `completed`, carrying `state` so the caller can tell the two apart (`answered_by`).
    if (j.type === 'command_lifecycle') {
      const index = (j.state === 'completed' || j.state === 'cancelled') ? this.writeUuids.get(j.command_uuid) : undefined;
      if (index === undefined) return out;
      this.writeUuids.delete(j.command_uuid);
      // A folded write never gets an init; left here it would be the oldest unanswered write and the
      // next init would be matched to it instead of to its own write.
      this.unansweredWrites = this.unansweredWrites.filter((w) => w.index !== index);
      out.push(this.ev('write_done', { answers_write: index, command_uuid: j.command_uuid, state: j.state }, rawType));
      return out;
    }

    // build step 6e, ADR 0023 decision 1: the answer to a pause's own interrupt control_request.
    if (j.type === 'control_response') {
      const r = j.response || {};
      return [this.ev('control_response', { request_id: r.request_id == null ? null : r.request_id, subtype: r.subtype || null, error: r.error || null }, rawType)];
    }

    // build step 6e-3, ADR 0023 amendment 1 decisions 1-2: four background-task subtypes -> bg_task; a
    // foreground task_started (is_backgrounded falsy) is not a background task and falls through to `raw`.
    if (j.type === 'system' && j.subtype === 'task_started' && j.is_backgrounded) {
      return [this.ev('bg_task', { op: 'started', task_id: j.task_id, tasks: null, status: null, is_backgrounded: true, description: j.description || null }, rawType)];
    }
    if (j.type === 'system' && j.subtype === 'background_tasks_changed') {
      return [this.ev('bg_task', { op: 'list', task_id: null, tasks: (j.tasks || []).map((t) => t.task_id), status: null, is_backgrounded: null, description: null }, rawType)];
    }
    if (j.type === 'system' && j.subtype === 'task_updated') {
      return [this.ev('bg_task', { op: 'status', task_id: j.task_id, tasks: null, status: (j.patch && j.patch.status) || null, is_backgrounded: null, description: null }, rawType)];
    }
    if (j.type === 'system' && j.subtype === 'task_notification') {
      return [this.ev('bg_task', { op: 'notified', task_id: j.task_id, tasks: null, status: j.status || null, is_backgrounded: null, description: null }, rawType)];
    }

    if (j.type === 'system' && j.subtype === 'init') {
      const repeat = this.sessionId != null && j.session_id === this.sessionId;
      if (!repeat) this.sessionId = j.session_id || this.sessionId;
      this.initCount += 1;
      // 5b-3: answers the oldest write made before this init (inits_seen < the count just
      // incremented), same rule as 5b-2, but the match is pushed onto `openTurns` rather than
      // overwriting a single slot, so a second init before the first init's result cannot steal or
      // strand either write's match.
      let matched = null;
      for (let idx = 0; idx < this.unansweredWrites.length; idx += 1) {
        if (this.unansweredWrites[idx].inits_seen < this.initCount) {
          matched = this.unansweredWrites.splice(idx, 1)[0];
          break;
        }
      }
      const answersWrite = matched ? matched.index : null;
      this.openTurns.push({ answers_write: answersWrite, correlation: 'init-order' });
      out.push(
        this.ev(
          'ready',
          {
            session_id: j.session_id || this.sessionId,
            repeat,
            init_count: this.initCount,
            mcp_servers: j.mcp_servers || null,
            belay_tools: (j.tools || []).filter((t) => String(t).startsWith('mcp__belay')).length,
            // ADR 0024, build step S2: the surface the worker actually got, for ready.cjs's checkSurface.
            tools: j.tools || null,
            plugins: j.plugins || null,
            memory_paths: j.memory_paths || null,
            answers_write: answersWrite,
            // ADR 0021 decisions 3 and 4: what the session actually started with, from the
            // substrate's own event, never from what was asked for.
            permission_mode: j.permissionMode || null,
            claude_code_version: j.claude_code_version || null,
            model: j.model || null, // build step W2-3: the model the session actually started with
          },
          rawType
        )
      );
      return out;
    }

    // ADR 0007 decision 3 (build 12, `compact_at_tokens`): the substrate's own compaction boundary. Only a
    // lever-on worker acts on it (compaction.cjs); a stream without one is unchanged.
    if (j.type === 'system' && j.subtype === 'compact_boundary') {
      const m = j.compact_metadata || {};
      const num = (x) => (typeof x === 'number' ? x : null);
      this.awaitPostCall = true;
      return [this.ev('compact_boundary', { trigger: m.trigger || null, pre_tokens: num(m.pre_tokens), post_tokens: num(m.post_tokens), duration_ms: num(m.duration_ms) }, rawType)];
    }

    if (j.type === 'assistant' && j.message) {
      const usage = j.message.usage || null;
      if (j.message.id) this.lastCallId = j.message.id; // one API call can emit several assistant events under one id
      if (usage) {
        this.lastCallUsage = usage;
        const ctx = contextTokensOf(usage);
        if (ctx != null) this.contextTokens = ctx;
        // The first call after a boundary: the fallback for a boundary that reports no post_tokens.
        if (this.awaitPostCall && ctx != null) {
          this.awaitPostCall = false;
          out.push(this.ev('call_context', { message_id: j.message.id || null, context_tokens: ctx }, rawType));
        }
      }
      const blocks = Array.isArray(j.message.content) ? j.message.content : [];
      let text = '';
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') text += b.text;
        if (b.type === 'tool_use') {
          this.toolNames.set(b.id, b.name);
          const f = { tool: b.name, args: b.input == null ? {} : b.input };
          if (this.capture) {
            this.capture.calls.set(b.id, { tool: b.name, args: f.args });
            f.tool_use_id = b.id;
            f.command = CF.commandOf(f.args, this.capture.redact);
          }
          out.push(this.ev('tool_use', f, rawType));
        }
      }
      if (text) {
        out.push(
          this.ev(
            'assistant_text',
            { text, usage, context_tokens: this.contextTokens, five_minute_cache_write: fiveMinuteCacheWrite(usage) },
            rawType
          )
        );
      }
      return out;
    }

    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      // The message's top-level tool_use_result describes one result; with several blocks it names none of them.
      const nResults = j.message.content.filter((x) => x && x.type === 'tool_result').length;
      for (const b of j.message.content) {
        if (b.type !== 'tool_result') continue;
        const f = SH.attach({ tool: this.toolNames.get(b.tool_use_id) || null, bytes: byteLength(textOf(b.content)), is_error: !!b.is_error }, b.content);
        if (this.capture) Object.assign(f, this.claudeCapture(b, nResults === 1 ? j.tool_use_result : null, f));
        out.push(this.ev('tool_result', f, rawType));
      }
      if (out.length) return out;
      return [this.ev('raw', { line: JSON.stringify(j).slice(0, 2000) }, rawType)];
    }

    if (j.type === 'result') {
      // 5b-3: a result answers the oldest still-open init (`openTurns`, a FIFO — possibly
      // `answers_write: null` when that init matched no write); with none open, it falls back to the
      // old count rule — the oldest write still unanswered, if any.
      let answersWrite;
      let correlation;
      if (this.openTurns.length) {
        const entry = this.openTurns.shift();
        answersWrite = entry.answers_write;
        correlation = entry.correlation;
      } else {
        correlation = 'count';
        const entry = this.unansweredWrites.shift();
        answersWrite = entry ? entry.index : null;
      }
      if (this.capture) this.capture.calls.clear(); // a call interrupted without a result must not leak
      const openTurnsAfter = this.openTurns.length;
      const externally = answersWrite === null;
      out.push(
        this.ev(
          'turn_end',
          {
            usage: j.usage || null,
            model_usage: j.modelUsage || null, // build step W2-3
            per_call_usage: this.lastCallUsage,
            context_tokens: this.contextTokens,
            last_call_id: this.lastCallId || null,
            cost_usd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
            num_turns: typeof j.num_turns === 'number' ? j.num_turns : null,
            is_error: !!j.is_error,
            subtype: j.subtype || null,
            text: typeof j.result === 'string' ? j.result : '',
            duration_ms: typeof j.duration_ms === 'number' ? j.duration_ms : null,
            externally_triggered: externally,
            answers_write: answersWrite,
            correlation,
            open_turns_after: openTurnsAfter,
          },
          rawType
        )
      );
      return out;
    }

    return [this.ev('raw', { line: JSON.stringify(j).slice(0, 2000) }, rawType)];
  }

  // Capture fields (ADR 0041 Â§2). Called only when capture is on.
  claudeCapture(b, toolUseResult, f) {
    const call = this.capture.calls.get(b.tool_use_id) || {};
    this.capture.calls.delete(b.tool_use_id);
    const text = textOf(b.content);
    const { head, tail, redaction } = CF.headTail(text, this.capture.redact);
    return {
      tool_use_id: b.tool_use_id == null ? null : b.tool_use_id,
      ...CF.claudeExit(f.tool, f.is_error, text),
      head,
      tail,
      redaction,
      files: CF.claudeFiles(toolUseResult, call.args),
    };
  }

  codexCapture(it, payload) {
    this.capture.calls.delete(it.id);
    const text = typeof it.aggregated_output === 'string' ? it.aggregated_output : typeof payload === 'string' ? payload : JSON.stringify(payload == null ? '' : payload);
    const { head, tail, redaction } = CF.headTail(text, this.capture.redact);
    return { tool_use_id: it.id == null ? null : it.id, ...CF.codexExit(it), head, tail, redaction, files: CF.codexFiles(it) };
  }

  // ------------------------------------------------------------------ Codex

  codexFileChange(j, it, rawType) {
    const out = [];
    const id = it.id == null ? null : it.id;
    const changes = Array.isArray(it.changes) ? it.changes : [];
    const seen = id !== null && this.capture.calls.has(id);
    if (!seen) {
      if (id !== null) this.capture.calls.set(id, { tool: 'file_change', args: { changes } });
      out.push(this.ev('tool_use', { tool: 'file_change', args: { changes }, tool_use_id: id, command: null }, rawType));
    }
    if (j.type === 'item.completed') {
      if (id !== null) this.capture.calls.delete(id);
      const files = CF.codexFiles(it);
      out.push(this.ev('tool_result', {
        tool: 'file_change', bytes: byteLength(changes), is_error: it.status === 'failed' || !!it.error,
        tool_use_id: id, exit_code: null, exit_code_source: null, head: files.join('\n'), tail: '', redaction: 'applied', files,
      }, rawType));
    }
    return out;
  }

  codex(j) {
    const out = [];
    const it = j.item || null;
    const rawType = j.type + (it && it.type ? '/' + it.type : '');

    if (j.type === 'thread.started') {
      const repeat = this.sessionId != null && j.thread_id === this.sessionId;
      if (!repeat) this.sessionId = j.thread_id || this.sessionId;
      this.initCount += 1;
      return [this.ev('ready', { session_id: j.thread_id || this.sessionId, repeat, init_count: this.initCount }, rawType)];
    }

    if (j.type === 'turn.completed') {
      if (this.capture) this.capture.calls.clear();
      const externally = this.pendingTurns > 0 ? false : true;
      if (this.pendingTurns > 0) this.pendingTurns -= 1;
      const u = j.usage || null;
      if (u) this.lastCallUsage = u;
      return [
        this.ev(
          'turn_end',
          {
            usage: u,
            per_call_usage: u,
            context_tokens: u ? contextTokensOf(u) : this.contextTokens,
            cost_usd: null, // Codex --json reports tokens, not dollars
            num_turns: 1, // one turn per process by design (ADR 0001, ADR 0007 §4)
            is_error: false,
            text: this.lastMessage || '',
            externally_triggered: externally,
          },
          rawType
        ),
      ];
    }

    if (j.type === 'turn.failed') {
      if (this.pendingTurns > 0) this.pendingTurns -= 1;
      return [this.ev('turn_failed', { error: j.error || null }, rawType)];
    }

    // Capture only (the off output stays as before): Codex reports an edit as a file_change item whose
    // changes[{path, kind}] name the files. The shape follows Codex exec's JSON item schema; no recorded
    // stream in this repository carries one.
    if (this.capture && it && it.type === 'file_change' && (j.type === 'item.started' || j.type === 'item.completed')) {
      return this.codexFileChange(j, it, rawType);
    }

    if (it && j.type === 'item.started' && (it.type === 'mcp_tool_call' || it.type === 'command_execution' || it.tool)) {
      // ADR 0058 (B7): a command_execution item carries its command, not arguments; reading only arguments gave every
      // command the same {} and so the same args_sha256_12 in the tool digest.
      const f = { tool: it.tool || it.name || it.type, args: it.arguments != null ? it.arguments : (it.command != null ? { command: it.command } : {}) };
      if (this.capture) {
        f.tool_use_id = it.id == null ? null : it.id;
        f.command = CF.commandOf(it, this.capture.redact);
      }
      return [this.ev('tool_use', f, rawType)];
    }

    if (it && j.type === 'item.completed') {
      if (it.type === 'mcp_tool_call' || it.type === 'command_execution' || it.tool) {
        const payload = it.result !== undefined ? it.result : it.output !== undefined ? it.output : it;
        const f = SH.attach({ tool: it.tool || it.name || it.type, bytes: byteLength(payload), is_error: !!it.error || (it.type === 'mcp_tool_call' && (it.status === 'failed' || !!(it.result && (it.result.is_error || it.result.isError)))) }, payload);
        if (this.capture) Object.assign(f, this.codexCapture(it, payload));
        // A failed command is an error whatever the item's error field says: nonzero exit or status failed.
        if (this.capture && it.type === 'command_execution') f.is_error = f.is_error || (Number.isInteger(it.exit_code) && it.exit_code !== 0) || it.status === 'failed';
        out.push(this.ev('tool_result', f, rawType));
      }
      if (it.type === 'agent_message') {
        this.lastMessage = typeof it.text === 'string' ? it.text : '';
        out.push(this.ev('assistant_text', { text: this.lastMessage, usage: null, context_tokens: this.contextTokens }, rawType));
      }
      if (out.length) return out;
    }

    return [this.ev('raw', { line: JSON.stringify(j).slice(0, 2000) }, rawType)];
  }
}

function createParser(substrate, opts) {
  return new Parser(substrate, opts);
}

module.exports = { Parser, createParser, contextTokensOf, fiveMinuteCacheWrite, byteLength, textOf, SUBSTRATES };
