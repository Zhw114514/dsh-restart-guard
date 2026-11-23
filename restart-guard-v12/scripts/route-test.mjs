/**
 * Route identity, summary-budget and reserve tests for candidate v7.
 * FAKE Session, FAKE engine shapes (capability markers mirrored), FAKE LLM.
 *
 * Run: node scripts/route-test.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyGuard } from '../lib/index.js'
/** Identity is injected here; identity proof itself is covered by identity-test.mjs. */
const apply = (ctx, config) => applyGuard(ctx, config, { identify: async () => ctx.__identity })
import { asV022, asV023, asFacade, asSubclass, asUnknown } from './fake-engine.mjs'

let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label} [fake session/engine/llm]`)
}

const seqs = [0, 1, 2, 3, 4, 5]

function makeSession({ headerModel = 'B', headerProvider = 'ds', answeredModel, adapterDefaultMax, headerMax = 65_536 } = {}) {
  const events = seqs.map((seq) => {
    if (seq === 2 && answeredModel !== undefined) {
      return { seq, type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'a' }], source: { kind: 'model', provider: headerProvider, model: answeredModel } } } }
    }
    return { seq, type: seq === 0 ? 'system/message' : 'user/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } }
  })
  const surfaceNodes = seqs.slice()
  return {
    seq: events.length,
    get surface() {
      return { nodes: surfaceNodes.slice() }
    },
    requestHeader: () => ({
      config: { provider: headerProvider, model: headerModel, maxTokens: headerMax },
      ...(adapterDefaultMax === undefined ? {} : { adapterDefaults: { maxTokens: adapterDefaultMax } }),
      tools: [{ name: 'edit' }],
    }),
    eventAt: (seq) => events[seq],
    append: (type, data) => {
      const event = { seq: events.length, type, data }
      events.push(event)
      return event
    },
    events,
  }
}

function makeCtx({ total = 500_000, after = 100_000, engineKind = 'v022', modelPolicies = [], summarization, configMax = 65_536, defaultMaxTokens = 256_000, wrap } = {}) {
  const logs = []
  const handlers = new Map()
  const compacted = []
  const pruned = { count: 0 }
  const session = makeSession({ answeredModel: 'A' })
  const measurement = {
    totalTokens: total,
    get nodes() {
      const n = session.surface.nodes.length
      return session.surface.nodes.map((seq, i) => ({ seq, tokens: i === 0 ? 4000 : Math.round((total - 4000) / Math.max(1, n - 1)) }))
    },
  }
  const engineConfig = { maxTokens: configMax, modelPolicies }
  if (summarization !== undefined) {
    engineConfig.summarizationProvider = summarization.provider
    engineConfig.summarizationModel = summarization.model
  }
  let engine = {
    config: engineConfig,
    compactRegion: async (start, end) => {
      compacted.push({ start, end })
      measurement.totalTokens = after
    },
  }
  engine = engineKind === 'v023' ? asV023(engine) : engineKind === 'unknown' ? asUnknown(engine) : asV022(engine)
  if (wrap !== undefined) engine = wrap(engine)
  const ctx = {
    logger: { info: (t) => logs.push(t), warn: (t) => logs.push(`WARN ${t}`), error: (t) => logs.push(`ERROR ${t}`) },
    on: (event, fn, options) => handlers.set(event, { fn, options }),
    get: (name) => (name === 'agentPresets' ? { serviceFor: (_a, svc) => (svc === 'compaction' ? engine : svc === 'toolResultPruner' ? { pruneSession: () => { pruned.count += 1 } } : undefined) } : undefined),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_048_576 }, ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }) }) },
    tokenMeter: { measure: () => measurement },
  }
  ctx.__identity =
    engineKind === 'v023'
      ? { version: '0.2.3-alpha.2', profile: 'v023' }
      : engineKind === 'unknown'
        ? { unknown: true, reason: 'no attestation' }
        : { version: '0.2.2-rc.1', profile: 'v022' }
  return { ctx, handlers, logs, compacted, pruned, measurement, session }
}

const preStep = (h, selection, session = h.session) =>
  h.handlers.get('agent/pre-step').fn(
    { agent: { session }, signal: undefined, modelSelection: selection },
    async () => ({ kind: 'enter', messages: [] }),
  )

const deferOnly = (h) => {
  assert.equal(h.pruned.count, 0, 'no prune before the safety decision')
  assert.equal(h.compacted.length, 0, 'no compaction before the safety decision')
}

// --- H: the two shipped engines differ --------------------------------------

await run('H/0.2.2: answered=A, header=B, proposed=A -> summary is B -> defer', async () => {
  const h = makeCtx({ engineKind: 'v022' })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'A' })
  deferOnly(h)
  assert.match(h.logs.join('\n'), /route mismatch: request route=ds\/A summary route=ds\/B \(engine=0\.2\.2-rc\.1\/v022,/)
})

await run('H/0.2.2: answered=A, header=B, proposed=B -> summary is B -> proceeds', async () => {
  const h = makeCtx({ engineKind: 'v022' })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  assert.ok(h.compacted.length >= 1)
})

await run('H/0.2.3: answered=A, header=B, proposed=A -> summary is A -> proceeds', async () => {
  const h = makeCtx({ engineKind: 'v023' })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'A' })
  assert.ok(h.compacted.length >= 1)
})

await run('H/0.2.3: answered=A, header=B, proposed=B -> summary is A -> defer', async () => {
  const h = makeCtx({ engineKind: 'v023' })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  deferOnly(h)
  assert.match(h.logs.join('\n'), /route mismatch: request route=ds\/B summary route=ds\/A \(engine=0\.2\.3-alpha\.2\/v023,/)
})

// --- P1-1: identity must be proven -----------------------------------------

await run('a config-bearing object with no capability markers defers', async () => {
  const h = makeCtx({ engineKind: 'unknown' })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  deferOnly(h)
  assert.match(h.logs.join('\n'), /cannot prove the engine identity\/routing/)
})

await run('a pin that disagrees with the loaded engine defers instead of overriding', async () => {
  const h = makeCtx({ engineKind: 'v023' })
  apply(h.ctx, { proactive: true, engineRouteMode: 'v022' })
  await preStep(h, { provider: 'ds', model: 'B' })
  deferOnly(h)
  assert.match(h.logs.join('\n'), /engineRouteMode=v022 does not match the identified release 0\.2\.3-alpha\.2/)
})

await run('a pin that agrees with the loaded engine is accepted', async () => {
  const h = makeCtx({ engineKind: 'v023' })
  apply(h.ctx, { proactive: true, engineRouteMode: 'v023' })
  await preStep(h, { provider: 'ds', model: 'A' })
  assert.ok(h.compacted.length >= 1)
})

// --- P2-1: summary budget follows the resolved policy -----------------------

await run('the summary budget uses the per-target maxTokens override', async () => {
  const base = makeCtx({ engineKind: 'v022' })
  apply(base.ctx, { proactive: true })
  await preStep(base, { provider: 'ds', model: 'B' })
  const baseBudget = /budget (\d+)/.exec(base.logs.join('\n'))?.[1]

  const overridden = makeCtx({
    engineKind: 'v022',
    modelPolicies: [{ provider: 'ds', model: 'B', maxTokens: 200_000 }],
  })
  apply(overridden.ctx, { proactive: true })
  await preStep(overridden, { provider: 'ds', model: 'B' })
  const overriddenBudget = /budget (\d+)/.exec(overridden.logs.join('\n'))?.[1]

  assert.ok(baseBudget !== undefined && overriddenBudget !== undefined, 'both runs must log a budget')
  assert.ok(Number(overriddenBudget) < Number(baseBudget), `override 200k must yield a smaller budget (${overriddenBudget} < ${baseBudget})`)
})

await run('a missing summary maxTokens defers instead of inventing one', async () => {
  const h = makeCtx({ engineKind: 'v022', configMax: null })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  deferOnly(h)
  assert.match(h.logs.join('\n'), /summary maxTokens is not a positive integer/)
})

// --- P1-2: adapter-default reserve ------------------------------------------

await run('J: adapterDefaults.maxTokens=true with a valid default compacts', async () => {
  const h = makeCtx({ engineKind: 'v022', total: 420_000, defaultMaxTokens: 256_000 })
  h.session.requestHeader = () => ({ config: { provider: 'ds', model: 'B', maxTokens: 65_536 }, adapterDefaults: { maxTokens: true }, tools: [{ name: 'edit' }] })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  assert.ok(h.compacted.length >= 1)
  assert.match(h.logs.join('\n'), /wall=379904/)
})

for (const bad of [null, 0, -1, 1.5, '256000']) {
  await run(`J: adapterDefaults.maxTokens=true with defaultMaxTokens=${String(bad)} defers`, async () => {
    const h = makeCtx({ engineKind: 'v022', total: 420_000, defaultMaxTokens: bad })
    h.session.requestHeader = () => ({ config: { provider: 'ds', model: 'B', maxTokens: 65_536 }, adapterDefaults: { maxTokens: true }, tools: [{ name: 'edit' }] })
    apply(h.ctx, { proactive: true })
    await preStep(h, { provider: 'ds', model: 'B' })
    deferOnly(h)
    assert.match(h.logs.join('\n'), /adapter-default maxTokens is unavailable/)
  })
}

await run('J: adapterDefaults=false keeps an explicit maxTokens', async () => {
  const h = makeCtx({ engineKind: 'v022', total: 420_000 })
  h.session.requestHeader = () => ({ config: { provider: 'ds', model: 'B', maxTokens: 65_536 }, adapterDefaults: { maxTokens: false }, tools: [{ name: 'edit' }] })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  assert.equal(h.compacted.length, 0)
})

await run('J: a missing adapterDefaults keeps an explicit maxTokens', async () => {
  const h = makeCtx({ engineKind: 'v022', total: 420_000 })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  assert.equal(h.compacted.length, 0)
})

// --- P1-2: every invalid reserve defers -------------------------------------

for (const bad of [0, -1, 1.5, '65536']) {
  await run(`an explicit maxTokens of ${String(bad)} defers`, async () => {
    const h = makeCtx({ engineKind: 'v022', total: 420_000 })
    h.session.requestHeader = () => ({ config: { provider: 'ds', model: 'B', maxTokens: bad }, tools: [{ name: 'edit' }] })
    apply(h.ctx, { proactive: true })
    await preStep(h, { provider: 'ds', model: 'B' })
    deferOnly(h)
    assert.match(h.logs.join('\n'), /explicit maxTokens .* is not a positive integer/)
  })
}

await run('no explicit maxTokens and no route default defers', async () => {
  const h = makeCtx({ engineKind: 'v022', total: 420_000, defaultMaxTokens: null })
  h.session.requestHeader = () => ({ config: { provider: 'ds', model: 'B' }, tools: [{ name: 'edit' }] })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  deferOnly(h)
  assert.match(h.logs.join('\n'), /no trustworthy output reservation/)
})

await run('an absent explicit maxTokens falls back to the route default', async () => {
  const h = makeCtx({ engineKind: 'v022', total: 420_000, defaultMaxTokens: 256_000 })
  h.session.requestHeader = () => ({ config: { provider: 'ds', model: 'B' }, tools: [{ name: 'edit' }] })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'B' })
  assert.ok(h.compacted.length >= 1)
  assert.match(h.logs.join('\n'), /wall=379904/)
})

// --- P1-3: a stale header must not supply reserve ---------------------------

await run('P1-3: v023 stale header explicit 1000 is ignored in favour of the proposed default', async () => {
  const h = makeCtx({ engineKind: 'v023', total: 560_000, defaultMaxTokens: 65_536 })
  h.session = makeSession({ headerModel: 'B', answeredModel: 'A', headerMax: 1000 })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'A' })
  assert.ok(h.compacted.length >= 1)
  assert.match(h.logs.join('\n'), /wall=475136/, 'must size with the proposed default, not the stale 1000')
  assert.doesNotMatch(h.logs.join('\n'), /wall=507404/)
})

await run('P1-3: stale header with no usable proposed default defers', async () => {
  const h = makeCtx({ engineKind: 'v023', total: 560_000, defaultMaxTokens: null })
  h.session = makeSession({ headerModel: 'B', answeredModel: 'A', headerMax: 1000 })
  apply(h.ctx, { proactive: true })
  await preStep(h, { provider: 'ds', model: 'A' })
  deferOnly(h)
  assert.match(h.logs.join('\n'), /stale header for ds\/A/)
})

console.log(`\n${checks} route/reserve checks passed`)
