import type { Register } from 'claude-code'
import { activeConfig, streamArgv, deliveredPath, errorsPath, parseLine, createDelivery, lineSplitter, decide } from './core.mjs'

// ADR 0037 amendment 5 decision 3. Thin: it decides nothing. It starts `belay wake-stream` (a child the
// engine kills on reload and at exit), and for each wake line records the id in a file outside this copy
// (after the write has succeeded) and only then submits the text: at most once, never twice (core.mjs createDelivery). A session with no
// belay-run.json naming the orchestrator role (a watching session) does nothing.
export const registerWake = (on: Parameters<Register>[0]): void => {
  // The matcher keeps this apart from the panel's own unmatched session.start hook (one per module is allowed).
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    let cfg
    try { cfg = activeConfig(await $.fs.read(`${$.plugin.root}/belay-run.json`)) } catch { return started }
    if (!cfg) return started
    const file = deliveredPath(cfg)
    let content = ''
    try { content = await $.fs.read(file) } catch { content = '' }
    const errFile = errorsPath(cfg)
    let errors = ''
    const delivery = createDelivery({
      file, initial: content,
      io: {
        write: (f: string, c: string) => $.fs.write(f, c),
        submit: (text: string) => $.prompt.submit({ text }),
        log: (entry: unknown) => { errors += `${JSON.stringify(entry)}\n`; void Promise.resolve($.fs.write(errFile, errors)).catch(() => undefined) },
      },
    })
    const delivered = delivery.delivered
    let chain: Promise<void> = Promise.resolve()
    let gotLine = false
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
              chain = chain.then(() => delivery.deliver(id, text)).then(() => undefined, () => undefined)
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
    return started
  })
}
