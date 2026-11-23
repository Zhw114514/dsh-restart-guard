/**
 * Deployment attestation and the release table.
 *
 * The release table is the ONLY source of version identity: a module whose
 * bytes hash to a table row is that release, whatever its package.json says.
 * The package.json hashes are cross-checks, not identity.
 *
 * Trust boundary: these hashes cover `lib/index.js` and `package.json` of
 * `@deepseek-ai/dsh-compaction-basic` only. They do NOT prove the integrity of
 * the rest of the dependency tree.
 *
 * @module dsh-restart-guard/attestation
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'

/** Pinned releases, hashes computed from the official published tarballs. */
export const SUPPORTED_ENGINES = Object.freeze([
  Object.freeze({
    version: '0.2.2-rc.1',
    profile: 'v022',
    moduleSha256: 'eafe4adbccc2b87377e4839f1a6093ebe1a0858caadc6c3dbffef19cb1dbc54b',
    packageJsonSha256: '0a94a38fa41d8fb73c345378560b9c1c514ba027214781abf9aebd094f9462c3',
  }),
  Object.freeze({
    version: '0.2.3-alpha.2',
    profile: 'v023',
    moduleSha256: 'a1ddbfad42fdcee734b319448617667d8ceebeacb1875e5faf00b974191fcbc9',
    packageJsonSha256: '77b81acfb776a40810735d8cd5ff2bd746d53a77797c6a07e20c2afd3d2b9431',
  }),
])

export const ATTESTATION_SCHEMA = 1

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function hashFile(path) {
  return hashBytes(readFileSync(path))
}

/** Release whose module bytes hash to `sha`, or undefined. */
export function resolveRelease(sha) {
  return SUPPORTED_ENGINES.find((entry) => entry.moduleSha256 === sha)
}

/**
 * Segment-aware containment test. A plain `startsWith` would accept
 * `...\runtime-evil` for a root of `...\runtime`, so compare whole segments.
 */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const normalise = (value) => {
    const absolute = resolvePath(value)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  const base = normalise(root).replace(new RegExp(`\\${sep}+$`), '')
  const child = normalise(target)
  return child === base || child.startsWith(`${base}${sep}`)
}

/**
 * Read and structurally validate an attestation. Version/profile inside are
 * NOT trusted here; the caller re-derives them from the module hash.
 */
export function loadAttestation(path) {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: 'no attestation path configured' }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `attestation unreadable: ${error?.message ?? String(error)}` }
  }
  if (parsed?.schema !== ATTESTATION_SCHEMA) return { ok: false, reason: `unsupported attestation schema ${String(parsed?.schema)}` }
  if (typeof parsed.bootId !== 'string' || parsed.bootId.length === 0) return { ok: false, reason: 'attestation lacks a bootId' }
  if (typeof parsed.profile !== 'string' || parsed.profile.length === 0) return { ok: false, reason: 'attestation lacks a profile' }
  if (typeof parsed.runtimeRoot !== 'string' || parsed.runtimeRoot.length === 0) return { ok: false, reason: 'attestation lacks a runtimeRoot' }
  if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) {
    return { ok: false, reason: 'attestation lacks a valid createdAt' }
  }
  const engine = parsed.engine
  if (engine === undefined || typeof engine !== 'object') return { ok: false, reason: 'attestation lacks engine facts' }
  if (typeof engine.modulePath !== 'string' || engine.modulePath.length === 0) return { ok: false, reason: 'attestation lacks engine.modulePath' }
  if (!/^[0-9a-f]{64}$/.test(String(engine.moduleSha256))) return { ok: false, reason: 'attestation lacks a valid engine.moduleSha256' }
  if (!/^[0-9a-f]{64}$/.test(String(engine.packageJsonSha256))) return { ok: false, reason: 'attestation lacks a valid engine.packageJsonSha256' }
  if (typeof engine.package !== 'string' || engine.package.length === 0) return { ok: false, reason: 'attestation lacks engine.package' }
  return { ok: true, attestation: parsed }
}

/**
 * Validate the attestation against this boot/profile/time. Returns the parsed
 * record; the caller still re-derives the release from the module hash.
 */
export function validateAttestation({ path, bootId, profile, maxAgeMs = 86_400_000, now = Date.now() }) {
  const loaded = loadAttestation(path)
  if (loaded.ok !== true) return loaded
  const { attestation } = loaded

  if (typeof bootId !== 'string' || bootId.length === 0) return { ok: false, reason: 'no boot id provided for attestation binding' }
  if (attestation.bootId !== bootId) {
    return { ok: false, reason: `attestation bootId ${attestation.bootId} does not match this boot ${bootId}` }
  }
  if (typeof profile !== 'string' || profile.length === 0) return { ok: false, reason: 'no profile provided for attestation binding' }
  if (attestation.profile !== profile) {
    return { ok: false, reason: `attestation profile ${attestation.profile} does not match ${profile}` }
  }
  const age = now - Date.parse(attestation.createdAt)
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    return { ok: false, reason: `attestation age ${Math.round(age / 1000)}s exceeds the limit` }
  }
  if (!isInside(attestation.runtimeRoot, attestation.engine.modulePath)) {
    return { ok: false, reason: 'attested modulePath is outside the attested runtimeRoot' }
  }
  return { ok: true, attestation }
}
