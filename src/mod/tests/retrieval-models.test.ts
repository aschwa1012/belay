import { describe, expect } from 'claude-code/testing'
import { test } from './support'
import { boot, openPane, pane } from './support'

const E4 = 'Qwen/Qwen3-Embedding-4B-GGUF'
const R4 = 'giladgd/Qwen3-Reranker-4B-GGUF'
const models = (state: string, warm: unknown) => [
  { role: 'embedder', id: E4, state: 'ready', warm: null },
  { role: 'reranker', id: R4, state, warm },
]

// The run's embedder and reranker with their live state, from `retrieval_models` of the agents read: a warming reranker, a finished warm-up
// with its time and the searches that kept the fusion order, a failed one with its words, a profile with no reranker, and a run that pinned nothing.
describe('retrieval models line', () => {
  test('a reranker that is warming shows warming beside a ready embedder', async ($, on) => {
    const wd = await boot($, on, { retrievalModels: models('warming', { trigger: 'first_search', ms: null, served_warming: 2, error: null }) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('models embedder Qwen3-Embedding-4B ready')
    expect(text).toContain('reranker Qwen3-Reranker-4B warm-up warming')
  })

  test('a finished warm-up shows its time and how many searches kept the fusion order', async ($, on) => {
    const wd = await boot($, on, { retrievalModels: models('ready', { trigger: 'first_search', ms: 8200, served_warming: 3, error: null }) })
    await openPane($, wd)
    expect((await pane($)).text).toContain('warmed in 8200 ms; 3 searches kept the fusion order meanwhile')
  })

  test('a failed warm-up shows failed and its error', async ($, on) => {
    const wd = await boot($, on, { retrievalModels: models('failed', { trigger: 'retry', ms: 40, served_warming: 0, error: 'model file missing' }) })
    await openPane($, wd)
    const { text } = await pane($)
    expect(text).toContain('failed')
    expect(text).toContain('model file missing')
  })

  test('a profile with no reranker shows it off', async ($, on) => {
    const wd = await boot($, on, { retrievalModels: [{ role: 'embedder', id: 'nano', state: 'ready', warm: null }, { role: 'reranker', id: null, state: 'off', warm: null }] })
    await openPane($, wd)
    expect((await pane($)).text).toContain('reranker off')
  })

  test('a run that pinned nothing shows no models line', async ($, on) => {
    const wd = await boot($, on, {})
    await openPane($, wd)
    expect((await pane($)).text).not.toContain('models embedder')
  })

  test('a fallback in force shows the fallback profile for both models', async ($, on) => {
    const wd = await boot($, on, { retrievalModels: [{ role: 'embedder', id: 'nano', state: 'fallback', warm: null }, { role: 'reranker', id: R4, state: 'fallback', warm: null }] })
    await openPane($, wd)
    expect((await pane($)).text).toContain('fallback profile')
  })
})
