/**
 * REAL ENGINE routing tests: the actual @deepseek-ai/dsh-compaction-basic
 * classes are constructed, identified through a real attestation, and their own
 * summarize() path is invoked. The LLM is a fake that captures the outbound
 * request; no provider call is made.
 *
 * Run: node scripts/real-engine-test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { identifyEngine } from '../lib/identity.js'
import { resolveSummaryPlan } from '../lib/route.js'

let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label} [REAL engine class + real attestation + fake LLM]`)
}

const moduleUrl = (spec) => new URL(spec, import.meta.url).href

async function loadEngine(spec) {
  const mod = await import(moduleUrl(spec))
  return mod.BasicCompactionEngine ?? mod.default
}

const V022 = await loadEngine('../real-engine/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')
const V023 = await loadEngine('../real-engine-023/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')
const PATH = {
  v022: fileURLToPath(new URL('../real-engine/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js', import.meta.url)),
  v023: fileURLToPath(new URL('../real-engine-023/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js', import.meta.url)),
}

const attestDir = mkdtempSync(join(tmpdir(), 'restart-guard-re-'))
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
let seq = 0
function attestFor(profileKey) {
  const modulePath = PATH[profileKey]
  const packageJsonPath = join(modulePath, '..', '..', 'package.json')
  const runtimeRoot = join(modulePath, '..', '..', '..', '..')
  const version = profileKey === 'v022' ? '0.2.2-rc.1' : '0.2.3-alpha.2'
  const path = join(attestDir, ['a', String(seq++), 'json'].join('.'))
  writeFileSync(path, JSON.stringify({
    schema: 1,
    bootId: 'boot-re',
    createdAt: new Date().toISOString(),
    profile: 'desktop',
    runtimeRoot,
    engine: {
      package: '@deepseek-ai/dsh-compaction-basic',
      version,
      profile: profileKey,
      modulePath,
      packageJsonPath,
      moduleSha256: sha(modulePath),
      packageJsonSha256: sha(packageJsonPath),
    },
  }), 'utf8')
  return path
}
async function identityFor(engine, profileKey) {
  return identifyEngine({ engine, attestationPath: attestFor(profileKey), bootId: 'boot-re', profile: 'desktop' })
}

function makeCtx({ captured, projections } = {}) {
  const noop = () => {}
  return {
    reflect: { provide: noop },
    provide: noop,
    effect: noop,
    on: () => noop,
    get: () => undefined,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    sessionProjections: { register: async () => ({ stateOf: () => projections ?? null }) },
    llm: {
      stream: async function* (options) {
        captured.push(options)
      },
    },
  }
}

function makeAgent({ headerRoute, optionsRoute, answered }) {
  const events = []
  const push = (type, data) => events.push({ seq: events.length, type, data })
  push('system/message', { message: { id: 's', role: 'system', content: [], source: { kind: 'system-prompt' } } })
  if (answered !== undefined) {
    push('assistant/message', { message: { id: 'a', role: 'assistant', content: [], source: { kind: 'model', ...answered } } })
  }
  return {
    options: optionsRoute ?? {},
    session: {
      id: 's',
      seq: events.length,
      eventAt: (seq) => events[seq],
      requestHeader: () => (headerRoute === undefined ? undefined : { config: { ...headerRoute } }),
      toolHistory: () => [],
    },
  }
}

async function capture(EngineClass, config, agent, projections) {
  const captured = []
  const ctx = makeCtx({ captured, projections })
  const engine = new EngineClass(ctx, { auto: false, ...config })
  await engine.summarize({ messages: [], tools: undefined }, agent, undefined).catch(() => {})
  return { engine, request: captured[0] }
}

for (const [label, EngineClass, profileKey] of [
  ['0.2.2-rc.1', V022, 'v022'],
  ['0.2.3-alpha.2', V023, 'v023'],
]) {
  await run(`${label}: header-only routing matches the engine's captured request`, async () => {
    const agent = makeAgent({ headerRoute: { provider: 'ds', model: 'H' }, optionsRoute: { provider: 'ds', model: 'O' } })
    const { engine, request } = await capture(EngineClass, {}, agent)
    const plan = resolveSummaryPlan({ agent, engine, session: agent.session, identity: await identityFor(engine, profileKey) })
    assert.equal(request.provider, plan.route.provider)
    assert.equal(request.model, plan.route.model)
    assert.equal(request.maxTokens, plan.summaryMaxTokens)
    assert.equal(plan.profile, profileKey)
  })

  await run(`${label}: a configured summary target wins and matches the engine`, async () => {
    const agent = makeAgent({ headerRoute: { provider: 'ds', model: 'H' }, optionsRoute: { provider: 'ds', model: 'O' } })
    const { engine, request } = await capture(EngineClass, { summarizationProvider: 'ds', summarizationModel: 'S' }, agent)
    const plan = resolveSummaryPlan({ agent, engine, session: agent.session, identity: await identityFor(engine, profileKey) })
    assert.equal(request.model, 'S')
    assert.equal(plan.route.model, request.model)
    assert.equal(plan.summaryMaxTokens, request.maxTokens)
  })

  await run(`${label}: a per-target policy override matches the engine`, async () => {
    const agent = makeAgent({ headerRoute: { provider: 'ds', model: 'H' }, optionsRoute: { provider: 'ds', model: 'O' } })
    const config = { modelPolicies: [{ provider: 'ds', model: 'H', maxTokens: 200_000, summarizationProvider: 'ds', summarizationModel: 'P' }] }
    const { engine, request } = await capture(EngineClass, config, agent)
    const plan = resolveSummaryPlan({ agent, engine, session: agent.session, identity: await identityFor(engine, profileKey) })
    assert.equal(request.maxTokens, 200_000)
    assert.equal(plan.summaryMaxTokens, request.maxTokens)
    assert.equal(plan.route.model, request.model)
  })

  await run(`${label}: answered-route precedence matches the engine`, async () => {
    const answered = { provider: 'ds', model: 'A' }
    const agent = makeAgent({ headerRoute: { provider: 'ds', model: 'H' }, optionsRoute: { provider: 'ds', model: 'O' }, answered })
    const { engine, request } = await capture(EngineClass, {}, agent, answered)
    const plan = resolveSummaryPlan({ agent, engine, session: agent.session, identity: await identityFor(engine, profileKey) })
    assert.equal(plan.route.model, request.model)
    if (profileKey === 'v022') assert.equal(request.model, 'H', '0.2.2 must ignore the answered route')
    else assert.equal(request.model, 'A', '0.2.3 must prefer the answered route')
  })
}

await run('a pin that contradicts the real engine is refused', async () => {
  const agent = makeAgent({ headerRoute: { provider: 'ds', model: 'H' }, optionsRoute: {} })
  const { engine } = await capture(V023, {}, agent)
  const identity = await identityFor(engine, 'v023')
  const plan = resolveSummaryPlan({ agent, engine, session: agent.session, identity, pinnedMode: 'v022' })
  assert.equal(plan.unknown, true)
  assert.match(plan.reason, /does not match the identified release 0\.2\.3-alpha\.2/)
})

console.log(`\n${checks} real-engine checks passed`)
