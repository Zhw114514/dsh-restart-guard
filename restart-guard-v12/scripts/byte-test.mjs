/**
 * Byte-budget tests (v12 `requestCharsBudget`).
 *
 * The estimator counts `JSON.stringify(projectedMessages).length + tools + 64K`.
 * These tests drive the guard with a fake surface whose projected messages have
 * a controllable length, so each cell of the token/chars matrix is exercised.
 *
 * Run: node scripts/byte-test.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyGuard } from '../lib/index.js'
import { asV022 } from './fake-engine.mjs'

const IDENTITY = async () => ({ version: '0.2.2-rc.1', profile: 'v022' })
let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

function makeCtx({ total = 1_010_000, after = 300_000, textChars = 80, keepBig = false, tools = [{ name: 'edit' }] } = {}) {
  const logs = []
  const handlers = new Map()
  const events = new Map()
  let seq = 0
  events.set(0, { type: 'system/message', seq: 0, data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } })
  const pushMessage = (chars) => {
    const id = `m-${++seq}`
    events.set(seq, { type: 'user/message', seq, data: { id, role: 'user', content: [{ type: 'text', text: 'x'.repeat(chars) }] } })
    return seq
  }
  const nodes = [0]
  for (let index = 0; index < 12; index += 1) nodes.push(pushMessage(textChars))
  const measurement = {
    totalTokens: total,
    get nodes() {
      return nodes.map((s) => ({ seq: s, tokens: s === 0 ? 4000 : Math.round(measurement.totalTokens / Math.max(1, nodes.length - 1)) }))
    },
  }
  const compacted = []
  const engine = asV022({
    config: { maxTokens: 65_536, summarizationProvider: 'deepseek-official', summarizationModel: 'deepseek-flash' },
    compactRegion: async (start, end) => {
      compacted.push({ start, end })
      const replacement = keepBig ? pushMessage(textChars * 12) : pushMessage(10)
      nodes.splice(0, nodes.length, replacement)
      measurement.totalTokens = Math.min(after, Math.max(1, Math.floor(measurement.totalTokens / 2)))
    },
  })
  const pruner = { pruneSession: () => {} }
  const session = {
    seq: nodes.length,
    get surface() { return { nodes: nodes.slice() } },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 65_536 }, tools }),
    eventAt: (s) => events.get(s),
    deriveEventMessage: (event) => event?.data ?? null,
    append: (type, data) => { const id = ++seq; events.set(id, { type, seq: id, data }); return { seq: id } },
  }
  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => handlers.set(event, { fn, options }),
    get: (name) => (name === 'agentPresets' ? { serviceFor: (_a, svc) => (svc === 'compaction' ? engine : svc === 'toolResultPruner' ? pruner : undefined) } : undefined),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 65_536 }) },
    tokenMeter: { measure: () => measurement },
  }
  return { ctx, handlers, logs, compacted, session, measurement }
}

const selection = { provider: 'deepseek-official', model: 'deepseek-flash' }
async function preStep(h, sel = selection) {
  const handler = h.handlers.get('agent/pre-step').fn
  return handler({ agent: { session: h.session }, signal: undefined, modelSelection: sel }, async () => ({ kind: 'enter' }))
}

const estimateOf = (h, tools) => {
  const messages = []
  for (const s of h.session.surface.nodes) {
    const m = h.session.eventAt(s)?.data
    if (m) messages.push(m)
  }
  return JSON.stringify(messages).length + JSON.stringify(tools).length + 65_536
}

// 1. token over, chars under
await run('token over + chars under compacts on tokens', async () => {
  const h = makeCtx({ total: 1_010_000 })
  applyGuard(h.ctx, { proactive: true, requestCharsBudget: 1_800_000 }, { identify: IDENTITY })
  const decision = await preStep(h)
  assert.equal(decision.kind, 'enter')
  assert.equal(h.compacted.length, 1)
})

// 2. token under, chars over
await run('token under + chars over still compacts', async () => {
  const h = makeCtx({ total: 100_000, textChars: 1_200_000 })
  applyGuard(h.ctx, { proactive: true, requestCharsBudget: 1_800_000 }, { identify: IDENTITY })
  const decision = await preStep(h)
  assert.equal(decision.kind, 'enter')
  assert.ok(h.compacted.length >= 1, 'chars budget must force a compaction')
  assert.match(h.logs.join('\n'), /chars budget satisfied/)
})

// 3. both over
await run('token over + chars over compacts once and passes', async () => {
  const h = makeCtx({ total: 1_010_000, textChars: 1_200_000 })
  applyGuard(h.ctx, { proactive: true, requestCharsBudget: 1_800_000 }, { identify: IDENTITY })
  const decision = await preStep(h)
  assert.equal(decision.kind, 'enter')
  assert.equal(h.compacted.length, 1)
})

// 4. both ok
await run('token ok + chars ok does nothing', async () => {
  const h = makeCtx({ total: 100_000 })
  applyGuard(h.ctx, { proactive: true, requestCharsBudget: 1_800_000 }, { identify: IDENTITY })
  const decision = await preStep(h)
  assert.equal(decision.kind, 'enter')
  assert.equal(h.compacted.length, 0)
})

// 5. margin boundary
await run('the 10% margin decides the boundary exactly', async () => {
  const probe = makeCtx({ total: 100_000, textChars: 1_200_000 })
  const estimate = estimateOf(probe, [{ name: 'edit' }])
  const boundary = Math.ceil(estimate * 1.1)
  const ok = makeCtx({ total: 100_000, textChars: 1_200_000 })
  applyGuard(ok.ctx, { proactive: true, requestCharsBudget: boundary }, { identify: IDENTITY })
  assert.equal((await preStep(ok)).kind, 'enter')
  assert.equal(ok.compacted.length, 0, 'exactly at the margin must pass')
  const over = makeCtx({ total: 100_000, textChars: 1_200_000 })
  applyGuard(over.ctx, { proactive: true, requestCharsBudget: boundary - 1 }, { identify: IDENTITY })
  assert.equal((await preStep(over)).kind, 'enter')
  assert.ok(over.compacted.length >= 1, 'one char over the margin must compact')
})

// 6. cannot satisfy -> reject
await run('a surface that stays over budget is rejected', async () => {
  const h = makeCtx({ total: 100_000, textChars: 1_200_000, keepBig: true })
  h.session.requestHeader = () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 65_536 }, tools: [{ name: 'edit' }] })
  applyGuard(h.ctx, { proactive: true, requestCharsBudget: 1_800_000, maxChunks: 1 }, { identify: IDENTITY })
  const decision = await preStep(h)
  assert.equal(decision.kind, 'reject')
  assert.match(h.logs.join('\n'), /request chars budget not met|chunk cap/)
})

// 7. budget 0 restores v11
await run('requestCharsBudget 0 disables the check', async () => {
  const h = makeCtx({ total: 100_000, textChars: 1_200_000 })
  applyGuard(h.ctx, { proactive: true, requestCharsBudget: 0 }, { identify: IDENTITY })
  const decision = await preStep(h)
  assert.equal(decision.kind, 'enter')
  assert.equal(h.compacted.length, 0)
})

// 8. switch path still recovers then passes
await run('a model switch recovers and passes once both budgets hold', async () => {
  const h = makeCtx({ total: 1_010_000, textChars: 1_200_000 })
  h.session.requestHeader = () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 65_536 }, tools: [{ name: 'edit' }] })
  applyGuard(h.ctx, { proactive: true, requestCharsBudget: 1_800_000 }, { identify: IDENTITY })
  const decision = await preStep(h)
  assert.equal(decision.kind, 'enter')
  assert.ok(h.compacted.length >= 1)
  assert.match(h.logs.join('\n'), /native compaction will skip/)
})

console.log(`\n${checks} byte-budget checks passed`)
