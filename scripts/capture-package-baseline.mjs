import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { root } from './lib/runtime.mjs'
import { assertEquivalentTrees, normalizedTreeManifest, TREE_MANIFEST_ALGORITHM } from './lib/tree-manifest.mjs'
import { v013BaselineInputDigest } from './lib/source-inputs.mjs'
import { verifyDmgContainsApp } from './lib/macos-dmg.mjs'

const execFileAsync = promisify(execFile)
const EXPECTED_TAG_COMMIT = '34142a3e78f237b0c494551ffe4a8e309f3ab66a'
const EXPECTED_V013_PACKAGE_SOURCE_INPUT = 'bb6ed2bf88daafb90c7729335fa5d488be0e89b153f8324354a95c3c2757431d'
const EXPECTED_BASELINE_SOURCE_INPUT = 'fbcd8ff948dd21a369ad296211bb885e9e0b96b3113b9157e671402c946dd51d'

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少参数 ${name}`)
  return resolve(process.argv[index + 1])
}

async function fileMetric(path) {
  const content = await readFile(path)
  return {
    status: 'canonical',
    bytes: (await stat(path)).size,
    files: 1,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

function treeMetric(manifest) {
  return {
    status: 'canonical',
    bytes: manifest.bytes,
    files: manifest.files,
    contentSha256: manifest.contentSha256,
  }
}

const sourceRoot = arg('--source-root')
const appPath = arg('--app')
const dmgPath = arg('--dmg')
const packageManifestPath = arg('--package-manifest')
const output = arg('--output')
const { stdout } = await execFileAsync('git', ['rev-parse', 'v0.1.3^{commit}'], { cwd: root })
const actualTagCommit = stdout.trim()
if (actualTagCommit !== EXPECTED_TAG_COMMIT) {
  throw new Error(`v0.1.3 peeled commit 不一致：expected ${EXPECTED_TAG_COMMIT}, got ${actualTagCommit}`)
}

const sourceRootReal = await realpath(sourceRoot)
for (const [label, path] of [['app', appPath], ['dmg', dmgPath], ['package manifest', packageManifestPath]]) {
  const pathReal = await realpath(path)
  const pathFromSource = relative(sourceRootReal, pathReal)
  if (pathFromSource === '..' || pathFromSource.startsWith(`..${sep}`) || pathFromSource.startsWith(sep)) {
    throw new Error(`${label} 必须位于 exact source checkout 内`)
  }
}
const [{ stdout: sourceCommit }, { stdout: trackedChanges }] = await Promise.all([
  execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRootReal }),
  execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: sourceRootReal }),
])
if (sourceCommit.trim() !== EXPECTED_TAG_COMMIT) {
  throw new Error(`baseline source checkout 不是 v0.1.3 exact commit：${sourceCommit.trim()}`)
}
const unexpectedTrackedChanges = trackedChanges.split('\n').filter(line => line.trim() !== '').filter(line => {
  const path = line.slice(3)
  return !path.startsWith('src-tauri/gen/schemas/')
})
if (unexpectedTrackedChanges.length > 0) {
  throw new Error(`baseline source checkout 含非 Tauri generated schema 的 tracked 修改：${unexpectedTrackedChanges.join(', ')}`)
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
for (const args of [
  ['runtime:prepare', '--target', 'all'],
  ['runtime:verify', '--target', 'all'],
  ['profile:prepare'],
  ['profile:verify'],
]) {
  await execFileAsync(pnpm, args, { cwd: sourceRootReal, maxBuffer: 64 * 1024 * 1024 })
}

const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'))
if (packageManifest.schemaVersion !== 4 || packageManifest.platform !== 'darwin-arm64' ||
    packageManifest.mode !== 'release' || packageManifest.artifactKind !== 'macos-app' ||
    packageManifest.sourceInputSha256 !== EXPECTED_V013_PACKAGE_SOURCE_INPUT) {
  throw new Error('v0.1.3 package manifest 与 exact source baseline 不匹配')
}

const [app, appResources, dmg, dmgContainedApp, darwinNode, windowsNode, dsh, profileTemplate, baselineSourceInputSha256] = await Promise.all([
  normalizedTreeManifest(appPath),
  normalizedTreeManifest(resolve(appPath, 'Contents/Resources')),
  fileMetric(dmgPath),
  verifyDmgContainsApp(dmgPath, appPath),
  normalizedTreeManifest(resolve(sourceRoot, 'runtime/node/darwin-arm64')),
  normalizedTreeManifest(resolve(sourceRoot, 'runtime/node/win32-x64')),
  normalizedTreeManifest(resolve(sourceRoot, 'runtime/dsh')),
  normalizedTreeManifest(resolve(sourceRoot, 'runtime/profile-template')),
  v013BaselineInputDigest(sourceRoot),
])
if (baselineSourceInputSha256 !== EXPECTED_BASELINE_SOURCE_INPUT) {
  throw new Error(`baseline source input digest 不一致：${baselineSourceInputSha256}`)
}
const stableEntries = entries => [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
if (JSON.stringify(stableEntries(packageManifest.resources)) !== JSON.stringify(stableEntries(appResources.entries))) {
  throw new Error('v0.1.3 package manifest 未绑定当前 baseline app resources')
}
if (dmgContainedApp.target.contentSha256 !== app.contentSha256) {
  throw new Error('v0.1.3 DMG 未绑定当前 baseline app')
}
const appResourcesRoot = resolve(appPath, 'Contents/Resources/runtime')
await Promise.all([
  assertEquivalentTrees(resolve(sourceRoot, 'runtime/node/darwin-arm64'), resolve(appResourcesRoot, 'node/darwin-arm64'), 'baseline darwin Node'),
  assertEquivalentTrees(resolve(sourceRoot, 'runtime/node/win32-x64'), resolve(appResourcesRoot, 'node/win32-x64'), 'baseline Windows Node'),
  assertEquivalentTrees(resolve(sourceRoot, 'runtime/dsh'), resolve(appResourcesRoot, 'dsh'), 'baseline DSH'),
  assertEquivalentTrees(resolve(sourceRoot, 'runtime/profile-template'), resolve(appResourcesRoot, 'profile-template'), 'baseline Profile'),
])

const fixture = {
  schemaVersion: 1,
  baselineVersion: '0.1.3',
  canonicalSource: {
    tag: 'v0.1.3',
    peeledCommit: EXPECTED_TAG_COMMIT,
    baselineSourceInputSha256,
  },
  measurement: {
    algorithm: TREE_MANIFEST_ALGORITHM,
    symlinks: 'dereference-safe-files-within-trusted-subtree',
    emptyDirectories: 'ignored',
    baselineInput: 'git-blobs-v1',
  },
  artifacts: {
    macosApp: treeMetric(app),
    macosDmg: dmg,
    windowsInstalledTree: { status: 'pending' },
    windowsNsis: {
      status: 'reference-only',
      bytes: 84314666,
      files: 1,
      sha256: '3edb1a8cb52a48ffa92972bf767317e4ae814f92f261d6cab9204cb66cee4bd8',
      reason: 'published asset exact-commit provenance not yet proven',
    },
  },
  sourceTrees: {
    darwinNode: treeMetric(darwinNode),
    windowsNode: treeMetric(windowsNode),
    dsh: treeMetric(dsh),
    profileTemplate: treeMetric(profileTemplate),
  },
  historicalNotes: {
    windowsInstalledTree: 'approximately 512 MB and 32226 files; reference only, not a gate baseline',
  },
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`v0.1.3 package baseline written: ${output}`)
