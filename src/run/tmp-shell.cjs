'use strict';
// tmp-shell.cjs — the shell half of the rooted-temp hook (ADR 0084 amendment 1). tmp-guard.cjs refuses a path in a file tool and a
// path literal in an inline script or heredoc; this module reads a shell command line for the other ways a worker names
// the drive root's `\tmp`: a redirect target, the destination of a write command, a wrapper's inner command (`bash -c`, `cmd /c`,
// `powershell -Command`), and a script run by name. It tokenizes (quotes, escapes, separators, redirects), it does not parse: a path
// built at run time, a here-string and a `$(...)` inside a word escape it. Plain node; `fs` is read only for a script run by name.
//
// Two modes. `bash` is Git Bash: it converts a bare `/tmp` in its own redirects and arguments to the user temp mount (which a
// worker's TEMP now points into belay's folder), so only a spelling that names a drive (`C:/tmp`, `C:\tmp` quoted, `/c/tmp`)
// reaches the drive root. `win` is cmd and PowerShell, which hand every rooted spelling, bare `/tmp` and `\tmp` included, to Windows.
const path = require('node:path');

const MAX_DEPTH = 3;
const SCRIPT_MAX_BYTES = 200000;
const SCRIPT_FRESH_MS = 60 * 60 * 1000; // only a script written or edited in the last hour is read (see readScript)

const DRIVE_FORM = /^(?:[a-z]:|\/[a-z]\/|\/[?.]\/)/i;
const base = (w) => String(w).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');

const PREFIX = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'builtin', 'start', 'call', 'nice']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const INTERP = /^(?:node(?:js)?|bun|deno|python[\d.]*|py|perl|ruby|bash|sh|zsh|dash|ksh|pwsh|powershell)$/;
const SCRIPT_EXT = /\.(?:[cm]?js|py|sh|ps1|cmd|bat)$/i;
const TESTY = /(?:^|[\\/])(?:tests?|__tests__|specs?)[\\/]|\.(?:test|spec)\./i; // a repository's own test files name /tmp on purpose

// Commands whose every path argument is written, and commands whose last one (or -t / -Destination) is.
const ANY_BASH = new Set(['tee', 'touch', 'mkdir', 'truncate']);
const DEST_BASH = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);
const ANY_WIN = new Set(['out-file', 'set-content', 'add-content', 'new-item', 'tee-object', 'export-csv', 'export-clixml', 'start-transcript',
  'expand-archive', 'compress-archive', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'ni', 'sc', 'ac', 'tee', 'mkdir', 'md', 'touch', 'curl', 'wget']);
const DEST_WIN = new Set(['copy-item', 'cpi', 'copy', 'cp', 'move-item', 'mi', 'move', 'mv', 'xcopy', 'robocopy']);
const PS_PATH = /^-(?:path|literalpath|filepath|outfile|destination|destinationpath|pspath|lp)$/i;
const PS_VALUE = /^-(?:value|encoding|inputobject|itemtype|type|stream|width|delimiter|header|include|exclude|filter|body|method|uri|headers|contenttype)$/i;
const DOTNET = /\[(?:System\.)?IO\.(?:File|Directory|StreamWriter|FileStream)\]::(?:Write|Append|Create|Copy|Move|Open|Set)\w*\(([^)]*)\)|New-Object\s+(?:System\.)?IO\.(?:StreamWriter|FileStream)\s*\(?([^)\n]*)/gi;

// Heredoc bodies are scanned as script text by tmp-guard; here they are removed so prose in a body is not read as commands.
function stripHeredocs(command) {
  const lines = command.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /(?<!<)<<(-?)\s*(["']?)([A-Za-z_][\w.-]*)\2/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[3]) j++;
    i = j;
  }
  return out.join('\n');
}

// Commands as { words, reds }: unquoted words, and the targets of `>`, `>>`, `>|`, `&>` and `N>` (a `>&N` duplicate and an input
// redirect `<` name nothing written). Separators: newline ; | & and parentheses (braces too, for a PowerShell block).
function parse(command, mode) {
  const bash = mode === 'bash';
  const s = bash ? stripHeredocs(command) : command;
  const cmds = [];
  let cur = { words: [], reds: [] };
  let word = null;
  let pend = null; // 'w': the next word is a redirect target; 'skip': it is an input file
  const push = () => {
    if (word !== null) {
      if (pend === 'w') cur.reds.push(word); else if (pend !== 'skip') cur.words.push(word);
      pend = null; word = null;
    }
  };
  const end = () => { push(); pend = null; if (cur.words.length || cur.reds.length) cmds.push(cur); cur = { words: [], reds: [] }; };
  const add = (c) => { word = (word === null ? '' : word) + c; };
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (bash && q === '"' && c === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) add(s[++i]);
      else add(c);
      continue;
    }
    if (c === '"' || c === "'") { q = c; if (word === null) word = ''; continue; }
    if (bash && c === '\\') { if (s[i + 1] === '\n') i++; else if (i + 1 < s.length) add(s[++i]); continue; }
    if (!bash && c === '`') { if (i + 1 < s.length && s[i + 1] !== '\n') add(s[++i]); else i++; continue; }
    if (c === '>') {
      if (word !== null && /^(?:\d+|&|\*)$/.test(word)) word = null; else push();
      let k = i + 1;
      if (s[k] === '>') k++;
      if (s[k] === '|') k++;
      const dup = s[k] === '&';
      if (dup) k++;
      i = k - 1;
      if (!dup) pend = 'w';
      continue;
    }
    if (c === '<') { push(); while (s[i + 1] === '<') i++; pend = 'skip'; continue; }
    if (c === '&' && s[i + 1] === '>') continue; // `&>file`: the `>` is read next
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || (!bash && (c === '{' || c === '}'))) { end(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { push(); continue; }
    add(c);
  }
  end();
  return cmds;
}

function createCheck(ctx) {
  const hitPath = (t, mode) => typeof t === 'string' && t !== '' && ctx.rooted(t) && (mode !== 'bash' || DRIVE_FORM.test(t.replace(/\\/g, '/').replace(/^\/{2,}/, '/')));

  // PowerShell parameters: -Path-like parameters carry a path, value-like ones are skipped, anything else is a switch or unknown.
  function psWords(args) {
    const named = []; const pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const m = /^(-[a-z]+)(?::(.*))?$/i.exec(a);
      if (m && a.startsWith('-')) {
        if (PS_PATH.test(m[1])) { const v = m[2] !== undefined && m[2] !== '' ? m[2] : args[++i]; if (v !== undefined) named.push({ name: m[1].toLowerCase(), v }); } else if (PS_VALUE.test(m[1]) && m[2] === undefined) i++;
      } else if (!/^\/[a-z]{1,3}(?::\S*)?$/i.test(a) || /^\/tmp$/i.test(a)) pos.push(a);
    }
    return { named, pos };
  }

  function writesTo(verb, args, mode) {
    const win = mode === 'win';
    if (win && (ANY_WIN.has(verb) || DEST_WIN.has(verb))) {
      const { named, pos } = psWords(args);
      if (ANY_WIN.has(verb)) return named.some((n) => hitPath(n.v, mode)) || pos.some((p) => hitPath(p, mode));
      const dest = named.filter((n) => n.name.includes('destination'));
      if (dest.length) return dest.some((n) => hitPath(n.v, mode));
      if (verb === 'robocopy') return pos.slice(1).some((p) => hitPath(p, mode));
      return pos.length > 1 && hitPath(pos[pos.length - 1], mode);
    }
    if (ANY_BASH.has(verb)) return args.some((a) => !a.startsWith('-') && hitPath(a, mode));
    if (DEST_BASH.has(verb)) {
      const pos = args.filter((a) => !a.startsWith('-'));
      const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
      if (t >= 0 && hitPath(args[t + 1], mode)) return true;
      const eq = args.find((a) => a.startsWith('--target-directory='));
      if (eq && hitPath(eq.slice(19), mode)) return true;
      return pos.length > 1 && hitPath(pos[pos.length - 1], mode);
    }
    if (verb === 'dd') return args.some((a) => /^of=/i.test(a) && hitPath(a.slice(3), mode));
    if (verb === 'curl') return args.some((a, i) => (/^(?:-o|--output)$/.test(a) && hitPath(args[i + 1], mode)) || (/^-o./.test(a) && hitPath(a.slice(2), mode)));
    if (verb === 'wget') return args.some((a, i) => (/^(?:-O|--output-document|-P|--directory-prefix)$/.test(a) && hitPath(args[i + 1], mode)));
    return false;
  }

  // A script run by name. One that lives under the drive root's tmp is refused. One that does not is read when it is small and was
  // written lately (a worker's throwaway script; a stable repository file that merely mentions /tmp, a test above all, is not
  // read), and refused when its own text writes there. A test file or `node --test` is never read.
  function readScript(file, mode, depth) {
    if (!file || TESTY.test(file)) return false;
    const fs = require('node:fs');
    try {
      const abs = path.resolve(ctx.cwd || process.cwd(), String(file).replace(/^\/([a-z])\//i, '$1:/'));
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > SCRIPT_MAX_BYTES || Date.now() - st.mtimeMs > SCRIPT_FRESH_MS) return false;
      const text = fs.readFileSync(abs, 'utf8');
      if (/\.sh$/i.test(abs)) return analyze(text, 'bash', depth + 1);
      if (/\.(?:ps1|cmd|bat)$/i.test(abs)) return analyze(text, 'win', depth + 1);
      return ctx.literal.test(text);
    } catch { return false; }
  }
  // Every word of an interpreter's command line that looks like a script (`node -r ./hook.js app.js` names two).
  function scriptsOf(raw, verb, args) {
    if (SCRIPT_EXT.test(raw)) return [raw];
    if (!INTERP.test(verb) || args.includes('--test') || args.some((a) => /^(?:-e|-c|-p|--eval|--print)$/.test(a))) return [];
    if (/^(?:pwsh|powershell)$/.test(verb)) { const k = args.findIndex((a) => /^-f(?:ile)?$/i.test(a)); return k >= 0 && args[k + 1] ? [args[k + 1]] : []; }
    return args.filter((a) => SCRIPT_EXT.test(a));
  }

  function command(cmd, mode, depth) {
    if (cmd.reds.some((t) => hitPath(t, mode))) return true;
    const w = cmd.words;
    let i = 0;
    while (i < w.length) {
      const b = base(w[i]);
      if (/^[A-Za-z_]\w*=/.test(w[i])) { i++; continue; }
      if (PREFIX.has(b)) { i++; if (b === 'env') while (i < w.length && w[i].startsWith('-')) i++; continue; }
      break;
    }
    if (i >= w.length) return false;
    const raw = w[i]; const verb = base(raw); const args = w.slice(i + 1);
    if (SHELLS.has(verb)) {
      const k = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      if (k >= 0 && args[k + 1] !== undefined && analyze(args[k + 1], 'bash', depth + 1)) return true;
    } else if (verb === 'cmd') {
      const k = args.findIndex((a) => /^\/{1,2}[ck]$/i.test(a));
      if (k >= 0 && analyze(args.slice(k + 1).join(' '), 'win', depth + 1)) return true;
    } else if (verb === 'powershell' || verb === 'pwsh') {
      let k = args.findIndex((a) => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a));
      if (k >= 0 && analyze(args.slice(k + 1).join(' '), 'win', depth + 1)) return true;
      k = args.findIndex((a) => /^-e(?:c|nc(?:odedcommand)?)?$/i.test(a));
      if (k >= 0 && args[k + 1] && analyze(Buffer.from(args[k + 1], 'base64').toString('utf16le'), 'win', depth + 1)) return true;
    }
    if (writesTo(verb, args, mode)) return true;
    return scriptsOf(raw, verb, args).some((s) => hitPath(s, mode) || readScript(s, mode, depth));
  }

  function analyze(text, mode, depth) {
    if (depth > MAX_DEPTH || typeof text !== 'string' || !text) return false;
    if (ctx.hit(text)) return true;
    if (mode === 'win') {
      for (const m of text.matchAll(DOTNET)) if (ctx.literal.test(m[1] || m[2] || '')) return true;
    }
    return parse(text, mode).some((c) => command(c, mode, depth));
  }
  return analyze;
}

// `ctx`: { cwd, rooted(path), literal (RegExp), hit(text) } from tmp-guard. True when the command writes the drive root's tmp.
function analyze(text, mode, ctx) { return createCheck(ctx)(text, mode, 0); }

module.exports = { analyze, parse };
