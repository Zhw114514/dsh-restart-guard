/**
 * Preflight tests: the script must derive the release from the module hash,
 * resolve the package from the runtime manifest, and refuse a forged
 * package.json. The desktop runtime root shape is `<app.asar>/dsh`.
 *
 * Run: node scripts/preflight-test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let checks = 0
const run = async (label, fn) => {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${label} [real preflight script]`)
}

const nodeBin = process.execPath
const script = fileURLToPath(new URL('./attest.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'restart-guard-preflight-'))
const realPkg = fileURLToPath(new URL('../real-engine/node_modules/@deepseek-ai/dsh-compaction-basic', import.meta.url))

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Build a runtime root that looks like `<app.asar>/dsh`. */
function makeRuntime({ libFrom = realPkg, packageVersion = '0.2.2-rc.1', manifestVersion = '0.2.2-rc.1' } = {}) {
  const root = mkdtempSync(join(dir, 'runtime-'))
  const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  cpSync(join(libFrom, 'lib', 'index.js'), join(pkgDir, 'lib', 'index.js'))
  const originalBytes = readFileSync(join(libFrom, 'package.json'))
  const originalVersion = JSON.parse(originalBytes.toString('utf8')).version
  if (packageVersion === originalVersion) {
    writeFileSync(join(pkgDir, 'package.json'), originalBytes)
  } else {
    const pkg = JSON.parse(originalBytes.toString('utf8'))
    pkg.version = packageVersion
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg))
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: manifestVersion, dependencies: { '@deepseek-ai/dsh-compaction-basic': manifestVersion } }),
  )
  return root
}

const profileDir = join(dir, 'profile')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'desktop' }))

const runAttest = (runtime, out, extra = []) =>
  execFileSync(
    nodeBin,
    [script, '--runtime', runtime, '--profile', 'desktop', '--profile-dir', profileDir, '--out', out, '--boot-id', 'boot-a', ...extra],
    { stdio: 'pipe' },
  )

await run('attests the pinned 0.2.2 release from the runtime manifest', async () => {
  const root = makeRuntime()
  const out = join(dir, 'a1.json')
  runAttest(root, out)
  const attestation = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(attestation.engine.version, '0.2.2-rc.1')
  assert.equal(attestation.engine.profile, 'v022')
  assert.equal(attestation.engine.moduleSha256, 'eafe4adbccc2b87377e4839f1a6093ebe1a0858caadc6c3dbffef19cb1dbc54b')
  assert.equal(attestation.runtimeRoot, root)
  assert.ok(attestation.engine.modulePath.startsWith(root))
})

await run('rejects the v9 counterexample: 0.2.2 bytes with a 0.2.3 package.json', async () => {
  const root = makeRuntime({ packageVersion: '0.2.3-alpha.2', manifestVersion: '0.2.3-alpha.2' })
  let failed = false
  try {
    runAttest(root, join(dir, 'bad1.json'))
  } catch {
    failed = true
  }
  assert.equal(failed, true, 'a forged version must not pass')
})

await run('rejects a runtime manifest that declares another version', async () => {
  const root = makeRuntime({ manifestVersion: '0.2.3-alpha.2' })
  let failed = false
  try {
    runAttest(root, join(dir, 'bad2.json'))
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

await run('rejects a runtime root without package.json', async () => {
  const root = mkdtempSync(join(dir, 'bare-'))
  let failed = false
  try {
    runAttest(root, join(dir, 'bad3.json'))
  } catch {
    failed = true
  }
  assert.equal(failed, true, 'no manifest must fail closed, not downgrade')
})

await run('rejects an empty profile name', async () => {
  const root = makeRuntime()
  let failed = false
  try {
    execFileSync(nodeBin, [script, '--runtime', root, '--profile', '', '--profile-dir', profileDir, '--out', join(dir, 'bad4.json'), '--boot-id', 'b'], { stdio: 'pipe' })
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

await run('reads a runtime root inside an asar archive', async () => {
  const root = makeRuntime()
  const stage = mkdtempSync(join(dir, 'stage-'))
  cpSync(root, join(stage, 'dsh'), { recursive: true })
  const asar = await import(new URL('../preflight/node_modules/@electron/asar/lib/asar.js', import.meta.url).href)
  const archive = join(dir, 'app.asar')
  await asar.createPackage(stage, archive)
  const out = join(dir, 'a2.json')
  runAttest(join(archive, 'dsh'), out)
  const attestation = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(attestation.engine.version, '0.2.2-rc.1')
  assert.equal(attestation.engine.moduleSha256, 'eafe4adbccc2b87377e4839f1a6093ebe1a0858caadc6c3dbffef19cb1dbc54b')
  assert.ok(attestation.engine.modulePath.includes('app.asar'))
})

await run('the pinned table matches the published tarball bytes', async () => {
  const root = makeRuntime()
  const moduleBytes = readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js'))
  assert.equal(sha(moduleBytes), 'eafe4adbccc2b87377e4839f1a6093ebe1a0858caadc6c3dbffef19cb1dbc54b')
})

console.log(`\n${checks} preflight checks passed`)
