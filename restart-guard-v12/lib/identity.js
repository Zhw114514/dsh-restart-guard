/**
 * Runtime identity binding.
 *
 * Identity is re-derived from the module bytes against the pinned release
 * table; the attestation's own version string is only cross-checked. The live
 * instance is then bound to the imported class by object identity, and a
 * snapshot of the three key method functions is kept so later tampering is
 * visible.
 *
 * Threat model: deployment drift, a wrong or duplicate dependency, a forged
 * package.json, an object that merely carries a real constructor, and
 * accidental instance or prototype monkey patching. It is NOT a sandbox
 * against arbitrary in-process code. A transparent Proxy, or
 * `Object.create(Prototype)` (which never runs the constructor, so instance
 * and private state may be uninitialised and behaviour is not guaranteed
 * equivalent), cannot be told apart and are recorded limits.
 *
 * @module dsh-restart-guard/identity
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { hashFile, isInside, resolveRelease, validateAttestation } from './attestation.js'

/** Methods a genuine engine must expose through its prototype, untouched. */
export const KEY_METHODS = Object.freeze(['compactRegion', 'summarize', 'compactNow'])

/** Cache the snapshot per instance; every use still re-checks it. */
const cache = new WeakMap()

const hashText = (text) => createHash('sha256').update(text).digest('hex')

const safeSource = (fn) => {
  try {
    return Function.prototype.toString.call(fn)
  } catch {
    return undefined
  }
}

/**
 * Read-only description of an identity mismatch. It only inspects the objects
 * it is given: no property writes, no method calls on the engine, and no full
 * source text in the output.
 */
function describeMismatch(engine, exported, moduleUrl) {
  const detail = {}
  try {
    detail.sameConstructor = engine.constructor === exported
  } catch (error) {
    detail.sameConstructor = `threw: ${error?.message ?? String(error)}`
  }
  try {
    const own = Object.getOwnPropertyDescriptor(engine, 'constructor')
    detail.ownConstructor =
      own === undefined
        ? 'none'
        : { kind: typeof own.value, writable: own.writable, enumerable: own.enumerable, configurable: own.configurable }
  } catch (error) {
    detail.ownConstructor = `threw: ${error?.message ?? String(error)}`
  }
  try {
    const chain = []
    let proto = Object.getPrototypeOf(engine)
    for (let layer = 0; layer < 5 && proto !== null; layer += 1) {
      const ctor = proto.constructor
      chain.push({
        layer,
        name: typeof ctor === 'function' ? ctor.name : String(ctor),
        isPinnedClass: ctor === exported,
        isPinnedPrototype: proto === exported.prototype,
      })
      proto = Object.getPrototypeOf(proto)
    }
    detail.chain = chain
  } catch (error) {
    detail.chain = `threw: ${error?.message ?? String(error)}`
  }
  try {
    detail.isPrototypeOf = exported.prototype.isPrototypeOf(engine)
  } catch (error) {
    detail.isPrototypeOf = `threw: ${error?.message ?? String(error)}`
  }
  try {
    const hostSource = safeSource(engine.constructor)
    const pinnedSource = safeSource(exported)
    detail.host = {
      name: engine.constructor?.name ?? null,
      sourceLength: hostSource?.length ?? null,
      sourceSha256: hostSource === undefined ? null : hashText(hostSource),
      startsWithClass: hostSource === undefined ? null : hostSource.startsWith('class '),
    }
    detail.pinned = {
      name: exported.name,
      sourceLength: pinnedSource?.length ?? null,
      sourceSha256: pinnedSource === undefined ? null : hashText(pinnedSource),
    }
    // A function object does not expose the module it was loaded from.
    detail.host.origin = 'unavailable: function objects do not carry their module URL'
  } catch (error) {
    detail.source = `threw: ${error?.message ?? String(error)}`
  }
  detail.moduleUrl = moduleUrl
  // Read-only probe of cordis's traceable wrapper. `get` returns the raw target
  // for Symbol.for('cordis.original'); no property is written and no engine
  // method is called.
  try {
    const originalKey = Symbol.for('cordis.original')
    const first = engine[originalKey]
    const second = engine[originalKey]
    const usable = first !== undefined && first !== null
    detail.cordis = {
      hasOriginal: usable,
      originalIsSelf: first === engine,
      stableAcrossReads: first === second,
      originalType: usable ? typeof first : null,
      originalCtorIsPinned: usable ? first.constructor === exported : null,
      originalProtoIsPinned: usable ? Object.getPrototypeOf(first) === exported.prototype : null,
      originalOwnConstructor:
        usable ? (Object.getOwnPropertyDescriptor(first, 'constructor') === undefined ? 'none' : 'present') : null,
      methods: KEY_METHODS.map((name) => ({
        name,
        proxyCallable: typeof engine[name] === 'function',
        originalSame: usable ? first[name] === exported.prototype[name] : null,
        originalOwn: usable ? Object.prototype.hasOwnProperty.call(first, name) : null,
      })),
    }
  } catch (error) {
    detail.cordis = `threw: ${error?.message ?? String(error)}`
  }
  return detail
}

/**
 * Prove the engine instance belongs to a pinned release.
 * @returns `{version, profile, modulePath, bootId, assertIntegrity()}` or
 *   `{unknown:true, reason}`
 */
export async function identifyEngine({ engine, attestationPath, bootId, profile, maxAgeMs, now } = {}) {
  if (engine === undefined || engine === null) return { unknown: true, reason: 'no engine instance' }
  const cached = cache.get(engine)
  if (cached !== undefined) return cached

  const checked = validateAttestation({ path: attestationPath, bootId, profile, maxAgeMs, now })
  if (checked.ok !== true) return { unknown: true, reason: checked.reason }
  const { attestation } = checked

  // Re-derive the release from the bytes: the attestation's version is not
  // authoritative and a forged package.json cannot change this.
  let moduleHash
  try {
    moduleHash = hashFile(attestation.engine.modulePath)
  } catch (error) {
    return { unknown: true, reason: `attested module unreadable: ${error?.message ?? String(error)}` }
  }
  const release = resolveRelease(moduleHash)
  if (release === undefined) {
    return { unknown: true, reason: `module hash ${moduleHash.slice(0, 16)}鈥?is not a pinned release` }
  }
  if (attestation.engine.moduleSha256 !== moduleHash) {
    return { unknown: true, reason: 'attested module hash changed since the preflight' }
  }
  if (attestation.engine.version !== release.version || attestation.engine.profile !== release.profile) {
    return { unknown: true, reason: 'attestation version/profile contradicts the module hash' }
  }

  // package.json is a cross-check on the same bytes.
  const packagePath = attestation.engine.packageJsonPath
  if (typeof packagePath !== 'string' || !isInside(attestation.runtimeRoot, packagePath)) {
    return { unknown: true, reason: 'attested package.json path is outside the runtimeRoot' }
  }
  let packageHash
  try {
    packageHash = hashFile(packagePath)
  } catch (error) {
    return { unknown: true, reason: `attested package.json unreadable: ${error?.message ?? String(error)}` }
  }
  if (packageHash !== release.packageJsonSha256) {
    return { unknown: true, reason: 'package.json does not match the pinned release' }
  }
  if (attestation.engine.package !== '@deepseek-ai/dsh-compaction-basic') {
    return { unknown: true, reason: `unexpected package ${String(attestation.engine.package)}` }
  }

  let exported
  try {
    const namespace = await import(pathToFileURL(attestation.engine.modulePath).href)
    exported = namespace.BasicCompactionEngine ?? namespace.default
  } catch (error) {
    return { unknown: true, reason: `attested module failed to load: ${error?.message ?? String(error)}` }
  }
  if (typeof exported !== 'function') return { unknown: true, reason: 'attested module exports no engine class' }

  // Three instance shapes are accepted, all pinned to the same class:
  //   A. a cordis callable service: a function object whose prototype is the
  //      pinned class prototype;
  //   B. a plain instance: constructor identity is the class itself;
  //   C. a cordis traceable proxy: its `cordis.original` target is a plain
  //      instance of the pinned class, and the proxy's prototype is pinned too.
  // Anything else is refused; no shape is inferred from typeof alone.
  const enginePrototype = Object.getPrototypeOf(engine)
  const callableService = typeof engine === 'function'
  const classInstance = engine.constructor === exported
  const originalKey = Symbol.for('cordis.original')
  let traceableOriginal
  try {
    traceableOriginal = engine[originalKey]
  } catch {
    traceableOriginal = undefined
  }
  const traceableService =
    traceableOriginal !== undefined &&
    traceableOriginal !== engine &&
    typeof traceableOriginal === 'object' &&
    traceableOriginal.constructor === exported &&
    Object.getPrototypeOf(traceableOriginal) === exported.prototype
  const shape = callableService
    ? 'cordis-callable'
    : classInstance
      ? 'class-instance'
      : traceableService
        ? 'cordis-traceable'
        : undefined
  const prototypeBound =
    enginePrototype === exported.prototype && exported.prototype.isPrototypeOf(engine) === true
  if (shape === undefined || prototypeBound !== true) {
    const detail = describeMismatch(engine, exported, pathToFileURL(attestation.engine.modulePath).href)
    detail.shape = shape ?? 'unrecognised'
    return { unknown: true, reason: `engine instance does not match a pinned shape; diagnostic=${JSON.stringify(detail)}` }
  }
  if (exported.prototype.constructor !== exported) {
    return { unknown: true, reason: 'pinned class prototype has a replaced constructor' }
  }

  const methodHost = shape === 'cordis-traceable' ? traceableOriginal : engine
  const methods = Object.create(null)
  for (const name of KEY_METHODS) {
    if (Object.prototype.hasOwnProperty.call(methodHost, name)) {
      return { unknown: true, reason: `engine carries an own-property override for ${name}` }
    }
    const fn = exported.prototype[name]
    if (typeof fn !== 'function') return { unknown: true, reason: `${name} is not callable on the pinned prototype` }
    if (methodHost[name] !== fn) return { unknown: true, reason: `engine.${name} is not the pinned prototype function` }
    if (shape === 'cordis-traceable' && typeof engine[name] !== 'function') {
      return { unknown: true, reason: `traceable proxy no longer exposes ${name} as callable` }
    }
    methods[name] = fn
  }

  const snapshot = {
    version: release.version,
    profile: release.profile,
    modulePath: attestation.engine.modulePath,
    bootId: attestation.bootId,
    classRef: exported,
    prototype: exported.prototype,
    callable: callableService,
    traceable: shape === 'cordis-traceable' ? traceableOriginal : undefined,
    methods,
    createdAt: Date.parse(attestation.createdAt),
    maxAgeMs: maxAgeMs ?? 86_400_000,
  }

  /**
   * Cheap re-check run before every prune and every compaction. It compares
   * against the functions captured at verification time, so replacing a
   * prototype method is caught even though both sides would otherwise read the
   * replaced function.
   */
  const assertIntegrity = () => {
    if (Date.now() - snapshot.createdAt > snapshot.maxAgeMs) {
      return { ok: false, reason: 'attestation expired after identification' }
    }
    if (snapshot.traceable !== undefined) {
      let current
      try {
        current = engine[Symbol.for('cordis.original')]
      } catch {
        current = undefined
      }
      if (current !== snapshot.traceable) return { ok: false, reason: 'traceable original changed' }
      if (current.constructor !== snapshot.classRef) return { ok: false, reason: 'traceable original constructor changed' }
      if (Object.getPrototypeOf(current) !== snapshot.prototype) {
        return { ok: false, reason: 'traceable original prototype changed' }
      }
      for (const name of KEY_METHODS) {
        if (Object.prototype.hasOwnProperty.call(current, name)) {
          return { ok: false, reason: `traceable original gained an own-property override for ${name}` }
        }
        if (current[name] !== snapshot.methods[name]) {
          return { ok: false, reason: `traceable original ${name} was replaced` }
        }
        if (typeof engine[name] !== 'function') {
          return { ok: false, reason: `traceable proxy no longer exposes ${name} as callable` }
        }
      }
    } else if (snapshot.callable) {
      if (typeof engine !== 'function') return { ok: false, reason: 'engine stopped being a callable service' }
    } else if (engine.constructor !== snapshot.classRef) {
      return { ok: false, reason: 'engine constructor changed' }
    }
    if (Object.getPrototypeOf(engine) !== snapshot.prototype) return { ok: false, reason: 'engine prototype changed' }
    if (snapshot.prototype.isPrototypeOf(engine) !== true) return { ok: false, reason: 'engine left the pinned prototype chain' }
    if (snapshot.classRef.prototype !== snapshot.prototype) return { ok: false, reason: 'class prototype was replaced' }
    for (const name of KEY_METHODS) {
      if (Object.prototype.hasOwnProperty.call(engine, name)) {
        return { ok: false, reason: `engine gained an own-property override for ${name}` }
      }
      if (snapshot.prototype[name] !== snapshot.methods[name]) {
        return { ok: false, reason: `prototype ${name} was replaced` }
      }
      if (typeof engine[name] !== 'function') return { ok: false, reason: `engine.${name} is no longer callable` }
      if (snapshot.traceable === undefined && engine[name] !== snapshot.methods[name]) {
        return { ok: false, reason: `engine.${name} no longer resolves to the pinned function` }
      }
    }
    return { ok: true }
  }

  const identity = { version: release.version, profile: release.profile, modulePath: snapshot.modulePath, bootId: snapshot.bootId, assertIntegrity }
  cache.set(engine, identity)
  return identity
}
