/**
 * Transport-heuristic, retry-cap, and backoff tests for the candidate guard.
 * Pure Node: fake session, fake engine, no DSH runtime, no model call.
 *
 * Run: node scripts/transport-test.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyGuard } from '../lib/index.js'
/** Test seam: behaviour suites inject a proven identity; identity itself is tested in identity-test.mjs. */
const TEST_IDENTITY = async () => ({ version: '0.2.2-rc.1', profile: 'v022' })
const apply = (ctx, config) => applyGuard(ctx, config, { identify: TEST_IDENTITY })
import { asV022 } from './fake-engine.mjs'

let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

const REFUSAL = {
  code: 'CONTEXT_WINDOW_EXCEEDED',
  message: "This model's maximum context length is 1048576 tokens. However, you requested 1940511 tokens (1684511 in the messages, 256000 in the completion).",
}

function makeHarness({ total = 1_150_000, after = 300_000, engineImpl } = {}) {
  const events = []
  const logs = []
  const handlers = new Map()
  const compacted = []
  const surfaceNodes = [0, 1, 2, 3, 4, 5]
  let model = 'deepseek-flash'

  const addEvent = (type, data = {}, extra = {}) => {
    const event = { seq: events.length, type, data, ...extra }
    events.push(event)
    return event
  }
  addEvent('system/message', { message: { content: [{ type: 'text', text: 'system' }] } })
  addEvent('user/message', { role: 'user', content: [{ type: 'text', text: 'u1' }] })
  addEvent('assistant/message', { message: { content: [{ type: 'text', text: 'a1' }] } })
  addEvent('user/message', { role: 'user', content: [{ type: 'text', text: 'u2' }] })
  addEvent('assistant/message', { message: { content: [{ type: 'text', text: 'a2' }] } })
  addEvent('user/message', { role: 'user', content: [{ type: 'text', text: 'u3' }] })
  addEvent('turn/start', { turn: 1 })

  const session = {
    seq: events.length,
    get surface() {
      return { nodes: surfaceNodes.slice() }
    },
    requestHeader: () => ({ config: { provider: 'deepseek-account', model, maxTokens: 256_000 }, tools: [{ name: 'edit' }] }),
    eventAt: (seq) => events[seq],
    append: (type, data) => {
      const event = addEvent(type, data)
      session.seq = events.length
      return event
    },
  }

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
      if (engineImpl !== undefined) return engineImpl({ addEvent, surfaceNodes, measurement, after, start, end })
      const startEvent = addEvent('compaction/start', { compactionId: 'c1', turn: 1 })
      const summary = addEvent('compaction/summary', { compactionId: 'c1' })
      const shadowed = surfaceNodes.slice(surfaceNodes.indexOf(start), surfaceNodes.indexOf(end) + 1)
      const replacement = addEvent(
        'user/message',
        { role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint', compactionId: 'c1' } },
        { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [startEvent.seq, summary.seq, ...shadowed] },
      )
      surfaceNodes.splice(1, end - start + 1, replacement.seq)
      addEvent('compaction/end', { compactionId: 'c1', turn: 1 })
      measurement.totalTokens = after
    },
  })

  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => handlers.set(event, { fn, options }),
    get: (name) => (name === 'agentPresets' ? { serviceFor: (_a, svc) => (svc === 'compaction' ? engine : undefined) } : undefined),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 }) },
    tokenMeter: { measure: () => measurement },
  }
  return { ctx, handlers, events, logs, compacted, session, measurement, surfaceNodes, addEvent, setModel: (m) => { model = m } }
}

const transportError = { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' }
const sendError = (h, failure = transportError) =>
  h.handlers.get('agent/request-error').fn({ agent: { session: h.session }, failure, signal: undefined }, async () => 'next')

/** Establish a trusted sample for the current route through one real refusal. */
async function seedCalibration(h) {
  const result = await sendError(h, REFUSAL)
  assert.deepEqual(result, { kind: 'retry' }, 'seeding must compact once and retry')
  const before = h.compacted.length
  h.measurement.totalTokens = 300_000
  return before
}

await run('heuristic off (default): a transport streak changes nothing', async () => {
  const h = makeHarness()
  apply(h.ctx, {})
  assert.equal(await sendError(h), 'next')
  assert.equal(await sendError(h), 'next')
  assert.equal(h.compacted.length, 0)
  assert.deepEqual(h.logs, [])
})

await run('heuristic on but uncalibrated: repeated TRANSPORT never compacts', async () => {
  const h = makeHarness()
  apply(h.ctx, { treatTransportAsOverflow: true })
  await sendError(h)
  const result = await sendError(h)
  assert.equal(result, 'next')
  assert.equal(h.compacted.length, 0, 'assumedRatio alone must never authorize a chunked compaction')
  assert.match(h.logs.join('\n'), /without a provider calibration for this route/)
})

await run('heuristic on and calibrated: one transport is not enough', async () => {
  const h = makeHarness()
  apply(h.ctx, { treatTransportAsOverflow: true })
  const base = await seedCalibration(h)
  const result = await sendError(h)
  assert.equal(result, 'next')
  assert.equal(h.compacted.length, base)
  assert.match(h.logs.join('\n'), /TRANSPORT 1\/2 on turn 1/)
})

await run('heuristic on and calibrated: two transports over the wall trigger recovery', async () => {
  const h = makeHarness()
  apply(h.ctx, { treatTransportAsOverflow: true })
  const base = await seedCalibration(h)
  h.measurement.totalTokens = 1_150_000
  await sendError(h)
  const result = await sendError(h)
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(h.compacted.length, base + 1)
  assert.notEqual(h.compacted[base].start, 0, 'the recovery chunk must not start at the system node')
})

await run('a streak that fails the wall check is cleared, so a third TRANSPORT alone cannot fire', async () => {
  const h = makeHarness()
  apply(h.ctx, { treatTransportAsOverflow: true })
  const base = await seedCalibration(h)
  // Two transports under the wall: no compaction, streak must reset.
  await sendError(h)
  await sendError(h)
  assert.equal(h.compacted.length, base)
  // A third transport on its own must be counted as 1 again, not 3.
  await sendError(h)
  assert.equal(h.compacted.length, base)
  const tail = h.logs.slice(-3).join('\n')
  assert.match(tail, /TRANSPORT 1\/2 on turn 1/)
})

await run('a completed reply resets the streak', async () => {
  const h = makeHarness()
  apply(h.ctx, { treatTransportAsOverflow: true })
  await seedCalibration(h)
  await sendError(h)
  h.handlers.get('session/event').fn(h.session, { type: 'assistant/message' })
  await sendError(h)
  assert.match(h.logs.join('\n'), /TRANSPORT 1\/2 on turn 1/)
})

await run('a new turn resets the streak', async () => {
  const h = makeHarness()
  apply(h.ctx, { treatTransportAsOverflow: true })
  await seedCalibration(h)
  await sendError(h)
  h.session.append('turn/end', {})
  h.session.append('turn/start', { turn: 2 })
  await sendError(h)
  assert.match(h.logs.join('\n'), /TRANSPORT 1\/2 on turn 2/)
})

await run('transport retries are capped and back off exponentially', async () => {
  const times = []
  const h = makeHarness({
    engineImpl: () => {
      times.push(Date.now())
      throw new Error('DeepSeek Messages transport failed')
    },
  })
  apply(h.ctx, { proactive: true, maxTransportRetries: 3, transportBackoffMs: 10, transportBackoffMaxMs: 100 })
  await h.handlers.get('agent/pre-step').fn({ agent: { session: h.session }, signal: undefined, modelSelection: h.session.requestHeader().config }, async () => ({ kind: 'enter', messages: [] }))
  const text = h.logs.join('\n')
  assert.equal(h.compacted.length, 4, 'three retries plus the failing fourth attempt')
  assert.match(text, /retrying in 10ms/)
  assert.match(text, /retrying in 20ms/)
  assert.match(text, /retrying in 40ms/)
  assert.match(text, /transport retry cap 3 reached/)
  const gaps = times.slice(1).map((t, i) => t - times[i])
  assert.ok(gaps[0] >= 10 && gaps[1] >= 20 && gaps[2] >= 40, `unexpected backoff gaps: ${gaps}`)
})

await run('summary attempt cap defaults to 8', async () => {
  const h = makeHarness({
    engineImpl: () => {
      throw new Error('compaction: session surface changed during summarization')
    },
  })
  apply(h.ctx, { proactive: true })
  await h.handlers.get('agent/pre-step').fn({ agent: { session: h.session }, signal: undefined, modelSelection: h.session.requestHeader().config }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(h.compacted.length, 8)
  assert.match(h.logs.join('\n'), /summary attempt cap 8 reached/)
})

console.log(`\n${checks} transport checks passed`)
