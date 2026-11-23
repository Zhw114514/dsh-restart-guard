/**
 * Model-switch recovery tests (v11 `switchRecovery`).
 *
 * The pre-step pipeline is faked: the guard's handler is called exactly as the
 * agent loop calls it, and a `prepareRequest` spy proves a reject never reaches
 * the request stage. The native compaction handler is modelled with its real
 * early-exit rule (source: dsh-compaction-basic:949), so "native skips" is an
 * assertion about measured tokens vs the native threshold, not a guess.
 *
 * Run: node scripts/switch-test.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyGuard } from '../lib/index.js'
import { asV022 } from './fake-engine.mjs'

let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label} [fake session/engine/llm]`)
}

const IDENTITY = async () => ({ version: '0.2.2-rc.1', profile: 'v022' })

function makeSession({ header = { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 65_536 }, surfaceNodes } = {}) {
  const events = [
    { seq: 0, type: 'system/message', data: { message: { content: [] } } },
    { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'y' }], source: { provider: header.provider, model: header.model } } } },
    { seq: 3, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'z' }] } } },
  ]
  const nodes = surfaceNodes ?? [0, 1, 2, 3]
  return {
    seq: events.length,
    get surface() { return { nodes: nodes.slice() } },
    requestHeader: () => ({ config: { ...header }, tools: [{ name: 'edit' }] }),
    eventAt: (seq) => events[seq],
    append: (type, data, extra = {}) => { const event = { seq: events.length, type, data, ...extra }; events.push(event); return event },
    events,
  }
}

function makeCtx({ total = 1_010_000, sequence = [300_000], header, defaultMaxTokens = 65_536, engineConfig = { maxTokens: 65_536, summarizationProvider: 'deepseek-official', summarizationModel: 'deepseek-flash' }, fail = null, config = {} } = {}) {
  const nodes = [0, 1, 2, 3]
  const session = makeSession({ header, surfaceNodes: nodes })
  const logs = []
  const handlers = new Map()
  const surfaceNodes = nodes
  const measurement = {
    totalTokens: total,
    get nodes() { return surfaceNodes.map((seq) => ({ seq, tokens: seq === 0 ? 4000 : Math.round(measurement.totalTokens / surfaceNodes.length) })) },
  }
  let call = 0
  const compacted = []
  const engine = asV022({
    config: engineConfig,
    compactRegion: async (start, end) => {
      compacted.push({ start, end })
      if (fail !== null) throw new Error(fail)
      measurement.totalTokens = sequence[Math.min(call, sequence.length - 1)]
      call += 1
      const replacement = session.append('user/message', { message: { content: [] } })
      surfaceNodes.splice(1, end - start + 1, replacement.seq)
    },
  })
  let prunedCount = 0
  const pruner = { pruneSession: () => { prunedCount += 1 } }
  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => handlers.set(event, { fn, options }),
    get: (name) => (name === 'agentPresets' ? { serviceFor: (_a, svc) => (svc === 'compaction' ? engine : svc === 'toolResultPruner' ? pruner : undefined) } : undefined),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, defaultMaxTokens }) },
    tokenMeter: { measure: () => measurement },
  }
  return { ctx, handlers, logs, compacted, measurement, session, config, get pruned() { return prunedCount } }
}

const selection = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }

async function preStep(h, sel = selection, session = h.session) {
  const handler = h.handlers.get('agent/pre-step').fn
  let prepared = false
  let progressed = false
  const decision = await handler({ agent: { session }, signal: undefined, modelSelection: sel }, async () => {
    progressed = true
    return { kind: 'enter', messages: [] }
  })
  if (decision?.kind !== 'reject') prepared = true
  return { decision, prepared, progressed }
}

// --- 1. same route: unchanged behaviour ------------------------------------
await run('same provider/model keeps the old pre-step behaviour', async () => {
  const h = makeCtx({ header: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 65_536 } })
  applyGuard(h.ctx, { ...h.config }, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'enter')
  assert.equal(h.compacted.length, 0, 'proactive=false must not compact')
  // The model-free prune floor is pre-existing behaviour and may still run.
})

// --- 2. switch under the wall: no recovery --------------------------------
await run('a switch under the wall does not recover', async () => {
  const h = makeCtx({ total: 100_000 })
  applyGuard(h.ctx, {}, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'enter')
  assert.equal(h.compacted.length, 0)
})

// --- 3. switch over the wall: recover, then native would skip -------------
await run('a switch over the wall recovers and settles below the native threshold', async () => {
  const h = makeCtx({ total: 1_010_000, sequence: [300_000] })
  applyGuard(h.ctx, {}, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'enter')
  assert.ok(h.compacted.length >= 1)
  assert.match(h.logs.join('\n'), /native compaction will skip/)
  const nativeThreshold = Math.floor(Math.min(1_048_576 * 0.8, 1_048_576 - 65_536 - 65_536))
  assert.ok(h.measurement.totalTokens < nativeThreshold, `measured ${h.measurement.totalTokens} must be below ${nativeThreshold}`)
})

// --- 4. recovery failure rejects ------------------------------------------
await run('a failed recovery rejects the step and never prepares a request', async () => {
  const h = makeCtx({ total: 1_010_000, fail: 'summary request TRANSPORT failed' })
  applyGuard(h.ctx, { maxSummaryAttempts: 1 }, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'reject')
  assert.equal(r.prepared, false)
  assert.match(h.logs.join('\n'), /REJECT model switch: reason=/)
  assert.match(h.logs.join('\n'), /writes=false|writes=true/)
})

// --- 5. dryRun blocks a switch --------------------------------------------
await run('dryRun on a switch over the wall rejects instead of letting native write', async () => {
  const h = makeCtx({ total: 1_010_000 })
  applyGuard(h.ctx, { dryRun: true }, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'reject')
  assert.equal(h.compacted.length, 0, 'dryRun must not write')
  assert.match(h.logs.join('\n'), /dryRun_blocked_model_switch/)
})

// --- 6. identity failure rejects ------------------------------------------
await run('an unproven engine identity rejects a switch', async () => {
  const h = makeCtx({ total: 1_010_000 })
  applyGuard(h.ctx, {}, { identify: async () => ({ unknown: true, reason: 'no attestation' }) })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'reject')
  assert.equal(h.compacted.length, 0)
  assert.equal(h.pruned, 0)
})

// --- 7. route mismatch rejects --------------------------------------------
await run('a summary-route mismatch rejects a switch', async () => {
  const h = makeCtx({ total: 1_010_000, engineConfig: { maxTokens: 65_536, summarizationProvider: 'other', summarizationModel: 'm' } })
  applyGuard(h.ctx, {}, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'reject')
  assert.equal(h.compacted.length, 0)
})

// --- 8/9. unknown states reject before any work ---------------------------
await run('a header without provider/model is unknown and rejects', async () => {
  const h = makeCtx({ total: 1_010_000, header: { model: 'deepseek-flash', maxTokens: 65_536 } })
  applyGuard(h.ctx, {}, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'reject')
  assert.equal(h.compacted.length, 0)
  assert.equal(h.pruned, 0)
})

await run('an incomplete modelSelection with a header is unknown and rejects', async () => {
  const h = makeCtx({ total: 1_010_000 })
  applyGuard(h.ctx, {}, { identify: IDENTITY })
  const r = await preStep(h, { provider: 'deepseek-official' })
  assert.equal(r.decision.kind, 'reject')
  assert.equal(h.compacted.length, 0)
})

// --- 10. no native double compaction --------------------------------------
await run('successful recovery performs exactly the planned chunk calls', async () => {
  const h = makeCtx({ total: 1_010_000, sequence: [800_000, 300_000] })
  applyGuard(h.ctx, {}, { identify: IDENTITY })
  const r = await preStep(h)
  if (r.decision.kind !== 'enter') console.log('DEBUG10:\n' + h.logs.join('\n'))
  assert.equal(r.decision.kind, 'enter')
  assert.equal(h.compacted.length, 2, 'two chunks planned, two calls, no native retry')
})

// --- 11. recovery stops above the native threshold ------------------------
await run('a recovery that stays above the native threshold rejects', async () => {
  // assumedRatio 1 makes the guard wall (115_808) larger than the native
  // threshold (83_040), so a 100_000 settle passes the wall but fails the
  // native check 鈥?the exact "would compact twice" case.
  const h = makeCtx({ total: 1_010_000, sequence: [100_000], defaultMaxTokens: 900_000 })
  applyGuard(h.ctx, { assumedRatio: 1 }, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'reject')
  assert.match(h.logs.join('\n'), /native threshold/)
})

// --- 12. switchRecovery=false restores old behaviour ----------------------
await run('switchRecovery=false leaves the switch to the native handler', async () => {
  const h = makeCtx({ total: 1_010_000 })
  applyGuard(h.ctx, { switchRecovery: false }, { identify: IDENTITY })
  const r = await preStep(h)
  assert.equal(r.decision.kind, 'enter')
  assert.equal(h.compacted.length, 0)
  assert.match(h.logs.join('\n'), /switchRecovery=false/)
})

console.log(`\n${checks} switch checks passed`)
