/**
 * Fake engine objects stamped with a REAL engine class identity.
 *
 * The guard identifies an engine by the source fingerprint of its constructor,
 * so a test double must carry the genuine class function to be trusted. The
 * routing/compaction behaviour of these objects stays fake; only the identity
 * is real. This is exactly the "fake engine + real class identity" split the
 * report must keep explicit.
 */
const loadClass = async (spec) => {
  const mod = await import(new URL(spec, import.meta.url).href)
  return mod.BasicCompactionEngine ?? mod.default
}

const V022 = await loadClass('../real-engine/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')
const V023 = await loadClass('../real-engine-023/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')

const stamp = (engine, ctor) => {
  Object.defineProperty(engine, 'constructor', { value: ctor, configurable: true })
  return engine
}

/** Genuine 0.2.2-rc.1 class identity, fake behaviour. */
export const asV022 = (engine) => stamp(engine, V022)
/** Genuine 0.2.3-alpha.2 class identity, fake behaviour. */
export const asV023 = (engine) => stamp(engine, V023)
/** No identity: the plain object keeps Object's constructor. */
export const asUnknown = (engine) => engine
/** A subclass has different class source, so its fingerprint must not match. */
export const asSubclass = (engine) => stamp(engine, class ExtendedEngine extends V022 {})
/** A Proxy around the class cannot expose trustworthy source. */
export const asProxiedClass = (engine) => stamp(engine, new Proxy(V022, {}))
/** A facade that hides both class and capabilities. */
export const asFacade = (engine) => ({
  config: engine.config,
  compactRegion: (...args) => engine.compactRegion(...args),
})
