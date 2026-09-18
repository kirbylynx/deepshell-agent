import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { packageAdapter } from '../../scripts/lib/package-platform.mjs'
import { summarizeInspections, validatePackageManifestV5 } from '../../scripts/lib/package-manifest.mjs'
import { platformInputDigest } from '../../scripts/lib/source-inputs.mjs'
import { normalizedTreeManifest } from '../../scripts/lib/tree-manifest.mjs'
import { isCombinedWindowsPackageReportInput } from '../../scripts/lib/package-report-mode.mjs'
import {
  assertArtifactNameMatchesVersion,
  isMacosDmgName,
  isWindowsNsisInstallerName,
  isWindowsPortableZipName,
  selectWindowsNsisInstallerName,
  selectWindowsPortableZipName,
  uniqueMatchingArtifact,
} from '../../scripts/lib/artifact-selection.mjs'
import { packageCommandPlan } from '../../scripts/lib/process-plan.mjs'
import {
  assertPortableLayout,
  assertPortableTargetPath,
  assertSafePortableStageBase,
  copyTreeWithoutReparsePoints,
  packAndVerify,
  portableAllowlist,
  portablePaths,
} from '../../scripts/create-windows-portable.mjs'
import { assertSafeInstallRoot } from '../../scripts/package-windows-installed-tree.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)

async function runPackageReport(args: string[]) {
  return execFileAsync(process.execPath, ['scripts/collect-package-report.mjs', ...args], {
    cwd: workspace,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const output = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const current = output[key]
    output[key] = value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current)
      ? merge(current as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return output
}

type BaselineFixture = {
  canonicalSource: { peeledCommit: string; baselineSourceInputSha256: string }
  measurement: { algorithm: string }
  artifacts: {
    macosApp: { status: string; contentSha256: string; bytes: number; files: number }
    macosDmg: { status: string; sha256: string; bytes: number }
    windowsInstalledTree: { status: string; contentSha256: string; bytes: number; files: number }
    windowsNsis: { status: string; reason?: string; sha256: string; bytes: number }
  }
}

// Windows 平台无法复现 darwin-arm64 的 macOS app/DMG 场景，因此用当前平台真实存在的
// NSIS installer 契约构造同一套派生断言；这里同时覆盖 Windows 侧 report 派生逻辑。
function windowsNsisManifest(
  baseline: BaselineFixture,
  installerPath: string,
  installerBytes: Buffer,
  installerSha256: string,
  sourceDigest: string,
) {
  return {
    schemaVersion: 5,
    platform: 'win32-x64',
    mode: 'release',
    applicationVersion: '0.1.4',
    artifactKind: 'nsis-installer',
    windowsSourceInputSha256: sourceDigest,
    binarySourceInputSha256: sourceDigest,
    inspections: [
      {
        subject: 'runtime-node',
        inspectionMode: 'exact-artifact-tree',
        status: 'equivalent',
        resources: [{ path: 'runtime/node/win32-x64/node.exe', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: ['win32-x64'],
        size: { bytes: 106774079, files: 1994 },
        contentSha256: 'b'.repeat(64),
      },
      {
        subject: 'runtime-dsh',
        inspectionMode: 'exact-artifact-tree',
        status: 'equivalent',
        resources: [{ path: 'runtime/dsh/index.js', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: [],
        size: { bytes: 220981087, files: 25399 },
        contentSha256: 'c'.repeat(64),
      },
      {
        subject: 'profile-template',
        inspectionMode: 'exact-artifact-tree',
        status: 'equivalent',
        resources: [{ path: 'runtime/profile-template/template-manifest.json', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: [],
        size: { bytes: 67274, files: 17 },
        contentSha256: 'd'.repeat(64),
      },
      {
        subject: 'nsis-installer',
        inspectionMode: 'file-metadata-only',
        status: 'present',
        resources: [{ path: basename(installerPath), bytes: installerBytes.length, sha256: installerSha256 }],
        runtimePlatforms: [],
        size: { bytes: installerBytes.length, files: 1 },
        sha256: installerSha256,
      },
    ],
    baseline: {
      status: baseline.artifacts.windowsNsis.status,
      ...(baseline.artifacts.windowsNsis.reason ? { reason: baseline.artifacts.windowsNsis.reason } : {}),
      canonicalSourceRef: 'v0.1.3',
      canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
      baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
      algorithmVersion: baseline.measurement.algorithm,
      artifactSha256: baseline.artifacts.windowsNsis.sha256,
    },
  }
}

async function writeWindowsNsisInstaller(temporary: string) {
  const installer = resolve(temporary, 'DeepShell Agent_0.1.4_x64-setup.exe')
  await writeFile(installer, 'installer')
  const installerBytes = await readFile(installer)
  const installerSha256 = createHash('sha256').update(installerBytes).digest('hex')
  return { installer, installerBytes, installerSha256 }
}

// portable 清单为首版：baseline 保持 pending，只要求 staging/archive/extracted 三方一致。
function windowsPortableManifest(
  baseline: BaselineFixture,
  sourceDigest: string,
  archiveName = 'DeepShell.Agent_0.1.4_x64-portable.zip',
  archiveBytes = 512,
  archiveSha256 = 'f'.repeat(64),
) {
  return {
    schemaVersion: 5,
    platform: 'win32-x64',
    mode: 'release',
    applicationVersion: '0.1.4',
    artifactKind: 'windows-portable',
    windowsSourceInputSha256: sourceDigest,
    binarySourceInputSha256: sourceDigest,
    inspections: [
      {
        subject: 'staging',
        inspectionMode: 'exact-artifact-tree',
        status: 'present',
        resources: [{ path: 'DeepShell Agent.exe', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: ['win32-x64'],
        size: { bytes: 1024, files: 2 },
        contentSha256: 'e'.repeat(64),
      },
      {
        subject: 'archive',
        inspectionMode: 'file-metadata-only',
        status: 'present',
        resources: [{ path: archiveName, bytes: archiveBytes, sha256: archiveSha256 }],
        runtimePlatforms: [],
        size: { bytes: archiveBytes, files: 1 },
        sha256: archiveSha256,
      },
      {
        subject: 'extracted',
        inspectionMode: 'archive-extracted-tree',
        status: 'equivalent',
        resources: [{ path: 'DeepShell Agent.exe', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: ['win32-x64'],
        size: { bytes: 1024, files: 2 },
        contentSha256: 'e'.repeat(64),
      },
    ],
    baseline: {
      status: 'pending',
      canonicalSourceRef: 'v0.1.3',
      canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
      baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
      algorithmVersion: baseline.measurement.algorithm,
    },
  }
}

function windowsInstalledTreeManifest(baseline: BaselineFixture, sourceDigest: string) {
  return {
    schemaVersion: 5,
    platform: 'win32-x64',
    mode: 'release',
    applicationVersion: '0.1.4',
    artifactKind: 'windows-installed-tree',
    windowsSourceInputSha256: sourceDigest,
    binarySourceInputSha256: sourceDigest,
    inspections: [
      {
        subject: 'windows-installed-tree',
        inspectionMode: 'exact-installed-tree',
        status: 'present',
        resources: [{ path: 'deepshell-agent.exe', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: ['win32-x64'],
        size: { bytes: 340329016, files: 27426 },
        contentSha256: '1'.repeat(64),
      },
    ],
    baseline: {
      status: baseline.artifacts.windowsInstalledTree.status,
      canonicalSourceRef: 'v0.1.3',
      canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
      baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
      algorithmVersion: baseline.measurement.algorithm,
      treeContentSha256: baseline.artifacts.windowsInstalledTree.contentSha256,
    },
  }
}

async function runWindowsNsisReportCase(temporary: string, output: string, baseline: BaselineFixture) {
  const { installer, installerBytes, installerSha256 } = await writeWindowsNsisInstaller(temporary)
  const portableArchive = resolve(temporary, 'DeepShell.Agent_0.1.4_x64-portable.zip')
  await writeFile(portableArchive, 'portable')
  const portableBytes = await readFile(portableArchive)
  const portableSha256 = createHash('sha256').update(portableBytes).digest('hex')
  const sourceDigest = await platformInputDigest(workspace, 'win32-x64')
  const manifest = windowsNsisManifest(baseline, installer, installerBytes, installerSha256, sourceDigest)
  const manifestPath = resolve(temporary, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  const portableManifestPath = resolve(temporary, 'portable-manifest.json')
  await writeFile(portableManifestPath, JSON.stringify(
    windowsPortableManifest(baseline, sourceDigest, basename(portableArchive), portableBytes.length, portableSha256),
  ))

  await runPackageReport([
    '--version', '0.1.4',
    '--output-dir', output,
    '--windows-installer', installer,
    '--package-manifest', manifestPath,
    '--portable-manifest', portableManifestPath,
    '--portable-archive', portableArchive,
  ])

  const report = JSON.parse(await readFile(resolve(output, 'package-report.json'), 'utf8'))
  expect(report.assets.windowsInstaller.bytes).toBe(installerBytes.length)
  expect(report.assets.windowsInstaller.sha256).toBe(installerSha256)
  expect(report.assets.windowsInstaller.baselineStatus).toBe(baseline.artifacts.windowsNsis.status)
  expect(report.assets.windowsInstaller.deltaBytes).toBe(installerBytes.length - baseline.artifacts.windowsNsis.bytes)
  expect(report.assets.windowsPortable.status).toBe('present')
  expect(report.assets.windowsPortable.archive.sha256).toBe(portableSha256)
  expect(report.assets.windowsPortable.staging.contentSha256).toBe('e'.repeat(64))
  expect(report.assets.runtimeNode.bytes).toBe(106774079)
  expect(report.assets.runtimeNode.files).toBe(1994)
  expect(report.assets.runtimeNode.baselineVersion).toBe('0.1.3')
  expect(report.assets.runtimeNode.deltaBytes).toBe(0)
  expect(report.assets.runtimeNode.runtimePlatforms).toEqual(['win32-x64'])
  expect(report.foreignRuntimePaths).toEqual([])
}

async function runWindowsStrictNsisCase(temporary: string, baseline: BaselineFixture) {
  const { installer, installerBytes, installerSha256 } = await writeWindowsNsisInstaller(temporary)
  const portableArchive = resolve(temporary, 'DeepShell.Agent_0.1.4_x64-portable.zip')
  await writeFile(portableArchive, 'portable')
  const portableBytes = await readFile(portableArchive)
  const portableSha256 = createHash('sha256').update(portableBytes).digest('hex')
  const sourceDigest = await platformInputDigest(workspace, 'win32-x64')
  const baseManifest = windowsNsisManifest(baseline, installer, installerBytes, installerSha256, sourceDigest)
  const portableManifestPath = resolve(temporary, 'portable-manifest.json')
  await writeFile(portableManifestPath, JSON.stringify(
    windowsPortableManifest(baseline, sourceDigest, basename(portableArchive), portableBytes.length, portableSha256),
  ))
  const wrongKind = { ...baseManifest, artifactKind: 'windows-installed-tree' }
  const staleBaseline = { ...baseManifest, baseline: { ...baseManifest.baseline, artifactSha256: '0'.repeat(64) } }
  const foreignRuntime = {
    ...baseManifest,
    inspections: [
      ...baseManifest.inspections,
      {
        subject: 'runtime-node-foreign',
        inspectionMode: 'exact-artifact-tree',
        status: 'equivalent',
        resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: ['darwin-arm64'],
        size: { bytes: 1, files: 1 },
        contentSha256: 'b'.repeat(64),
      },
    ],
  }
  for (const [name, manifest] of Object.entries({ wrongKind, staleBaseline, foreignRuntime })) {
    const path = resolve(temporary, `${name}.json`)
    await writeFile(path, JSON.stringify(manifest))
    await expect(runPackageReport([
      '--version', '0.1.4',
      '--output-dir', resolve(temporary, name),
      '--windows-installer', installer,
      '--package-manifest', path,
      '--portable-manifest', portableManifestPath,
      '--portable-archive', portableArchive,
    ])).rejects.toThrow()
  }
}

describe('v0.1.4 打包契约', () => {
  it('平台配置合并后保留共享 DSH/Profile 且只加入当前平台 Node', async () => {
    const base = JSON.parse(await readFile(resolve(workspace, 'src-tauri/tauri.conf.json'), 'utf8'))
    const macos = JSON.parse(await readFile(resolve(workspace, 'src-tauri/tauri.macos.conf.json'), 'utf8'))
    const windows = JSON.parse(await readFile(resolve(workspace, 'src-tauri/tauri.windows.conf.json'), 'utf8'))
    const macResources = merge(base, macos).bundle as { resources: Record<string, string> }
    const winResources = merge(base, windows).bundle as { resources: Record<string, string> }

    expect(Object.keys(macResources.resources)).toEqual(expect.arrayContaining([
      '../runtime/dsh/', '../runtime/profile-template/', '../runtime/node/darwin-arm64/',
    ]))
    expect(Object.keys(macResources.resources)).not.toContain('../runtime/node/win32-x64/')
    expect(Object.keys(winResources.resources)).toEqual(expect.arrayContaining([
      '../runtime/dsh/', '../runtime/profile-template/', '../runtime/node/win32-x64/',
    ]))
    expect(Object.keys(winResources.resources)).not.toContain('../runtime/node/darwin-arm64/')
  })

  it('adapter 锁定 macOS forbidden Runtime，并支持 Windows tree/portable 显式路径', () => {
    const lock = { dsh: { entry: 'node_modules/@deepseek-ai/dsh/lib/bin.js' } }
    const mac = packageAdapter('darwin', lock, 'macos-app')
    expect(mac.requiredArtifacts).toContain('Contents/Resources/runtime/node/darwin-arm64/bin/node')
    expect(mac.forbiddenArtifacts).toContain('Contents/Resources/runtime/node/win32-x64')

    const installed = packageAdapter('win32', lock, 'windows-installed-tree', { artifactPath: '/tmp/installed' })
    expect(installed.requiredArtifacts).toContain('runtime/node/win32-x64/node.exe')
    expect(installed.forbiddenArtifacts).toContain('runtime/node/darwin-arm64')
    const portable = packageAdapter('win32', lock, 'windows-portable', {
      stagingPath: '/tmp/staging', archivePath: '/tmp/archive.zip', extractedPath: '/tmp/extracted',
    })
    expect(portable.artifactKind).toBe('windows-portable')
  })

  it('schema 5 inspection 使用嵌套 size/resources/runtimePlatforms/baseline 契约', () => {
    const manifest = {
      schemaVersion: 5,
      platform: 'darwin-arm64',
      mode: 'release',
      applicationVersion: '0.1.4',
      artifactKind: 'macos-app',
      macosSourceInputSha256: 'a'.repeat(64),
      binarySourceInputSha256: 'a'.repeat(64),
      inspections: [{
        subject: 'macos-app', inspectionMode: 'exact-artifact-tree', status: 'present',
        resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: ['darwin-arm64'], size: { bytes: 1, files: 1 }, contentSha256: 'b'.repeat(64),
      }],
      baseline: {
        status: 'canonical',
        canonicalSourceRef: 'v0.1.3', canonicalSourceCommit: 'commit',
        baselineSourceInputSha256: 'c'.repeat(64), algorithmVersion: 'v1', treeContentSha256: 'd'.repeat(64),
      },
    }
    expect(validatePackageManifestV5(manifest)).toBe(manifest)
  })

  it('reference-only baseline 保留非 canonical 状态', () => {
    const manifest = {
      schemaVersion: 5, platform: 'win32-x64', mode: 'release', applicationVersion: '0.1.4',
      artifactKind: 'nsis-installer', windowsSourceInputSha256: 'b'.repeat(64),
      binarySourceInputSha256: 'b'.repeat(64),
      inspections: [{
        subject: 'nsis-installer', inspectionMode: 'file-metadata-only', status: 'present',
        resources: [{ path: 'setup.exe', bytes: 1, sha256: 'a'.repeat(64) }], runtimePlatforms: [],
        size: { bytes: 1, files: 1 }, sha256: 'a'.repeat(64),
      }],
      baseline: {
        status: 'reference-only', reason: 'provenance pending', canonicalSourceRef: 'v0.1.3',
        canonicalSourceCommit: 'commit', baselineSourceInputSha256: 'c'.repeat(64),
        algorithmVersion: 'v1', artifactSha256: 'd'.repeat(64),
      },
    }
    expect(validatePackageManifestV5(manifest).baseline.status).toBe('reference-only')
    expect(manifest.inspections[0].runtimePlatforms).toEqual([])
  })

  it('schema 5 拒绝错平台 artifactKind 与双平台 digest', () => {
    const invalid = {
      schemaVersion: 5, platform: 'darwin-arm64', mode: 'release', applicationVersion: '0.1.4',
      artifactKind: 'nsis-installer', macosSourceInputSha256: 'a'.repeat(64),
      windowsSourceInputSha256: 'b'.repeat(64), inspections: [], baseline: {},
    }
    expect(() => validatePackageManifestV5(invalid)).toThrow(/artifactKind|inspections|digest/)
  })

  it('同版本产物存在多个候选时拒绝自动选择', () => {
    expect(() => uniqueMatchingArtifact(
      ['DeepShell_0.1.4_x64-setup.exe', 'DeepShell_0.1.4_x64-copy-setup.exe'],
      name => name.includes('0.1.4') && name.endsWith('-setup.exe'),
      'installer',
    )).toThrow('存在多个候选')
  })

  it('Windows installer 只接受当前版本 token，拒绝旧版本和相近版本', () => {
    const names = [
      'DeepShell Agent_0.1.3_x64-setup.exe',
      'DeepShell Agent_0.1.40_x64-setup.exe',
      'DeepShell Agent_0.1.4_x64-setup.exe',
      'DeepShell.Agent_0.1.4_x64-setup.exe',
      'Other_0.1.4_x64-setup.exe',
      'DeepShell Agent_0.1.4_arm64-setup.exe',
    ]
    expect(() => selectWindowsNsisInstallerName(names, '0.1.4')).toThrow('存在多个候选')
    expect(selectWindowsNsisInstallerName([names[2]], '0.1.4')).toBe('DeepShell Agent_0.1.4_x64-setup.exe')
    expect(selectWindowsNsisInstallerName([names[3]], '0.1.4')).toBe('DeepShell.Agent_0.1.4_x64-setup.exe')
    expect(isWindowsNsisInstallerName('DeepShell Agent_0.1.40_x64-setup.exe', '0.1.4')).toBe(false)
    expect(isWindowsNsisInstallerName('DeepShell Agent_0.1.3_x64-setup.exe', '0.1.4')).toBe(false)
    expect(isWindowsNsisInstallerName('Other_0.1.4_x64-setup.exe', '0.1.4')).toBe(false)
    expect(isWindowsNsisInstallerName('DeepShell Agent_0.1.4_arm64-setup.exe', '0.1.4')).toBe(false)
    expect(selectWindowsNsisInstallerName(names.slice(0, 2), '0.1.4')).toBeNull()
    expect(() => assertArtifactNameMatchesVersion(
      'DeepShell Agent_0.1.40_x64-setup.exe',
      '0.1.4',
      'Windows installer',
      isWindowsNsisInstallerName,
    )).toThrow('版本不一致')
  })

  it('便携 ZIP 使用严格版本 token，拒绝旧版本、相近版本与多候选', () => {
    const names = [
      'DeepShell.Agent_0.1.3_x64-portable.zip',
      'DeepShell.Agent_0.1.40_x64-portable.zip',
      'DeepShell.Agent_0.1.4_x64-portable.zip',
      'DeepShell Agent_0.1.4_arm64-portable.zip',
      'Other_0.1.4_x64-portable.zip',
    ]
    expect(isWindowsPortableZipName(names[2], '0.1.4')).toBe(true)
    expect(isWindowsPortableZipName('DeepShell Agent_0.1.4_x64-portable.zip', '0.1.4')).toBe(false)
    expect(isWindowsPortableZipName(names[0], '0.1.4')).toBe(false)
    expect(isWindowsPortableZipName(names[1], '0.1.4')).toBe(false)
    expect(isWindowsPortableZipName(names[3], '0.1.4')).toBe(false)
    expect(isWindowsPortableZipName(names[4], '0.1.4')).toBe(false)
    expect(selectWindowsPortableZipName([names[2]], '0.1.4')).toBe(names[2])
    expect(selectWindowsPortableZipName([names[0], names[1], names[3], names[4]], '0.1.4')).toBeNull()
    expect(selectWindowsPortableZipName([names[2], 'DeepShell Agent_0.1.4_x64-portable.zip'], '0.1.4'))
      .toBe(names[2])
    expect(() => assertArtifactNameMatchesVersion(names[0], '0.1.4', 'Windows portable ZIP', isWindowsPortableZipName))
      .toThrow('版本不一致')
    expect(() => assertArtifactNameMatchesVersion(
      'DeepShell Agent_0.1.4_x64-portable.zip',
      '0.1.4',
      'Windows portable ZIP',
      isWindowsPortableZipName,
    )).toThrow('版本不一致')
  })

  it('便携 staging 布局与 allowlist 目标路径约束', () => {
    const entries = ['DeepShell Agent.exe', 'runtime', 'LICENSE', 'README-portable.txt']
    expect(() => assertPortableLayout(entries)).not.toThrow()
    expect(() => assertPortableLayout([...entries, 'extra.txt'])).toThrow('顶层条目不符合便携布局')
    expect(() => assertPortableLayout(['DeepShell Agent.exe', 'runtime', 'LICENSE'])).toThrow('顶层条目不符合便携布局')
    for (const entry of portableAllowlist) {
      expect(() => assertPortableTargetPath(entry.target)).not.toThrow()
    }
    for (const invalid of ['../escape', '/absolute', 'C:/windows', 'runtime/../escape', 'runtime//empty']) {
      expect(() => assertPortableTargetPath(invalid)).toThrow('不合法')
    }
  })

  it('便携 staging 基准必须位于 runtime/staging/portable-v<version>', () => {
    const version = '0.1.4'
    const paths = portablePaths(workspace, version)
    expect(paths.stagingPath).toBe(resolve(workspace, 'runtime/staging', `portable-v${version}`, 'staging', 'DeepShell Agent'))
    expect(paths.archivePath).toBe(
      resolve(workspace, 'src-tauri/target/release/bundle/portable', `DeepShell.Agent_${version}_x64-portable.zip`),
    )
    expect(() => assertSafePortableStageBase(paths.stageBase, workspace)).not.toThrow()
    expect(() => assertSafePortableStageBase(resolve(workspace), workspace)).toThrow('受保护目录')
    expect(() => assertSafePortableStageBase(resolve(workspace, 'runtime/staging'), workspace)).toThrow('受保护目录')
    expect(() => assertSafePortableStageBase(resolve(workspace, 'outside', `portable-v${version}`), workspace))
      .toThrow('运行时 staging 目录内')
    expect(() => assertSafePortableStageBase(resolve(workspace, 'runtime/staging', 'random'), workspace))
      .toThrow('portable-v<version>')
  })

  it('安装测试根必须位于 runtime/staging/install-tree-v<version>（防止误删任意路径）', () => {
    const version = '0.1.4'
    expect(() => assertSafeInstallRoot(resolve(workspace, 'runtime/staging', `install-tree-v${version}`), workspace))
      .not.toThrow()
    expect(() => assertSafeInstallRoot(resolve(workspace), workspace)).toThrow('受保护目录')
    expect(() => assertSafeInstallRoot(resolve(workspace, 'runtime/staging'), workspace)).toThrow('受保护目录')
    expect(() => assertSafeInstallRoot(resolve(workspace, 'outside', `install-tree-v${version}`), workspace))
      .toThrow('运行时 staging 目录内')
    expect(() => assertSafeInstallRoot(resolve(workspace, 'runtime/staging', 'random'), workspace))
      .toThrow('install-tree-v<version>')
    expect(() => assertSafeInstallRoot(resolve(workspace, 'runtime/staging', `install-tree-v${version}`, 'nested'), workspace))
      .toThrow('install-tree-v<version>')
  })

  it('便携 staging 复制拒绝 junction / reparse point', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-portable-junction-'))
    try {
      const sourceRoot = resolve(temporary, 'source')
      const realDirectory = resolve(sourceRoot, 'real')
      await mkdir(realDirectory, { recursive: true })
      await writeFile(resolve(realDirectory, 'file.txt'), 'content')
      const junction = resolve(sourceRoot, 'linked')
      await symlink(realDirectory, junction, 'junction')

      await expect(copyTreeWithoutReparsePoints(sourceRoot, resolve(temporary, 'target')))
        .rejects.toThrow(/reparse point/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('便携 packAndVerify 完成压缩-解压-等价复验', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-portable-roundtrip-'))
    try {
      const stagingParent = resolve(temporary, 'staging')
      const stagingPath = resolve(stagingParent, 'DeepShell Agent')
      await mkdir(stagingPath, { recursive: true })
      await writeFile(resolve(stagingPath, 'DeepShell Agent.exe'), 'exe')
      await mkdir(resolve(stagingPath, 'runtime'), { recursive: true })
      await writeFile(resolve(stagingPath, 'runtime', 'data.bin'), 'data')
      await writeFile(resolve(stagingPath, 'LICENSE'), 'license')
      await writeFile(resolve(stagingPath, 'README-portable.txt'), 'readme')
      const archivePath = resolve(temporary, 'DeepShell.Agent_0.1.4_x64-portable.zip')
      const extractParent = resolve(temporary, 'extracted')

      const result = await packAndVerify({ stagingPath, stagingParent, archivePath, extractParent })
      expect(result.extractedPath).toBe(resolve(extractParent, 'DeepShell Agent'))
      expect(result.staging.contentSha256).toBe(result.extracted.contentSha256)

      // 顶层目录名不符合约定时必须失败（防"压缩成功但布局错误"）。
      const brokenParent = resolve(temporary, 'broken-staging')
      const brokenPath = resolve(brokenParent, 'Wrong Name')
      await mkdir(brokenPath, { recursive: true })
      await expect(packAndVerify({
        stagingPath: brokenPath,
        stagingParent: brokenParent,
        archivePath: resolve(temporary, 'broken.zip'),
        extractParent: resolve(temporary, 'broken-extracted'),
      })).rejects.toThrow(/顶层条目不符合便携布局|顶层必须是单一目录/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('macOS DMG 也使用严格版本 token，避免 0.1.4 命中 0.1.40', () => {
    expect(isMacosDmgName('DeepShell Agent_0.1.4_aarch64.dmg', '0.1.4')).toBe(true)
    expect(isMacosDmgName('DeepShell.Agent_0.1.4_aarch64.dmg', '0.1.4')).toBe(true)
    expect(isMacosDmgName('DeepShell Agent_0.1.40_aarch64.dmg', '0.1.4')).toBe(false)
    expect(isMacosDmgName('Other_0.1.4_aarch64.dmg', '0.1.4')).toBe(false)
    expect(isMacosDmgName('DeepShell Agent_0.1.4_x64.dmg', '0.1.4')).toBe(false)
  })

  it('Windows 通过 cmd.exe 安全启动 pnpm.cmd 且不启用 shell', () => {
    expect(packageCommandPlan('pnpm.cmd', ['exec', 'tauri'], 'win32')).toEqual({
      command: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm.cmd', 'exec', 'tauri'],
    })
  })

  it('公开报告 inspection 只保留聚合值和 file basename', () => {
    const summaries = summarizeInspections([{
      subject: 'archive', inspectionMode: 'file-metadata-only', status: 'present',
      resources: [{ path: '/Users/private/secret/package.dmg', bytes: 1, sha256: 'a' }],
      runtimePlatforms: [], size: { bytes: 1, files: 1 }, sha256: 'a',
    }])
    expect(JSON.stringify(summaries)).not.toContain('/Users/private')
    expect(JSON.stringify(summaries)).toContain('package.dmg')
  })

  it('package report 从 schema 5 manifest 派生实际打包 runtime 与 delta', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-report-manifest-'))
    try {
      const output = resolve(temporary, 'release')
      await mkdir(output, { recursive: true })
      const baseline = JSON.parse(await readFile(resolve(workspace, 'tests/fixtures/package-size-baselines/v0.1.3.json'), 'utf8'))
      if (process.platform !== 'darwin') {
        await runWindowsNsisReportCase(temporary, output, baseline)
        return
      }
      const app = resolve(temporary, 'DeepShell Agent.app')
      await mkdir(resolve(app, 'runtime/node/darwin-arm64/bin'), { recursive: true })
      await writeFile(resolve(app, 'runtime/node/darwin-arm64/bin/node'), 'node')
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      await writeFile(dmg, 'dmg')
      const dmgBytes = await readFile(dmg)
      const dmgSha256 = createHash('sha256').update(dmgBytes).digest('hex')
      const appTree = await normalizedTreeManifest(app)
      const sourceDigest = await platformInputDigest(workspace, 'darwin-arm64')
      const manifest = {
        schemaVersion: 5,
        platform: 'darwin-arm64',
        mode: 'release',
        applicationVersion: '0.1.4',
        artifactKind: 'macos-app',
        macosSourceInputSha256: sourceDigest,
        binarySourceInputSha256: sourceDigest,
        inspections: [
          {
            subject: 'runtime-node',
            inspectionMode: 'exact-artifact-tree',
            status: 'equivalent',
            resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 1, sha256: 'a'.repeat(64) }],
            runtimePlatforms: ['darwin-arm64'],
            size: { bytes: 196611786, files: 4800 },
            contentSha256: 'b'.repeat(64),
          },
          {
            subject: 'runtime-dsh',
            inspectionMode: 'exact-artifact-tree',
            status: 'equivalent',
            resources: [{ path: 'runtime/dsh/index.js', bytes: 1, sha256: 'a'.repeat(64) }],
            runtimePlatforms: [],
            size: { bytes: 220981087, files: 25399 },
            contentSha256: 'c'.repeat(64),
          },
          {
            subject: 'profile-template',
            inspectionMode: 'exact-artifact-tree',
            status: 'equivalent',
            resources: [{ path: 'runtime/profile-template/template-manifest.json', bytes: 1, sha256: 'a'.repeat(64) }],
            runtimePlatforms: [],
            size: { bytes: 67274, files: 17 },
            contentSha256: 'd'.repeat(64),
          },
          {
            subject: 'macos-app',
            inspectionMode: 'exact-artifact-tree',
            status: 'present',
            resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 4, sha256: 'a'.repeat(64) }],
            runtimePlatforms: ['darwin-arm64'],
            size: { bytes: appTree.bytes, files: appTree.files },
            contentSha256: appTree.contentSha256,
          },
        ],
        baseline: {
          status: 'canonical',
          canonicalSourceRef: 'v0.1.3',
          canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
          baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
          algorithmVersion: baseline.measurement.algorithm,
          treeContentSha256: baseline.artifacts.macosApp.contentSha256,
        },
      }
      const dmgManifest = {
        ...manifest,
        artifactKind: 'macos-dmg',
        baseline: {
          status: 'canonical',
          canonicalSourceRef: 'v0.1.3',
          canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
          baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
          algorithmVersion: baseline.measurement.algorithm,
          artifactSha256: baseline.artifacts.macosDmg.sha256,
        },
        inspections: [
          {
            subject: 'macos-dmg',
            inspectionMode: 'file-metadata-only',
            status: 'present',
            resources: [{ path: 'DeepShell Agent_0.1.4_aarch64.dmg', bytes: dmgBytes.length, sha256: dmgSha256 }],
            runtimePlatforms: [],
            size: { bytes: dmgBytes.length, files: 1 },
            sha256: dmgSha256,
          },
          {
            subject: 'dmg-contained-app',
            inspectionMode: 'archive-extracted-tree',
            status: 'equivalent',
            resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 4, sha256: 'a'.repeat(64) }],
            runtimePlatforms: ['darwin-arm64'],
            size: { bytes: appTree.bytes, files: appTree.files },
            contentSha256: appTree.contentSha256,
          },
        ],
      }
      await writeFile(resolve(temporary, 'manifest.json'), JSON.stringify(manifest))
      await writeFile(resolve(temporary, 'dmg-manifest.json'), JSON.stringify(dmgManifest))
      await writeFile(resolve(temporary, 'license.json'), '{"application":{"version":"0.1.4"}}\n')

      await runPackageReport([
        '--version', '0.1.4',
        '--output-dir', output,
        '--app', app,
        '--dmg', dmg,
        '--package-manifest', resolve(temporary, 'manifest.json'),
        '--dmg-manifest', resolve(temporary, 'dmg-manifest.json'),
        '--license-inventory', resolve(temporary, 'license.json'),
      ])

      const report = JSON.parse(await readFile(resolve(output, 'package-report.json'), 'utf8'))
      expect(report.assets.runtimeNode.bytes).toBe(196611786)
      expect(report.assets.runtimeNode.files).toBe(4800)
      expect(report.assets.runtimeNode.baselineVersion).toBe('0.1.3')
      expect(report.assets.runtimeNode.deltaBytes).toBe(0)
      expect(report.assets.runtimeNode.runtimePlatforms).toEqual(['darwin-arm64'])
      expect(report.assets.app.deltaBytes).toBe(appTree.bytes - 545566355)
      expect(report.foreignRuntimePaths).toEqual([])
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('combined Windows report 判定区分 Windows 原生输入与跨设备输入', () => {
    expect(isCombinedWindowsPackageReportInput({
      hostPlatform: 'win32',
      args: [
        'node',
        'scripts/collect-package-report.mjs',
        '--package-manifest', 'package-release-win32-x64-nsis.json',
        '--windows-installer', 'DeepShell Agent_0.1.4_x64-setup.exe',
        '--portable-manifest', 'package-release-win32-x64-portable.json',
        '--portable-archive', 'DeepShell.Agent_0.1.4_x64-portable.zip',
      ],
    })).toBe(false)

    for (const args of [
      ['--windows-installer', 'DeepShell Agent_0.1.4_x64-setup.exe'],
      ['--windows-portable', 'DeepShell.Agent_0.1.4_x64-portable.zip'],
      ['--windows-nsis-manifest', 'package-release-win32-x64-nsis.json'],
      ['--windows-installed-tree-manifest', 'package-release-win32-x64-installed-tree.json'],
      ['--windows-portable-manifest', 'package-release-win32-x64-portable.json'],
    ]) {
      expect(isCombinedWindowsPackageReportInput({ hostPlatform: 'darwin', args })).toBe(true)
    }

    expect(isCombinedWindowsPackageReportInput({
      hostPlatform: 'win32',
      args: [
        '--windows-nsis-manifest', 'package-release-win32-x64-nsis.json',
        '--windows-installed-tree-manifest', 'package-release-win32-x64-installed-tree.json',
        '--windows-portable-manifest', 'package-release-win32-x64-portable.json',
      ],
    })).toBe(true)
  })

  it.skipIf(process.platform !== 'darwin')('macOS C0 可显式导入 Windows 三类 schema 5 manifest 并生成 combined package report', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-report-combined-'))
    try {
      const output = resolve(temporary, 'release')
      await mkdir(output, { recursive: true })
      const baseline = JSON.parse(await readFile(resolve(workspace, 'tests/fixtures/package-size-baselines/v0.1.3.json'), 'utf8'))
      const macSourceDigest = await platformInputDigest(workspace, 'darwin-arm64')
      const windowsSourceDigest = await platformInputDigest(workspace, 'win32-x64')

      const app = resolve(temporary, 'DeepShell Agent.app')
      await mkdir(resolve(app, 'runtime/node/darwin-arm64/bin'), { recursive: true })
      await writeFile(resolve(app, 'runtime/node/darwin-arm64/bin/node'), 'node')
      const appTree = await normalizedTreeManifest(app)
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      await writeFile(dmg, 'dmg')
      const dmgBytes = await readFile(dmg)
      const dmgSha256 = createHash('sha256').update(dmgBytes).digest('hex')
      const macosAppManifest = {
        schemaVersion: 5,
        platform: 'darwin-arm64',
        mode: 'release',
        applicationVersion: '0.1.4',
        artifactKind: 'macos-app',
        macosSourceInputSha256: macSourceDigest,
        binarySourceInputSha256: macSourceDigest,
        inspections: [{
          subject: 'macos-app',
          inspectionMode: 'exact-artifact-tree',
          status: 'present',
          resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 4, sha256: 'a'.repeat(64) }],
          runtimePlatforms: ['darwin-arm64'],
          size: { bytes: appTree.bytes, files: appTree.files },
          contentSha256: appTree.contentSha256,
        }],
        baseline: {
          status: baseline.artifacts.macosApp.status,
          canonicalSourceRef: 'v0.1.3',
          canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
          baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
          algorithmVersion: baseline.measurement.algorithm,
          treeContentSha256: baseline.artifacts.macosApp.contentSha256,
        },
      }
      const macosDmgManifest = {
        schemaVersion: 5,
        platform: 'darwin-arm64',
        mode: 'release',
        applicationVersion: '0.1.4',
        artifactKind: 'macos-dmg',
        macosSourceInputSha256: macSourceDigest,
        binarySourceInputSha256: macSourceDigest,
        inspections: [{
          subject: 'macos-dmg',
          inspectionMode: 'file-metadata-only',
          status: 'present',
          resources: [{ path: 'DeepShell Agent_0.1.4_aarch64.dmg', bytes: dmgBytes.length, sha256: dmgSha256 }],
          runtimePlatforms: [],
          size: { bytes: dmgBytes.length, files: 1 },
          sha256: dmgSha256,
        }],
        baseline: {
          status: baseline.artifacts.macosDmg.status,
          canonicalSourceRef: 'v0.1.3',
          canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
          baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
          algorithmVersion: baseline.measurement.algorithm,
          artifactSha256: baseline.artifacts.macosDmg.sha256,
        },
      }
      const { installer, installerBytes, installerSha256 } = await writeWindowsNsisInstaller(temporary)
      const portableArchive = resolve(temporary, 'DeepShell.Agent_0.1.4_x64-portable.zip')
      await writeFile(portableArchive, 'portable')
      const portableBytes = await readFile(portableArchive)
      const portableSha256 = createHash('sha256').update(portableBytes).digest('hex')
      const manifestPaths = {
        macosApp: resolve(temporary, 'macos-app.json'),
        macosDmg: resolve(temporary, 'macos-dmg.json'),
        windowsNsis: resolve(temporary, 'windows-nsis.json'),
        windowsInstalledTree: resolve(temporary, 'windows-installed-tree.json'),
        windowsPortable: resolve(temporary, 'windows-portable.json'),
      }
      await writeFile(manifestPaths.macosApp, JSON.stringify(macosAppManifest))
      await writeFile(manifestPaths.macosDmg, JSON.stringify(macosDmgManifest))
      await writeFile(manifestPaths.windowsNsis, JSON.stringify(
        windowsNsisManifest(baseline, installer, installerBytes, installerSha256, windowsSourceDigest),
      ))
      await writeFile(manifestPaths.windowsInstalledTree, JSON.stringify(
        windowsInstalledTreeManifest(baseline, windowsSourceDigest),
      ))
      await writeFile(manifestPaths.windowsPortable, JSON.stringify(
        windowsPortableManifest(baseline, windowsSourceDigest, basename(portableArchive), portableBytes.length, portableSha256),
      ))

      await runPackageReport([
        '--version', '0.1.4',
        '--output-dir', output,
        '--app', app,
        '--dmg', dmg,
        '--windows-installer', installer,
        '--windows-portable', portableArchive,
        '--package-manifest', manifestPaths.macosApp,
        '--dmg-manifest', manifestPaths.macosDmg,
        '--windows-nsis-manifest', manifestPaths.windowsNsis,
        '--windows-installed-tree-manifest', manifestPaths.windowsInstalledTree,
        '--windows-portable-manifest', manifestPaths.windowsPortable,
      ])

      const report = JSON.parse(await readFile(resolve(output, 'package-report.json'), 'utf8'))
      expect(report.assets.app.status).toBe('present')
      expect(report.assets.dmg.status).toBe('present')
      expect(report.assets.windowsInstaller.sha256).toBe(installerSha256)
      expect(report.assets.windowsInstalledTree.deltaBytes).toBe(340329016 - baseline.artifacts.windowsInstalledTree.bytes)
      expect(report.assets.windowsPortable.archive.sha256).toBe(portableSha256)
      expect(report.manifests.releaseWindowsNsisManifest.status).toBe('present')
      expect(report.manifests.releaseWindowsInstalledTreeManifest.status).toBe('present')
      expect(report.manifests.releasePortableManifest.status).toBe('present')
      expect(report.foreignRuntimePaths).toEqual([])

      await expect(runPackageReport([
        '--version', '0.1.4',
        '--output-dir', resolve(temporary, 'missing-explicit-asset'),
        '--app', app,
        '--dmg', dmg,
        '--package-manifest', manifestPaths.macosApp,
        '--dmg-manifest', manifestPaths.macosDmg,
        '--windows-nsis-manifest', manifestPaths.windowsNsis,
        '--windows-portable-manifest', manifestPaths.windowsPortable,
      ])).rejects.toThrow(/输入不完整/)

      await expect(runPackageReport([
        '--version', '0.1.4',
        '--output-dir', resolve(temporary, 'single-windows-arg'),
        '--app', app,
        '--dmg', dmg,
        '--package-manifest', manifestPaths.macosApp,
        '--dmg-manifest', manifestPaths.macosDmg,
        '--windows-installer', installer,
      ])).rejects.toThrow(/输入不完整/)

      await expect(runPackageReport([
        '--version', '0.1.4',
        '--output-dir', resolve(temporary, 'missing-windows-manifest-path'),
        '--app', app,
        '--dmg', dmg,
        '--windows-installer', installer,
        '--windows-portable', portableArchive,
        '--package-manifest', manifestPaths.macosApp,
        '--dmg-manifest', manifestPaths.macosDmg,
        '--windows-nsis-manifest', resolve(temporary, 'missing-windows-nsis.json'),
        '--windows-installed-tree-manifest', manifestPaths.windowsInstalledTree,
        '--windows-portable-manifest', manifestPaths.windowsPortable,
      ])).rejects.toThrow(/显式路径不存在/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 15_000)

  it('release package report 默认拒绝缺失、错 kind、过期 baseline 和异平台 runtime', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-report-strict-'))
    try {
      await expect(runPackageReport([
        '--version', '0.1.4',
        '--output-dir', resolve(temporary, 'missing'),
        '--package-manifest', 'none',
        '--dmg-manifest', 'none',
      ])).rejects.toThrow(/manifest/)

      const baseline = JSON.parse(await readFile(resolve(workspace, 'tests/fixtures/package-size-baselines/v0.1.3.json'), 'utf8'))
      if (process.platform !== 'darwin') {
        await runWindowsStrictNsisCase(temporary, baseline)
        return
      }
      const sourceDigest = await platformInputDigest(workspace, 'darwin-arm64')
      const app = resolve(temporary, 'DeepShell Agent.app')
      await mkdir(resolve(app, 'runtime/node/darwin-arm64/bin'), { recursive: true })
      await writeFile(resolve(app, 'runtime/node/darwin-arm64/bin/node'), 'node')
      const appTree = await normalizedTreeManifest(app)
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      await writeFile(dmg, 'dmg')
      const dmgBytes = await readFile(dmg)
      const dmgSha256 = createHash('sha256').update(dmgBytes).digest('hex')
      const dmgManifest = {
        schemaVersion: 5,
        platform: 'darwin-arm64',
        mode: 'release',
        applicationVersion: '0.1.4',
        artifactKind: 'macos-dmg',
        macosSourceInputSha256: sourceDigest,
        binarySourceInputSha256: sourceDigest,
        inspections: [{
          subject: 'macos-dmg',
          inspectionMode: 'file-metadata-only',
          status: 'present',
          resources: [{ path: 'DeepShell Agent_0.1.4_aarch64.dmg', bytes: dmgBytes.length, sha256: dmgSha256 }],
          runtimePlatforms: [],
          size: { bytes: dmgBytes.length, files: 1 },
          sha256: dmgSha256,
        }],
        baseline: {
          status: 'canonical',
          canonicalSourceRef: 'v0.1.3',
          canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
          baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
          algorithmVersion: baseline.measurement.algorithm,
          artifactSha256: baseline.artifacts.macosDmg.sha256,
        },
      }
      const dmgManifestPath = resolve(temporary, 'dmg-manifest.json')
      await writeFile(dmgManifestPath, JSON.stringify(dmgManifest))
      const baseManifest = {
        schemaVersion: 5,
        platform: 'darwin-arm64',
        mode: 'release',
        applicationVersion: '0.1.4',
        artifactKind: 'macos-app',
        macosSourceInputSha256: sourceDigest,
        binarySourceInputSha256: sourceDigest,
        inspections: [{
          subject: 'macos-app',
          inspectionMode: 'exact-artifact-tree',
          status: 'present',
          resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 1, sha256: 'a'.repeat(64) }],
          runtimePlatforms: ['darwin-arm64'],
          size: { bytes: appTree.bytes, files: appTree.files },
          contentSha256: appTree.contentSha256,
        }],
        baseline: {
          status: 'canonical',
          canonicalSourceRef: 'v0.1.3',
          canonicalSourceCommit: baseline.canonicalSource.peeledCommit,
          baselineSourceInputSha256: baseline.canonicalSource.baselineSourceInputSha256,
          algorithmVersion: baseline.measurement.algorithm,
          treeContentSha256: baseline.artifacts.macosApp.contentSha256,
        },
      }
      const wrongKind = { ...baseManifest, artifactKind: 'macos-dmg' }
      const staleBaseline = {
        ...baseManifest,
        baseline: { ...baseManifest.baseline, treeContentSha256: '0'.repeat(64) },
      }
      const foreignRuntime = {
        ...baseManifest,
        inspections: [{
          ...baseManifest.inspections[0],
          resources: [{ path: 'runtime/node/win32-x64/node.exe', bytes: 1, sha256: 'a'.repeat(64) }],
          runtimePlatforms: ['win32-x64'],
        }],
      }
      for (const [name, manifest] of Object.entries({ wrongKind, staleBaseline, foreignRuntime })) {
        const path = resolve(temporary, `${name}.json`)
        await writeFile(path, JSON.stringify(manifest))
        await expect(runPackageReport([
          '--version', '0.1.4',
          '--output-dir', resolve(temporary, name),
          '--app', app,
          '--dmg', dmg,
          '--package-manifest', path,
          '--dmg-manifest', dmgManifestPath,
        ])).rejects.toThrow()
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 15_000)
})
