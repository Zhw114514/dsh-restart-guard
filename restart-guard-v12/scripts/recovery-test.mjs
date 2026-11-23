/**
 * Recovery-path tests for the candidate guard. No DSH runtime, no model call,
 * no real session file: a fake session records every append so an interrupted
 * compaction can be inspected exactly as the guard would inspect it.
 *
 * Run: node scripts/recovery-test.mjs
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

function makeHarness({ total = 1_150_000, after = 300_000, engineImpl, surfaceMismatch = false } = {}) {
  const events = []
  const logs = []
  const handlers = new Map()
  const compacted = []
  let measurement
  let sessionRef

  const addEvent = (type, data = {}, extra = {}) => {
    const seq = events.length
    const event = { seq, type, data, ...extra }
    events.push(event)
    if (sessionRef !== undefined) sessionRef.seq = events.length
    return event
  }

  addEvent('system/message', { message: { content: [{ type: 'text', text: 'system' }] } })
  addEvent('user/message', { role: 'user', content: [{ type: 'text', text: 'u1' }] })
  addEvent('assistant/message', { message: { content: [{ type: 'text', text: 'a1' }] } })
  addEvent('user/message', { role: 'user', content: [{ type: 'text', text: 'u2' }] })
  addEvent('assistant/message', { message: { content: [{ type: 'text', text: 'a2' }] } })
  addEvent('user/message', { role: 'user', content: [{ type: 'text', text: 'u3' }] })
  addEvent('turn/start', { turn: 1 })

  const surfaceNodes = [0, 1, 2, 3, 4, 5]
  const session = {
    seq: events.length,
    get surface() {
      return { nodes: surfaceNodes.slice() }
    },
    requestHeader: () => ({
      config: { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 256_000 },
      tools: [{ name: 'edit' }],
    }),
    eventAt: (seq) => events[seq],
    append: (type, data) => {
      const event = addEvent(type, data)
      session.seq = events.length
      return event
    },
  }
  sessionRef = session

  const nodes = surfaceMismatch
    ? [{ seq: 999, tokens: 1000 }, { seq: 998, tokens: 5000 }]
    : surfaceNodes.map((seq) => ({ seq, tokens: seq === 0 ? 4000 : 143_000 }))
  measurement = { totalTokens: total, nodes }

  /** Append the realistic replacement pair the engine's commit step emits. */
  const commitChunk = ({ start, end, compactionId, withEnd = true }) => {
    const startEvent = addEvent('compaction/start', { compactionId, turn: 1 })
    const summary = addEvent('compaction/summary', { compactionId })
    const shadowed = surfaceNodes.slice(surfaceNodes.indexOf(start), surfaceNodes.indexOf(end) + 1)
    const replacement = addEvent(
      'user/message',
      { role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint', compactionId } },
      {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        // Real append validates the cited sources: start, summary, and every shadowed node.
        sourceEventSeqs: [startEvent.seq, summary.seq, ...shadowed],
      },
    )
    surfaceNodes.splice(1, end - start + 1, replacement.seq)
    if (withEnd) addEvent('compaction/end', { compactionId, turn: 1 })
    session.seq = events.length
    measurement.nodes = surfaceNodes.map((seq) => ({ seq, tokens: seq === 0 ? 4000 : 20_000 }))
    measurement.totalTokens = after
    return { startEvent, summary, replacement }
  }

  const engine = asV022({
    config: { maxTokens: 65_536 },
    compactRegion: async (start, end) => {
      compacted.push({ start, end })
      if (engineImpl !== undefined) return engineImpl({ session, events, addEvent, commitChunk, start, end, measurement, after, surfaceNodes })
      commitChunk({ start, end, compactionId: `c-${events.length}` })
    },
  })

  const ctx = {
    logger: { info: (text) => logs.push(text), warn: (text) => logs.push(`WARN ${text}`), error: (text) => logs.push(`ERROR ${text}`) },
    on: (event, fn, options) => handlers.set(event, { fn, options }),
    get: (name) => (name === 'agentPresets'
      ? { serviceFor: (_agent, service) => (service === 'compaction' ? engine : undefined) }
      : undefined),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 }) },
    tokenMeter: { measure: () => measurement },
  }
  return { ctx, handlers, events, logs, compacted, session, surfaceNodes, measurement, addEvent, commitChunk }
}

const runGuard = async (h) => {
  const handler = h.handlers.get('agent/pre-step')
  return handler.fn({ agent: { session: h.session }, signal: undefined, modelSelection: h.session.requestHeader().config }, async () => ({ kind: 'enter', messages: [] }))
}

await run('system head is excluded from the planned chunk', async () => {
  const h = makeHarness()
  apply(h.ctx, { proactive: true })
  await runGuard(h)
  assert.ok(h.compacted.length >= 1)
  assert.equal(h.compacted[0].start, 1, 'chunk must not start at the system node')
})

await run('token-meter/surface mismatch aborts before any compaction', async () => {
  const h = makeHarness({ surfaceMismatch: true })
  apply(h.ctx, { proactive: true })
  await runGuard(h)
  assert.equal(h.compacted.length, 0)
  assert.match(h.logs.join('\n'), /token-meter surface does not match/)
})

await run('replacement committed but end missing is completed safely', async () => {
  const h = makeHarness({
    engineImpl: ({ commitChunk, start, end }) => {
      commitChunk({ start, end, compactionId: 'partial-1', withEnd: false })
      throw new Error('compaction/end append failed: simulated durable write failure')
    },
  })
  apply(h.ctx, { proactive: true })
  await runGuard(h)
  const ends = h.events.filter((e) => e.type === 'compaction/end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].data.error, undefined, 'committed body must be closed as success')
  assert.match(h.logs.join('\n'), /bodyCommitted=true/)
  assert.equal(h.events.filter((e) => e.type === 'compaction/start').length, 1)
})

await run('start without body is closed with an error and retried', async () => {
  let calls = 0
  const h = makeHarness({
    engineImpl: ({ addEvent, commitChunk, start, end }) => {
      calls += 1
      if (calls === 1) {
        addEvent('compaction/start', { compactionId: 'orphan-1', turn: 1 })
        throw new Error('summary request TRANSPORT failed')
      }
      commitChunk({ start, end, compactionId: 'success-2' })
    },
  })
  apply(h.ctx, { proactive: true, maxSummaryAttempts: 4 })
  await runGuard(h)
  const ends = h.events.filter((e) => e.type === 'compaction/end')
  assert.equal(ends.length, 2, 'orphan error close + successful second chunk close')
  assert.match(ends[0].data.error, /recovered interrupted compaction/)
  assert.equal(ends[1].data.error, undefined)
  assert.equal(h.events.filter((e) => e.type === 'compaction/start').length, 2)
})

await run('attempt cap fails explicitly, without a fake success', async () => {
  const h = makeHarness({
    engineImpl: () => {
      throw new Error('summary request TRANSPORT failed')
    },
  })
  apply(h.ctx, { proactive: true, maxSummaryAttempts: 2, maxRecoveryAttempts: 2 })
  await runGuard(h)
  assert.equal(h.compacted.length, 2)
  assert.match(h.logs.join('\n'), /FAILED: summary attempt cap 2 reached/)
})

await run('recovery cap fails explicitly and does not loop forever', async () => {
  const h = makeHarness({
    engineImpl: ({ addEvent }) => {
      addEvent('compaction/start', { compactionId: `orphan-${h.events.length}`, turn: 1 })
      throw new Error('summary request TRANSPORT failed')
    },
  })
  apply(h.ctx, { proactive: true, maxSummaryAttempts: 20, maxRecoveryAttempts: 1 })
  await runGuard(h)
  assert.match(h.logs.join('\n'), /FAILED: recovery cap 1 reached/)
  const starts = h.events.filter((e) => e.type === 'compaction/start')
  const ends = h.events.filter((e) => e.type === 'compaction/end')
  assert.equal(starts.length, ends.length, 'the cap must not leave an unmatched start')
  assert.ok(ends.at(-1).data.error, 'the closing end must record the failure')
  assert.ok(starts.every((e) => e.seq < ends.at(-1).seq), 'no start may follow the final close')
})

await run('orphan owned by a previous turn fails closed', async () => {
  const h = makeHarness()
  // Turn 1 leaves an unclosed compaction, then the turn ends and turn 2 opens.
  h.addEvent('compaction/start', { compactionId: 'stale-turn-1', turn: 1 })
  h.addEvent('turn/end', {})
  h.addEvent('turn/start', { turn: 2 })
  apply(h.ctx, { proactive: true })
  await runGuard(h)
  assert.equal(h.compacted.length, 0, 'a previous turn\'s transaction must never be closed by this one')
  assert.match(h.logs.join('\n'), /does not match current turn/)
  assert.match(h.logs.join('\n'), /FAILED/)
})

console.log(`\n${checks} recovery checks passed`)
