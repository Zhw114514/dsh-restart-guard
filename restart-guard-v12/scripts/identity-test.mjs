/**
 * Identity binding tests: real engine classes, real module files, real hashes.
 * Version identity is re-derived from the module hash, so a lying attestation
 * must be refused. The per-use integrity check must see later tampering.
 *
 * Run: node scripts/identity-test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { identifyEngine } from '../lib/identity.js'

let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label} [real module files + real engine classes]`)
}

const loadClass = async (spec) => {
  const mod = await import(new URL(spec, import.meta.url).href)
  return mod.BasicCompactionEngine ?? mod.default
}

const ROOT = {
  v022: fileURLToPath(new URL('../real-engine', import.meta.url)),
  v023: fileURLToPath(new URL('../real-engine-023', import.meta.url)),
}
const MOD = {
  v022: join(ROOT.v022, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js'),
  v023: join(ROOT.v023, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js'),
}
const PKG = {
  v022: join(ROOT.v022, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'package.json'),
  v023: join(ROOT.v023, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'package.json'),
}
const C = {
  v022: await loadClass('../real-engine/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'),
  v023: await loadClass('../real-engine-023/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'),
}

const makeCtx = () => {
  const noop = () => {}
  return {
    reflect: { provide: noop },
    provide: noop,
    effect: noop,
    on: () => noop,
    get: () => undefined,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    sessionProjections: { register: async () => ({ stateOf: () => null }) },
    llm: { stream: async function* () {} },
  }
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const dir = mkdtempSync(join(tmpdir(), 'restart-guard-attest-'))
let seq = 0

function attestation(profileKey, overrides = {}) {
  const path = join(dir, `att-${seq++}.json`)
  const record = {
    schema: 1,
    bootId: overrides.bootId ?? 'boot-1',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    profile: overrides.profile ?? 'desktop',
    runtimeRoot: overrides.runtimeRoot ?? ROOT[profileKey],
    engine: {
      package: '@deepseek-ai/dsh-compaction-basic',
      version: overrides.version ?? (profileKey === 'v022' ? '0.2.2-rc.1' : '0.2.3-alpha.2'),
      profile: overrides.profileKey ?? profileKey,
      modulePath: overrides.modulePath ?? MOD[profileKey],
      packageJsonPath: overrides.packageJsonPath ?? PKG[profileKey],
      moduleSha256: overrides.moduleSha256 ?? sha(MOD[profileKey]),
      packageJsonSha256: overrides.packageJsonSha256 ?? sha(PKG[profileKey]),
    },
  }
  writeFileSync(path, JSON.stringify(record), 'utf8')
  return path
}

const base = { bootId: 'boot-1', profile: 'desktop', maxAgeMs: 86_400_000 }

await run('the real 0.2.2 instance binds to its pinned release', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.version, '0.2.2-rc.1')
  assert.equal(identity.profile, 'v022')
})

await run('the real 0.2.3 instance binds to its pinned release', async () => {
  const engine = new C.v023(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v023'), ...base })
  assert.equal(identity.version, '0.2.3-alpha.2')
  assert.equal(identity.profile, 'v023')
})

await run('a lying version in the attestation is refused (module hash wins)', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022', { version: '0.2.3-alpha.2', profileKey: 'v023' }), ...base })
  assert.equal(identity.unknown, true)
  assert.match(identity.reason, /contradicts the module hash/)
})

await run('an attestation hash that is not the module hash is refused', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022', { moduleSha256: 'f'.repeat(64) }), ...base })
  assert.equal(identity.unknown, true)
})

await run('a modulePath outside the runtimeRoot is refused', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const outside = join(dir, 'outside', 'index.js')
  mkdirSync(join(dir, 'outside'), { recursive: true })
  writeFileSync(outside, readFileSync(MOD.v022))
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022', { modulePath: outside }), ...base })
  assert.equal(identity.unknown, true)
  assert.match(identity.reason, /outside the attested runtimeRoot/)
})

await run('a boot-id mismatch defers', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022', { bootId: 'other' }), ...base })
  assert.equal(identity.unknown, true)
  assert.match(identity.reason, /does not match this boot/)
})

await run('an expired attestation defers', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022', { createdAt: old }), ...base })
  assert.equal(identity.unknown, true)
  assert.match(identity.reason, /age/)
})

await run('an empty profile is refused', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base, profile: '' })
  assert.equal(identity.unknown, true)
  assert.match(identity.reason, /no profile/)
})

await run('a plain object stamped with a real constructor defers', async () => {
  const stamped = { constructor: C.v022, compactRegion: async () => {}, config: {} }
  const identity = await identifyEngine({ engine: stamped, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.unknown, true)
})

await run('an instance with an own-property method override defers', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  engine.compactRegion = async () => {}
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.unknown, true)
  assert.match(identity.reason, /own-property override/)
})

// --- P2-3: later tampering must be caught before use ------------------------

await run('replacing an own method after identification fails the pre-use check', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.assertIntegrity().ok, true)
  engine.summarize = async () => {}
  const after = identity.assertIntegrity()
  assert.equal(after.ok, false)
  assert.match(after.reason, /own-property override/)
})

await run('replacing a prototype method after identification fails the pre-use check', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  const original = C.v022.prototype.compactRegion
  try {
    C.v022.prototype.compactRegion = async () => {}
    const after = identity.assertIntegrity()
    assert.equal(after.ok, false)
    assert.match(after.reason, /prototype compactRegion was replaced/)
  } finally {
    C.v022.prototype.compactRegion = original
  }
})

await run('an expired attestation fails the pre-use check', async () => {
  const engine = new C.v022(makeCtx(), { auto: false })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base, maxAgeMs: 50 })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const after = identity.assertIntegrity()
  assert.equal(after.ok, false)
  assert.match(after.reason, /expired/)
})

await run('a cordis-shaped callable service is accepted', async () => {
  const target = function cordisService() {}
  Object.setPrototypeOf(target, C.v022.prototype)
  const nativeCtor = (function nativeLike() {}).bind(null)
  const service = new Proxy(target, {
    get(obj, key, receiver) {
      if (key === 'constructor') return nativeCtor
      return Reflect.get(obj, key, receiver)
    },
  })
  const identity = await identifyEngine({ engine: service, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.version, '0.2.2-rc.1')
  assert.equal(identity.assertIntegrity().ok, true)
})

await run('a callable with the wrong prototype is refused', async () => {
  const target = function strayService() {}
  Object.setPrototypeOf(target, Object.prototype)
  const identity = await identifyEngine({ engine: target, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.unknown, true)
})
// --- C: cordis traceable proxy ---------------------------------------------

const ORIGINAL = Symbol.for('cordis.original')
const nativeCtor = (function nativeLike() {}).bind(null)

function traceable(instance, override = {}) {
  return new Proxy(instance, {
    get(target, key, receiver) {
      if (key === ORIGINAL) return override.original ?? target
      if (key === 'constructor') return override.constructor ?? nativeCtor
      return Reflect.get(target, key, receiver)
    },
  })
}

await run('a cordis traceable proxy is accepted', async () => {
  const instance = new C.v022(makeCtx(), { auto: false })
  const engine = traceable(instance)
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.version, '0.2.2-rc.1')
  assert.equal(identity.assertIntegrity().ok, true)
})

await run('a proxy without cordis.original is refused', async () => {
  const instance = new C.v022(makeCtx(), { auto: false })
  const engine = new Proxy(instance, {
    get(target, key, receiver) {
      if (key === 'constructor') return nativeCtor
      return Reflect.get(target, key, receiver)
    },
  })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.unknown, true)
})

await run('a proxy whose original is another class is refused', async () => {
  const other = new C.v023(makeCtx(), { auto: false })
  const engine = traceable(new C.v022(makeCtx(), { auto: false }), { original: other })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.unknown, true)
})

await run('a proxy whose original carries an own method override is refused', async () => {
  const instance = new C.v022(makeCtx(), { auto: false })
  instance.compactRegion = async () => {}
  const engine = traceable(instance)
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.unknown, true)
  assert.match(identity.reason, /own-property override/)
})

await run('swapping the traceable original after identification fails the pre-use check', async () => {
  const instance = new C.v022(makeCtx(), { auto: false })
  let current = instance
  const engine = new Proxy(instance, {
    get(target, key, receiver) {
      if (key === ORIGINAL) return current
      if (key === 'constructor') return nativeCtor
      return Reflect.get(target, key, receiver)
    },
  })
  const identity = await identifyEngine({ engine, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.assertIntegrity().ok, true)
  current = new C.v022(makeCtx(), { auto: false })
  const after = identity.assertIntegrity()
  assert.equal(after.ok, false)
  assert.match(after.reason, /traceable original changed/)
})
// Documented residual limits.
await run('residual: Object.create(prototype) passes (documented limit)', async () => {
  const hand = Object.create(C.v022.prototype)
  hand.config = { maxTokens: 65_536 }
  const identity = await identifyEngine({ engine: hand, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.version, '0.2.2-rc.1')
})

await run('residual: a transparent instance Proxy passes (documented limit)', async () => {
  const real = new C.v022(makeCtx(), { auto: false })
  const proxied = new Proxy(real, {})
  const identity = await identifyEngine({ engine: proxied, attestationPath: attestation('v022'), ...base })
  assert.equal(identity.version, '0.2.2-rc.1')
})

console.log(`\n${checks} identity checks passed`)
