import type { Register } from 'claude-code'
import { activeConfig, streamArgv, deliveredPath, errorsPath, parseLine, createDelivery, lineSplitter, decide, readDelivered } from './core.mjs'

// ADR 0037 amendment 5 decision 3. Thin: it decides nothing. It starts `belay wake-stream` (a child the
// engine kills on reload and at exit), and for each wake line records the id in a file outside this copy
// (after the write has succeeded) and only then submits the text: at most once, never twice (core.mjs createDelivery). A session with no
// belay-run.json naming the orchestrator role (a watching session) does nothing. A delivered file that cannot be read
// (anything but a missing file) starts nothing and is read again later: it is never taken for "nothing delivered". A wake
// whose record write fails stays pending and is retried until the write lands, or, a claimed wake, until core.mjs GIVE_UP_MS
// leaves it to worker_wait.
export const registerWake = (on: Parameters<Register>[0]): void => {
  // The matcher keeps this apart from the panel's own unmatched session.start hook (one per module is allowed).
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    let cfg
    try { cfg = activeConfig(await $.fs.read(`${$.plugin.root}/belay-run.json`)) } catch { return started }
    if (!cfg) return started
    const file = deliveredPath(cfg)
    const errFile = errorsPath(cfg)
    let errors = ''
    const log = (entry: unknown) => { errors += `${JSON.stringify(entry)}\n`; void Promise.resolve($.fs.write(errFile, errors)).catch(() => undefined) }
    const sleep = (ms: number) => new Promise<void>((r) => { $.clock.after(ms, () => r()) })
    const begin = async (attempt: number): Promise<void> => {
      const content = await readDelivered({ read: () => $.fs.read(file), sleep })
      if (content === null) { // unreadable, not missing: deliver nothing and write nothing, try again later
        try { log({ at: Date.now(), stage: 'read', error: 'the delivered-wakes file could not be read; nothing is delivered until it can' }) } catch { /* nowhere to log */ }
        $.clock.after(Math.min(5000 * (2 ** attempt), 60000), () => { void begin(attempt + 1) })
        return
      }
      const delivery = createDelivery({
        file, initial: content,
        io: {
          write: (f: string, c: string) => $.fs.write(f, c),
          submit: (text: string) => $.prompt.submit({ text }),
          log,
        },
      })
      const delivered = delivery.delivered
      let chain: Promise<void> = Promise.resolve()
      let gotLine = false
      let retrying = false
      let retryMs = 1000
      // A wake whose record write failed is not lost: it stays in delivery.pending and is tried again, with a growing pause.
      const scheduleRetry = (): void => {
        if (retrying || !delivery.pending.size) return
        retrying = true
        $.clock.after(retryMs, () => {
          retrying = false
          chain = chain.then(() => delivery.retryPending()).then(() => undefined, () => undefined).then(() => {
            if (delivery.pending.size) { retryMs = Math.min(retryMs * 2, 30000); scheduleRetry() } else retryMs = 1000
          })
        })
      }
      const connect = async (): Promise<void> => {
        const split = lineSplitter()
        try {
          for await (const chunk of $.process.spawn({ argv: streamArgv(cfg) })) {
            if (chunk.stream !== 'stdout') continue
            for (const line of split(chunk.text)) {
              gotLine = true
              const p = parseLine(line)
              if (p.kind === 'wake' && decide(p, delivered) === 'submit') {
                const { id, text } = p
                chain = chain.then(() => delivery.deliver(id, text)).then(() => undefined, () => undefined).then(scheduleRetry)
              }
            }
          }
        } catch { /* the client is gone; the loop below decides */ }
      }
      let wait = 5000
      const loop = async (): Promise<void> => {
        gotLine = false
        await connect()
        await chain
        wait = gotLine ? 5000 : Math.min(wait * 2, 60000)
        $.clock.after(wait, () => { void loop() })
      }
      void loop()
    }
    void begin(0)
    return started
  })
}
