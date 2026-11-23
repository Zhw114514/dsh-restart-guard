/**
 * REAL API tests: the actual @deepseek-ai/dsh-session package is used for
 * Session construction, surface validation and append semantics. The LLM,
 * token meter and compaction engine are fakes.
 *
 * This is NOT a full recovery path: no provider call, no real compactRegion,
 * no real token meter.
 *
 * Run: node scripts/real-api-test.mjs
 *   DSH_SESSION_PATH may point at another installed dsh-session package
 *   (absolute path or file: URL).
 */
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply as applyGuard } from '../lib/index.js'
/** Test seam: behaviour suites inject a proven identity; identity itself is tested in identity-test.mjs. */
const TEST_IDENTITY = async () => ({ version: '0.2.2-rc.1', profile: 'v022' })
const apply = (ctx, config) => applyGuard(ctx, config, { identify: TEST_IDENTITY })
import { asV022 } from './fake-engine.mjs'

const sessionModulePath = process.env.DSH_SESSION_PATH ?? '../real-api/node_modules/@deepseek-ai/dsh-session/lib/index.js'
// Relative specs resolve against this file; absolute paths and file: URLs are
// accepted as-is. pathToFileURL handles the Windows drive letter correctly.
const sessionModuleUrl = sessionModulePath.startsWith('file:')
  ? sessionModulePath
  : pathToFileURL(sessionModulePath.startsWith('.') ? fileURLToPath(new URL(sessionModulePath, import.meta.url)) : sessionModulePath).href
const sessionApi = await import(sessionModuleUrl)
const { Session, SessionId, SESSION_FORMAT_VERSION } = sessionApi
const buildHeader = (id) =>
  typeof sessionApi.buildSessionHeader === 'function'
    ? sessionApi.buildSessionHeader(id, {})
    : { version: SESSION_FORMAT_VERSION, id, createdAt: 1_700_000_000_000, isSeeded: false }

let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label} [real Session append + fake engine/llm/meter]`)
}

const msg = (id, role, text, extra = {}) => ({ id, role, content: [{ type: 'text', text }], ...extra })

function buildSession() {
  const header = buildHeader(SessionId('session-real'))
  const ev = (seq, type, data, extra = {}) => ({ seq, time: 1_700_000_000_000 + seq, type, data, ...extra })
  const seed = [
    ev(0, 'system/message', { message: msg('s1', 'system', 'sys', { source: { kind: 'system-prompt' } }) }, { surfaceOp: 'append' }),
    ev(1, 'user/message', msg('u1', 'user', 'u1', { source: { kind: 'user' } }), { surfaceOp: 'append' }),
    ev(2, 'assistant/message', { turn: 1, step: 1, stream: [], message: msg('a1', 'assistant', 'a1', { source: { kind: 'model', provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' }),
    ev(3, 'user/message', msg('u2', 'user', 'u2', { source: { kind: 'user' } }), { surfaceOp: 'append' }),
    ev(4, 'assistant/message', { turn: 1, step: 2, stream: [], message: msg('a2', 'assistant', 'a2', { source: { kind: 'model', provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' }),
    ev(5, 'turn/start', { turn: 1 }),
  ]
  return new Session(SessionId('session-real'), seed, header)
}

const appendClose = (s, id = 'c1') =>
  s.append(
    'user/message',
    msg(id, 'user', 'summary', { source: { kind: 'compact-checkpoint', compactionId: 'k1' } }),
    { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] },
  )

const eventsOf = (s) => {
  const out = []
  for (let seq = 0; seq < s.seq; seq += 1) out.push(s.eventAt(seq))
  return out
}

/** Turn that owns the current request, read from the log itself. */
const currentTurn = (s) => {
  for (let seq = s.seq - 1; seq >= 0; seq -= 1) {
    const event = s.eventAt(seq)
    if (event?.type === 'turn/start') return event.data?.turn ?? 1
    if (event?.type === 'turn/end') return undefined
  }
  return undefined
}

await run('the real Session rejects a replacement that shadows the system node', async () => {
  const s = buildSession()
  assert.throws(
    () =>
      s.append(
        'user/message',
        msg('c0', 'user', 'summary', { source: { kind: 'compact-checkpoint', compactionId: 'k0' } }),
        { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 }, sourceEventSeqs: [0, 1, 2] },
      ),
    /node 0 holds the system prompt/,
  )
})

await run('the real Session requires sourceEventSeqs to cover every shadowed node', async () => {
  const s = buildSession()
  assert.throws(
    () =>
      s.append(
        'user/message',
        msg('c9', 'user', 'summary', { source: { kind: 'compact-checkpoint', compactionId: 'k9' } }),
        { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [2] },
      ),
    /must include every shadowed surface node/,
  )
})

await run('the real Session accepts the engine-shaped replacement', async () => {
  const s = buildSession()
  appendClose(s)
  assert.equal(s.surface.nodes.length, 4)
})

await run('an interrupted compaction is closed by the guard on a real Session', async () => {
  const s = buildSession()
  s.append('compaction/start', { compactionId: 'k-orphan', turn: 1 })
  const logs = []
  const measurement = { totalTokens: 1_150_000, get nodes() { const n = s.surface.nodes.length; const rest = Math.max(1, Math.round((1_150_000 - 4000) / Math.max(1, n - 1))); return s.surface.nodes.map((seq, i) => ({ seq, tokens: i === 0 ? 4000 : rest })) } }
  const engine = asV022({ config: { maxTokens: 65_536 }, compactRegion: async () => { throw new Error('summary request TRANSPORT failed') } })
  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => { ctx.handlers ??= new Map(); ctx.handlers.set(event, { fn, options }) },
    get: () => ({ serviceFor: (_a, svc) => (svc === 'compaction' ? engine : undefined) }),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 }) },
    tokenMeter: { measure: () => measurement },
  }
  apply(ctx, { proactive: true, maxSummaryAttempts: 1, maxRecoveryAttempts: 1 })
  await ctx.handlers.get('agent/pre-step').fn(
    { agent: { session: s, options: { provider: 'p', model: 'm' } }, signal: undefined, modelSelection: { provider: 'p', model: 'm' } },
    async () => ({ kind: 'enter', messages: [] }),
  )

  const events = eventsOf(s)
  const starts = events.filter((e) => e.type === 'compaction/start')
  const ends = events.filter((e) => e.type === 'compaction/end')
  assert.ok(starts.length >= 1)
  assert.equal(starts.length, ends.length, 'every opening marker must be closed')
  assert.ok(ends.at(-1).data.error, 'the closing end must record the failure')
})

await run('recovery cap closes the transaction and the next turn can still compact', async () => {
  const s = buildSession()
  const logs = []
  let total = 1_150_000
  const measurement = { get totalTokens() { return total }, get nodes() { const n = s.surface.nodes.length; const rest = Math.max(1, Math.round((total - 4000) / Math.max(1, n - 1))); return s.surface.nodes.map((seq, i) => ({ seq, tokens: i === 0 ? 4000 : rest })) } }
  let failMode = true
  const engine = asV022({
    config: { maxTokens: 65_536 },
    compactRegion: async (start, end) => {
      const compactionId = `k-${s.seq}`
      const startEvent = s.append('compaction/start', { compactionId, turn: currentTurn(s) })
      if (failMode) {
        throw new Error('summary request TRANSPORT failed')
      }
      const summary = s.append('compaction/summary', { compactionId })
      const from = s.surface.nodes.indexOf(start)
      const to = s.surface.nodes.indexOf(end)
      const shadowed = s.surface.nodes.slice(from, to + 1)
      s.append(
        'user/message',
        msg(`ck-${s.seq}`, 'user', 'summary', { source: { kind: 'compact-checkpoint', compactionId } }),
        { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [startEvent.seq, summary.seq, ...shadowed] },
      )
      s.append('compaction/end', { compactionId, turn: currentTurn(s) })
      total = 100_000
    },
  })
  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => { ctx.handlers ??= new Map(); ctx.handlers.set(event, { fn, options }) },
    get: () => ({ serviceFor: (_a, svc) => (svc === 'compaction' ? engine : undefined) }),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 }) },
    tokenMeter: { measure: () => measurement },
  }
  apply(ctx, { proactive: true, maxSummaryAttempts: 4, maxRecoveryAttempts: 1 })

  // First turn: summary fails, cap is reached, the transaction must be closed.
  await ctx.handlers.get('agent/pre-step').fn(
    { agent: { session: s, options: { provider: 'p', model: 'm' } }, signal: undefined, modelSelection: { provider: 'p', model: 'm' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  let events = eventsOf(s)
  let starts = events.filter((e) => e.type === 'compaction/start')
  let ends = events.filter((e) => e.type === 'compaction/end')
  assert.equal(starts.length, ends.length, 'cap must not leave an open transaction')
  assert.ok(ends.at(-1).data.error, 'the cap close must record the error')
  const lastEnd = ends.at(-1).seq
  assert.ok(starts.every((e) => e.seq < lastEnd), 'no start may follow the final close')
  // Active-state equivalence: every start has a later end, so no transaction is open.
  assert.ok(starts.every((e) => ends.some((end) => end.seq > e.seq)), 'no unmatched compaction/start remains')

  // Next turn: the same guard must still be able to compact.
  failMode = false
  s.append('turn/end', {})
  s.append('turn/start', { turn: 2 })
  await ctx.handlers.get('agent/pre-step').fn(
    { agent: { session: s, options: { provider: 'p', model: 'm' } }, signal: undefined, modelSelection: { provider: 'p', model: 'm' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  events = eventsOf(s)
  starts = events.filter((e) => e.type === 'compaction/start')
  ends = events.filter((e) => e.type === 'compaction/end')
  assert.equal(starts.length, ends.length, 'the next turn must end with a closed transaction too')
  assert.equal(ends.at(-1).data.error, undefined, 'the next turn commits successfully')
})

await run('a prune claim without its replacement leaves the surface untouched', async () => {
  const s = buildSession()
  const before = s.surface.nodes.length
  s.append('compaction/prune', { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 10 })
  assert.throws(
    () =>
      s.append(
        'tool/result',
        { turn: 1, step: 1, message: msg('t1', 'tool', 'pruned', { source: { kind: 'tool', callId: 'c' } }) },
        { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [3] },
      ),
    /must include every shadowed surface node/,
  )
  assert.equal(s.surface.nodes.length, before, 'a rejected replacement must not change the surface')
  assert.equal(eventsOf(s).filter((e) => e.type === 'compaction/prune').length, 1, 'the claim itself is durable')
})

const makeGuardCtx = (s, { total = 1_150_000, engine }) => {
  const logs = []
  let current = total
  const measurement = { get totalTokens() { return current }, get nodes() { const n = s.surface.nodes.length; const rest = Math.max(1, Math.round((current - 4000) / Math.max(1, n - 1))); return s.surface.nodes.map((seq, i) => ({ seq, tokens: i === 0 ? 4000 : rest })) } }
  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => { ctx.handlers ??= new Map(); ctx.handlers.set(event, { fn, options }) },
    get: () => ({ serviceFor: (_a, svc) => (svc === 'compaction' ? engine : undefined) }),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 }) },
    tokenMeter: { measure: () => measurement },
  }
  return { ctx, logs, setTotal: (v) => { current = v } }
}

await run('a manual compaction is never closed by the guard', async () => {
  const s = buildSession()
  s.append('compaction/start', { compactionId: 'manual-1', turn: 1, sourceCommandId: 'cmd-1' })
  let compacted = 0
  const engine = asV022({ config: { maxTokens: 65_536 }, compactRegion: async () => { compacted += 1 } })
  const h = makeGuardCtx(s, { engine })
  const applyGuardOnly = apply
  applyGuardOnly(h.ctx, { proactive: true })
  await h.ctx.handlers.get('agent/pre-step').fn(
    { agent: { session: s, options: { provider: 'p', model: 'm' } }, signal: undefined, modelSelection: { provider: 'p', model: 'm' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const events = eventsOf(s)
  assert.equal(events.filter((e) => e.type === 'compaction/end').length, 0, 'manual transaction must stay untouched')
  assert.equal(compacted, 0)
  assert.match(h.logs.join('\n'), /not mine to close/)
})

await run('a closed bracket without a replacement is not treated as active', async () => {
  const s = buildSession()
  s.append('compaction/start', { compactionId: 'empty-1', turn: 1 })
  s.append('compaction/end', { compactionId: 'empty-1', turn: 1 })
  let compacted = 0
  const engine = asV022({ config: { maxTokens: 65_536 }, compactRegion: async () => { compacted += 1 } })
  const h = makeGuardCtx(s, { engine })
  apply(h.ctx, { proactive: true })
  await h.ctx.handlers.get('agent/pre-step').fn(
    { agent: { session: s, options: { provider: 'p', model: 'm' } }, signal: undefined, modelSelection: { provider: 'p', model: 'm' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.ok(compacted >= 1, 'a closed, empty bracket must not block planning')
  assert.doesNotMatch(h.logs.join('\n'), /active compaction/)
})

console.log(`\n${checks} real-API checks passed`)
