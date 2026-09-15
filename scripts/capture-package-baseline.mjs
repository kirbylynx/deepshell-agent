import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { root } from './lib/runtime.mjs'
import { assertEquivalentTrees, normalizedTreeManifest, TREE_MANIFEST_ALGORITHM } from './lib/tree-manifest.mjs'
import { v013BaselineInputDigest } from './lib/source-inputs.mjs'
import { verifyDmgContainsApp } from './lib/macos-dmg.mjs'

const execFileAsync = promisify(execFile)
export const EXPECTED_TAG_COMMIT = 'ca4add9dc52c5053278570abb28e1d21ae5a0239'
export const EXPECTED_BASELINE_VERSION = '0.1.3'
const EXPECTED_V013_PACKAGE_SOURCE_INPUT = 'bb6ed2bf88daafb90c7729335fa5d488be0e89b153f8324354a95c3c2757431d'
const EXPECTED_BASELINE_SOURCE_INPUT = 'fbcd8ff948dd21a369ad296211bb885e9e0b96b3113b9157e671402c946dd51d'

const allowedGeneratedPrefixes = [
  'dist/',
  'node_modules/',
  'runtime/cache/',
  'runtime/dsh/',
  'runtime/node/',
  'runtime/profile-template/',
  'runtime/staging/',
  'src-tauri/gen/schemas/',
  'src-tauri/target/',
]

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少参数 ${name}`)
  return resolve(process.argv[index + 1])
}

function normalizeRepoPath(path) {
  return path.split('\\').join('/').replace(/\/+$/, '')
}

function isSameOrChild(path, allowed) {
  const normalizedPath = normalizeRepoPath(path)
  const normalizedAllowed = normalizeRepoPath(allowed)
  return normalizedPath === normalizedAllowed || normalizedPath.startsWith(`${normalizedAllowed}/`)
}

function normalizeAbsolutePath(path) {
  return resolve(path).split('\\').join('/')
}

export function canonicalBaselineArtifactPaths(sourceRoot) {
  return {
    app: resolve(sourceRoot, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app'),
    dmg: resolve(sourceRoot, `src-tauri/target/release/bundle/dmg/DeepShell Agent_${EXPECTED_BASELINE_VERSION}_aarch64.dmg`),
    packageManifest: resolve(sourceRoot, 'runtime/staging/package-release.json'),
  }
}

export function baselineRebuildCommand(pnpm) {
  return { command: pnpm, args: ['package:verified'] }
}

export function baselineInstallCommand(pnpm) {
  return { command: pnpm, args: ['install', '--frozen-lockfile'] }
}

export function assertCanonicalBaselineCapturePaths(sourceRoot, paths, { canonicalOutput } = {}) {
  const canonical = canonicalBaselineArtifactPaths(sourceRoot)
  const mismatches = []
  for (const [label, expected] of Object.entries(canonical)) {
    if (normalizeAbsolutePath(paths[label]) !== normalizeAbsolutePath(expected)) {
      mismatches.push(`${label}: expected ${expected}, got ${paths[label]}`)
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`baseline capture 只接受 v0.1.3 package:verified 生成的固定 release 产物路径：${mismatches.join('; ')}`)
  }
  if (canonicalOutput && normalizeAbsolutePath(paths.output) !== normalizeAbsolutePath(canonicalOutput)) {
    throw new Error(`baseline capture output 必须写入当前 canonical fixture：expected ${canonicalOutput}, got ${paths.output}`)
  }
}

export function isAllowedBaselineStatusPath(path, allowedArtifactPaths = []) {
  const normalized = normalizeRepoPath(path)
  return allowedGeneratedPrefixes.some(prefix => isSameOrChild(normalized, prefix)) ||
    allowedArtifactPaths.some(allowed => isSameOrChild(normalized, allowed))
}

export function parseBaselineStatusEntries(buffer) {
  const tokens = buffer.toString('utf8').split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!/^[ MTADRCU?!][ MTADRCU?!] /.test(token)) continue
    const status = token.slice(0, 2)
    const firstPath = token.slice(3)
    const paths = [firstPath]
    if (status.includes('R') || status.includes('C')) {
      const secondPath = tokens[index + 1]
      if (secondPath !== undefined && !/^[ MTADRCU?!][ MTADRCU?!] /.test(secondPath)) {
        paths.push(secondPath)
        index += 1
      }
    }
    entries.push({ raw: paths.length === 1 ? token : `${token}\0${paths[1]}`, status, paths })
  }
  return entries
}

export function unexpectedBaselineStatusEntries(entries, allowedArtifactPaths = []) {
  return entries.filter(entry => {
    const paths = typeof entry === 'string' ? [entry.slice(3)] : entry.paths
    return paths.some(path => !isAllowedBaselineStatusPath(path, allowedArtifactPaths))
  }).map(entry => typeof entry === 'string' ? entry : entry.raw)
}

export function unexpectedInitialBaselineStatusEntries(entries) {
  return entries.map(entry => typeof entry === 'string' ? entry : entry.raw)
}

async function assertInitialExactCheckout(sourceRootReal) {
  const { stdout } = await execFileAsync('git', [
    'status',
    '--porcelain=v1',
    '-z',
    '--ignored',
    '--untracked-files=all',
  ], { cwd: sourceRootReal, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  const unexpected = unexpectedInitialBaselineStatusEntries(parseBaselineStatusEntries(stdout))
  if (unexpected.length > 0) {
    throw new Error(`baseline source checkout 必须是无生成残留的 exact export：${unexpected.join(', ')}`)
  }
}

async function assertExactCheckoutCleanEnough(sourceRootReal, artifactPaths) {
  const allowedArtifactPaths = artifactPaths.map(path => normalizeRepoPath(relative(sourceRootReal, path)))
  const { stdout } = await execFileAsync('git', [
    'status',
    '--porcelain=v1',
    '-z',
    '--ignored',
    '--untracked-files=all',
  ], { cwd: sourceRootReal, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  const unexpected = unexpectedBaselineStatusEntries(parseBaselineStatusEntries(stdout), allowedArtifactPaths)
  if (unexpected.length > 0) {
    throw new Error(`baseline source checkout 含未授权的 tracked/untracked/ignored 修改：${unexpected.join(', ')}`)
  }
}

export function plistStringValue(plist, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = plist.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`))
  return match?.[1] ?? null
}

export function assertBaselineAppInfoPlist(infoPlist) {
  const version = plistStringValue(infoPlist, 'CFBundleShortVersionString')
  if (version !== EXPECTED_BASELINE_VERSION) {
    throw new Error(`baseline app Info.plist 版本不一致：expected ${EXPECTED_BASELINE_VERSION}, got ${version ?? 'unknown'}`)
  }
  const executable = plistStringValue(infoPlist, 'CFBundleExecutable')
  if (!executable) throw new Error('baseline app Info.plist 缺少 CFBundleExecutable')
  return { version, executable }
}

async function appBundleReceipt(appPath) {
  const infoPlist = await readFile(resolve(appPath, 'Contents/Info.plist'), 'utf8')
  const { version, executable } = assertBaselineAppInfoPlist(infoPlist)
  return {
    infoPlistSha256: createHash('sha256').update(infoPlist).digest('hex'),
    bundleShortVersion: version,
    executable,
    mainExecutable: await fileMetric(resolve(appPath, 'Contents/MacOS', executable)),
  }
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

export async function capturePackageBaseline() {
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
  assertCanonicalBaselineCapturePaths(sourceRootReal, {
    app: appPath,
    dmg: dmgPath,
    packageManifest: packageManifestPath,
    output,
  }, {
    canonicalOutput: resolve(root, 'tests/fixtures/package-size-baselines/v0.1.3.json'),
  })

  const artifactPaths = []
  for (const [label, path] of [['app', appPath], ['dmg', dmgPath], ['package manifest', packageManifestPath]]) {
    const normalizedPath = resolve(path)
    const pathFromSource = relative(sourceRootReal, normalizedPath)
    if (pathFromSource === '..' || pathFromSource.startsWith(`..${sep}`) || pathFromSource.startsWith(sep)) {
      throw new Error(`${label} 必须位于 exact source checkout 内`)
    }
    artifactPaths.push(normalizedPath)
  }
  const { stdout: sourceCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRootReal })
  if (sourceCommit.trim() !== EXPECTED_TAG_COMMIT) {
    throw new Error(`baseline source checkout 不是 v0.1.3 exact commit：${sourceCommit.trim()}`)
  }
  await assertInitialExactCheckout(sourceRootReal)

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const install = baselineInstallCommand(pnpm)
  await execFileAsync(install.command, install.args, { cwd: sourceRootReal, maxBuffer: 128 * 1024 * 1024 })
  for (const args of [
    ['runtime:prepare', '--target', 'all'],
    ['runtime:verify', '--target', 'all'],
    ['profile:prepare'],
    ['profile:verify'],
  ]) {
    await execFileAsync(pnpm, args, { cwd: sourceRootReal, maxBuffer: 64 * 1024 * 1024 })
  }
  await assertExactCheckoutCleanEnough(sourceRootReal, artifactPaths)
  const rebuild = baselineRebuildCommand(pnpm)
  await execFileAsync(rebuild.command, rebuild.args, { cwd: sourceRootReal, maxBuffer: 256 * 1024 * 1024 })
  await assertExactCheckoutCleanEnough(sourceRootReal, artifactPaths)
  for (const [label, path] of [['app', appPath], ['dmg', dmgPath], ['package manifest', packageManifestPath]]) {
    const pathReal = await realpath(path)
    const pathFromSource = relative(sourceRootReal, pathReal)
    if (pathFromSource === '..' || pathFromSource.startsWith(`..${sep}`) || pathFromSource.startsWith(sep)) {
      throw new Error(`${label} 必须位于 exact source checkout 内`)
    }
  }

  const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'))
  if (packageManifest.schemaVersion !== 4 || packageManifest.platform !== 'darwin-arm64' ||
      packageManifest.mode !== 'release' || packageManifest.artifactKind !== 'macos-app' ||
      packageManifest.sourceInputSha256 !== EXPECTED_V013_PACKAGE_SOURCE_INPUT) {
    throw new Error('v0.1.3 package manifest 与 exact source baseline 不匹配')
  }

  const [app, appResources, dmg, dmgContainedApp, darwinNode, windowsNode, dsh, profileTemplate, baselineSourceInputSha256, appReceipt] = await Promise.all([
    normalizedTreeManifest(appPath),
    normalizedTreeManifest(resolve(appPath, 'Contents/Resources')),
    fileMetric(dmgPath),
    verifyDmgContainsApp(dmgPath, appPath),
    normalizedTreeManifest(resolve(sourceRoot, 'runtime/node/darwin-arm64')),
    normalizedTreeManifest(resolve(sourceRoot, 'runtime/node/win32-x64')),
    normalizedTreeManifest(resolve(sourceRoot, 'runtime/dsh')),
    normalizedTreeManifest(resolve(sourceRoot, 'runtime/profile-template')),
    v013BaselineInputDigest(sourceRoot),
    appBundleReceipt(appPath),
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
    baselineVersion: EXPECTED_BASELINE_VERSION,
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
    provenance: {
      checkoutPolicy: 'exact v0.1.3 commit; no tracked, untracked, or ignored source/config drift outside generated-output allowlist',
      appInfoPlist: {
        bundleShortVersion: appReceipt.bundleShortVersion,
        infoPlistSha256: appReceipt.infoPlistSha256,
        executable: appReceipt.executable,
      },
      appMainExecutable: appReceipt.mainExecutable,
      packageManifest: {
        schemaVersion: packageManifest.schemaVersion,
        sourceInputSha256: packageManifest.sourceInputSha256,
      },
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await capturePackageBaseline()
}
