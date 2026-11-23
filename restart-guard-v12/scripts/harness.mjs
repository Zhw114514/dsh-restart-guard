/**
 * Wiring harness: exercise the real apply() with a fake cordis context.
 * Covers hook registration, the proactive gate (no write on an uncalibrated
 * healthy session), the refusal path, and the transport heuristic's on/off
 * switch. No DSH runtime, no model call, no session file.
 *
 * Run: node scripts/harness.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyGuard } from '../lib/index.js'
/** Test seam: behaviour suites inject a proven identity; identity itself is tested in identity-test.mjs. */
const TEST_IDENTITY = async () => ({ version: '0.2.2-rc.1', profile: 'v022' })
const apply = (ctx, config) => applyGuard(ctx, config, { identify: TEST_IDENTITY })
import { asV022 } from './fake-engine.mjs'

const initialSeqs = [0, 1, 2, 3, 4, 5]
const eventTypes = { 0: 'system/message', 1: 'user/message', 2: 'assistant/message', 3: 'user/message', 4: 'assistant/message', 5: 'user/message' }

function makeSession(surfaceNodes, initialModel = 'deepseek-flash') {
  const events = initialSeqs.map((seq) => ({ seq, type: eventTypes[seq], data: { message: { content: [{ type: 'text', text: 'x' }] } } }))
  let model = initialModel
  return {
    seq: events.length,
    setModel: (next) => { model = next },
    get surface() {
      return { nodes: surfaceNodes.slice() }
    },
    requestHeader: () => ({ config: { provider: 'deepseek-account', model, maxTokens: 256_000 }, tools: [{ name: 'edit' }] }),
    eventAt: (seq) => events[seq],
    append: (type, data, extra = {}) => {
      const event = { seq: events.length, type, data, ...extra }
      events.push(event)
      return event
    },
    events,
  }
}

function makeCtx({ total = 1_150_000, after = 300_000, windows = {} } = {}) {
  const logs = []
  const handlers = new Map()
  const compacted = []
  const surfaceNodes = initialSeqs.slice()
  const measurement = {
    totalTokens: total,
    get nodes() {
      return surfaceNodes.map((seq) => ({ seq, tokens: seq === 0 ? 4000 : Math.round(measurement.totalTokens / surfaceNodes.length) }))
    },
  }
  const engine = asV022({
    config: { maxTokens: 65_536 },
    compactRegion: async (start, end) => {
      compacted.push({ start, end })
      surfaceNodes.splice(1, end - start + 1, 99)
      measurement.totalTokens = after
    },
  })
  const pruned = { count: 0 }
  const pruner = { pruneSession: () => { pruned.count += 1 } }
  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => handlers.set(event, { fn, options }),
    get: (name) => (name === 'agentPresets' ? { serviceFor: (_a, svc) => (svc === 'compaction' ? engine : svc === 'toolResultPruner' ? pruner : undefined) } : undefined),
    llm: { resolveModelInfo: async (provider, model) => ({ context: { contextWindow: windows[model] ?? 1_048_576 }, defaultMaxTokens: 256_000 }) },
    tokenMeter: { measure: () => measurement },
  }
  return { ctx, handlers, logs, compacted, measurement, surfaceNodes, pruned }
}

const run = async (label, fn) => {
  await fn()
  console.log(`ok - ${label}`)
}
const preStep = (h, session) => h.handlers.get('agent/pre-step').fn({ agent: { session }, signal: undefined, modelSelection: session.requestHeader().config }, async () => ({ kind: 'enter', messages: [] }))
const refusalOf = (n) => ({
  code: 'CONTEXT_WINDOW_EXCEEDED',
  message: `This model's maximum context length is 1048576 tokens. However, you requested 1940511 tokens (${n} in the messages, 256000 in the completion).`,
})
const preStepWith = (h, session, selection) => h.handlers.get('agent/pre-step').fn({ agent: { session }, signal: undefined, modelSelection: selection }, async () => ({ kind: 'enter', messages: [] }))
const requestError = (h, session, failure) => h.handlers.get('agent/request-error').fn({ agent: { session }, failure, signal: undefined }, async () => 'next')

await run('registers both prepended hooks plus the streak reset', async () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx, { dryRun: true })
  assert.deepEqual([...handlers.keys()].sort(), ['agent/pre-step', 'agent/request-error', 'session/event'])
  for (const key of ['agent/pre-step', 'agent/request-error']) assert.equal(handlers.get(key).options.prepend, true)
})

await run('healthy session under an assumed wall: silent, no write', async () => {
  const { ctx, handlers, logs, compacted, surfaceNodes } = makeCtx({ total: 300_000 })
  apply(ctx, {})
  await preStep({ handlers }, makeSession(surfaceNodes))
  assert.equal(compacted.length, 0)
  assert.deepEqual(logs, [])
})

await run('over an assumed wall without calibration: warns once, never compacts', async () => {
  const { ctx, handlers, logs, compacted, surfaceNodes } = makeCtx({ total: 402_996 })
  apply(ctx, {})
  const session = makeSession(surfaceNodes)
  await preStep({ handlers }, session)
  await preStep({ handlers }, session)
  assert.equal(compacted.length, 0, 'proactive=false must not shrink an uncalibrated session')
  const text = logs.join('\n')
  assert.equal((text.match(/waiting for a provider refusal/g) ?? []).length, 1, 'warning must be emitted once per session')
  assert.doesNotMatch(text, /over wall: meter=/)
})

await run('proactive:true opts into compaction with the assumed ratio', async () => {
  const { ctx, handlers, logs, compacted, surfaceNodes } = makeCtx({ total: 1_150_000 })
  apply(ctx, { proactive: true })
  await preStep({ handlers }, makeSession(surfaceNodes))
  assert.ok(compacted.length >= 1)
  assert.equal(compacted[0].start, 1, 'chunk must not start at the system node')
  assert.match(logs.join('\n'), /trigger=pre-step/)
})

await run('missing compaction engine: no-op', async () => {
  const { ctx, handlers, logs, surfaceNodes } = makeCtx({ total: 1_150_000 })
  ctx.get = () => undefined
  apply(ctx, { proactive: true })
  await preStep({ handlers }, makeSession(surfaceNodes))
  assert.deepEqual(logs, [])
})

await run('request-error ignores non-overflow codes', async () => {
  const { ctx, handlers, logs, surfaceNodes } = makeCtx()
  apply(ctx, {})
  const result = await requestError({ handlers }, makeSession(surfaceNodes), { code: 'RATE_LIMIT' })
  assert.equal(result, 'next')
  assert.deepEqual(logs, [])
})

await run('refusal: calibrates from the provider text, compacts, retries', async () => {
  const { ctx, handlers, logs, compacted, surfaceNodes } = makeCtx({ total: 916_346, after: 200_000 })
  apply(ctx, {})
  const failure = {
    code: 'CONTEXT_WINDOW_EXCEEDED',
    message: "This model's maximum context length is 1048576 tokens. However, you requested 1940511 tokens (1684511 in the messages, 256000 in the completion).",
  }
  const result = await requestError({ handlers }, makeSession(surfaceNodes), failure)
  assert.deepEqual(result, { kind: 'retry' })
  assert.ok(compacted.length >= 1)
  assert.match(logs.join('\n'), /ratio=1\.84/)
  assert.match(logs.join('\n'), /source=refusal/)
})

await run('TRANSPORT is ignored while the heuristic is off', async () => {
  const { ctx, handlers, logs, compacted, surfaceNodes } = makeCtx({ total: 1_500_000 })
  apply(ctx, {})
  const session = makeSession(surfaceNodes)
  await requestError({ handlers }, session, { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' })
  await requestError({ handlers }, session, { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' })
  assert.equal(compacted.length, 0)
  assert.deepEqual(logs, [])
})

await run('a calibration for model A does not authorize model B', async () => {
  const { ctx, handlers, logs, compacted, measurement, surfaceNodes } = makeCtx({ total: 916_346, after: 200_000 })
  apply(ctx, {})
  const session = makeSession(surfaceNodes)
  const failure = {
    code: 'CONTEXT_WINDOW_EXCEEDED',
    message: "This model's maximum context length is 1048576 tokens. However, you requested 1940511 tokens (1684511 in the messages, 256000 in the completion).",
  }
  await requestError({ handlers }, session, failure)
  const afterCalibration = compacted.length
  assert.ok(afterCalibration >= 1, 'model A must calibrate and compact once')

  // Same session, different route: the A sample must not be reused.
  session.setModel('deepseek-v4-pro')
  measurement.totalTokens = 1_150_000
  await preStep({ handlers }, session)
  assert.equal(compacted.length, afterCalibration, 'model A calibration must not authorize model B compaction')
  assert.match(logs.join('\n'), /waiting for a provider refusal/)
})

await run('returning to the calibrated model restores authorization', async () => {
  const { ctx, handlers, logs, compacted, measurement, surfaceNodes } = makeCtx({ total: 916_346, after: 200_000 })
  apply(ctx, {})
  const session = makeSession(surfaceNodes)
  const failure = {
    code: 'CONTEXT_WINDOW_EXCEEDED',
    message: "This model's maximum context length is 1048576 tokens. However, you requested 1940511 tokens (1684511 in the messages, 256000 in the completion).",
  }
  await requestError({ handlers }, session, failure)
  const base = compacted.length
  session.setModel('deepseek-v4-pro')
  measurement.totalTokens = 1_150_000
  await preStep({ handlers }, session)
  session.setModel('deepseek-flash')
  const marks = logs.length
  await preStep({ handlers }, session)
  const after = logs.slice(marks).join('\n')
  assert.match(after, /source=recalled/, 'the original model is still calibrated')
  assert.ok(compacted.length >= base, 'surface may already be small; authorization is what is asserted')
})

await run('stale header + switch to a larger model: healthy, no prune and no compact', async () => {
  // A is the recorded header (128k window); the step's selection is B (1M).
  // Sizing B with A's window would flag a healthy 300k surface.
  const { ctx, handlers, logs, compacted, pruned, measurement, surfaceNodes } = makeCtx({
    total: 10_000,
    windows: { 'deepseek-flash': 131_072, 'deepseek-v4-pro': 1_048_576 },
  })
  apply(ctx, {})
  const session = makeSession(surfaceNodes, 'deepseek-flash')
  // Seed a calibration for A without compacting (well under A's wall).
  await requestError({ handlers }, session, refusalOf(20_000))
  assert.equal(compacted.length, 0, 'seeding must not compact')

  measurement.totalTokens = 300_000
  await preStepWith({ handlers }, session, { provider: 'deepseek-account', model: 'deepseek-v4-pro' })
  assert.equal(pruned.count, 0, 'the stale route must not authorize pruning')
  assert.equal(compacted.length, 0, 'B is healthy under B\'s own window')
  assert.doesNotMatch(logs.join('\n'), /over wall: meter=300000/)
})

await run('stale header + switch to a smaller model: defer instead of using A\'s parameters', async () => {
  const { ctx, handlers, logs, compacted, pruned, measurement, surfaceNodes } = makeCtx({
    total: 10_000,
    windows: { 'deepseek-flash': 1_048_576, 'deepseek-v4-pro': 131_072 },
  })
  apply(ctx, {})
  const session = makeSession(surfaceNodes, 'deepseek-flash')
  await requestError({ handlers }, session, refusalOf(20_000))
  assert.equal(compacted.length, 0)

  measurement.totalTokens = 300_000
  await preStepWith({ handlers }, session, { provider: 'deepseek-account', model: 'deepseek-v4-pro' })
  assert.equal(pruned.count, 0, 'prune must not run when route resolution is unsafe')
  assert.equal(compacted.length, 0, 'B cannot be sized with A\'s window or summarized by A')
  assert.match(logs.join('\n'), /route mismatch: request route=deepseek-account\/deepseek-v4-pro/)
})

await run('the same model under a different provider does not inherit a calibration', async () => {
  const { ctx, handlers, logs, compacted, pruned, measurement, surfaceNodes } = makeCtx({ total: 10_000, windows: {} })
  apply(ctx, {})
  const session = makeSession(surfaceNodes, 'deepseek-flash')
  await requestError({ handlers }, session, refusalOf(20_000))
  assert.equal(compacted.length, 0)

  measurement.totalTokens = 400_000
  await preStepWith({ handlers }, session, { provider: 'another-provider', model: 'deepseek-flash' })
  assert.equal(pruned.count, 0)
  assert.equal(compacted.length, 0)
  assert.match(logs.join('\n'), /route mismatch: request route=another-provider\/deepseek-flash/)
})

console.log('\nharness passed')
