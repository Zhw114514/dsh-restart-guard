/**
 * Deployment preflight: attest the engine that the desktop runtime will load.
 *
 * It no longer accepts caller-supplied module/package paths. It resolves the
 * dependency from the runtime root's own manifest, then derives the release
 * from the module hash table — the package.json version is only a cross-check.
 *
 * Desktop runtime root for this round: `<app.asar>/dsh`. Unpacked CLI roots are
 * out of scope and must be treated as unsupported.
 *
 * Usage:
 *   node scripts/attest.mjs --runtime <app.asar/dsh> --profile <name> \
 *     --profile-dir <profile dir> --out <attestation.json> --boot-id <id>
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { SUPPORTED_ENGINES, resolveRelease } from '../lib/attestation.js'

const PKG = '@deepseek-ai/dsh-compaction-basic'

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    profile: { type: 'string' },
    'profile-dir': { type: 'string' },
    out: { type: 'string' },
    'boot-id': { type: 'string' },
  },
})

const fail = (message) => {
  console.error(`attest: ${message}`)
  process.exit(1)
}

/** Read a path that may live inside an asar archive. */
async function readMaybeAsar(path) {
  const marker = path.toLowerCase().indexOf('.asar')
  if (marker === -1) return readFileSync(path)
  const archive = path.slice(0, marker + '.asar'.length)
  const inner = path.slice(marker + '.asar'.length).replace(/^[\\/]+/, '')
  const asar = await import(new URL('../preflight/node_modules/@electron/asar/lib/asar.js', import.meta.url).href)
  const candidates = [inner, inner.replace(/\\/g, '/'), inner.replace(/\//g, '\\')]
  let lastError
  for (const candidate of candidates) {
    try {
      return asar.extractFile(archive, candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`cannot read ${inner}`)
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

const runtimeRoot = values.runtime
const profile = values.profile
const profileDir = values['profile-dir']
const outPath = values.out
const bootId = values['boot-id']

if (runtimeRoot === undefined) fail('--runtime is required')
if (profile === undefined || profile.length === 0) fail('--profile is required and must not be empty')
if (profileDir === undefined) fail('--profile-dir is required')
if (outPath === undefined) fail('--out is required')
if (bootId === undefined || bootId.length === 0) fail('--boot-id is required')

// 1. The runtime manifest is mandatory; no downgrade path.
let manifestBytes
try {
  manifestBytes = await readMaybeAsar(join(runtimeRoot, 'package.json'))
} catch (error) {
  fail(`runtimeRoot has no readable package.json: ${error?.message ?? String(error)}`)
}
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const declared = manifest.dependencies?.[PKG] ?? manifest.devDependencies?.[PKG]
if (typeof declared !== 'string' || declared.length === 0) fail(`runtime manifest does not declare ${PKG}`)

// 2. Resolve the package inside the runtime, not from caller input.
const packagePath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'package.json')
const modulePath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')

let packageBytes
let moduleBytes
try {
  packageBytes = await readMaybeAsar(packagePath)
  moduleBytes = await readMaybeAsar(modulePath)
} catch (error) {
  fail(`cannot read the resolved engine package: ${error?.message ?? String(error)}`)
}

// 3. The module hash decides the release.
const moduleSha = sha(moduleBytes)
const release = resolveRelease(moduleSha)
if (release === undefined) fail(`module hash ${moduleSha.slice(0, 16)}… is not a supported release`)

// 4. Cross-checks: name, version, package.json bytes, runtime manifest.
const packageJson = JSON.parse(packageBytes.toString('utf8'))
if (packageJson.name !== PKG) fail(`unexpected package name ${String(packageJson.name)}`)
if (packageJson.version !== release.version) {
  fail(`package.json version ${String(packageJson.version)} contradicts the module hash (${release.version})`)
}
if (sha(packageBytes) !== release.packageJsonSha256) fail('package.json bytes are not the pinned release')
if (declared !== release.version) fail(`runtime manifest declares ${declared}, module hash says ${release.version}`)

// 5. Profile must exist and be a real profile.
if (!existsSync(profileDir)) fail(`profile directory does not exist: ${profileDir}`)
let profileJson
try {
  profileJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
} catch (error) {
  fail(`profile package.json unreadable: ${error?.message ?? String(error)}`)
}
if (typeof profileJson?.name !== 'string' || profileJson.name.length === 0) fail('profile package.json has no name')

const attestation = {
  schema: 1,
  bootId,
  createdAt: new Date().toISOString(),
  profile,
  runtimeRoot,
  engine: {
    package: PKG,
    version: release.version,
    profile: release.profile,
    modulePath,
    packageJsonPath: packagePath,
    moduleSha256: moduleSha,
    packageJsonSha256: sha(packageBytes),
  },
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(attestation, null, 2)}\n`, 'utf8')
console.log(`attest: ${release.version} (${release.profile}) -> ${outPath}`)
console.log(`attest: pinned releases ${SUPPORTED_ENGINES.map((entry) => entry.version).join(', ')}`)
