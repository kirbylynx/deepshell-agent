// 产物清单捕获（macOS `.app` / Windows NSIS 安装包）。
//
// 平台差异由 `scripts/lib/package-platform.mjs` 提供。
// 清单结构：`schemaVersion: 4`——由 3 升级，变更为「新增 platform 字段」「linkedLibraries
// 在非 darwin 平台由数组改为 unavailable 对象」「非 darwin 平台不产出 infoPlistSha256」。
// 不允许在 schemaVersion 3 下改变字段结构：`compare-e2e-release.mjs` 按字段名盲读、不做版本协商
// （设计 §4.6 的结构变更声明）。
import { createHash } from 'node:crypto'
import { access, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { relative, resolve } from 'node:path'
import { readLock, root } from './lib/runtime.mjs'
import { deterministicInputDigest } from './lib/source-inputs.mjs'
import { packageAdapter, requireArtifactReady } from './lib/package-platform.mjs'

const mode = process.argv[2]
if (!['e2e', 'release'].includes(mode)) throw new Error('用法：capture-package-manifest.mjs <e2e|release>')

const execFileAsync = promisify(execFile)
const lock = await readLock()
const adapter = packageAdapter(process.platform, lock)
// 打包资源（**打包输入**）：macOS 在产物内，Windows 是仓库的 `runtime/`。
const stagedResources = adapter.resourcesRoot
// 可遍历的"产物资源树"：macOS 与上面同一个目录；Windows 没有资源树 → 用 NSIS 构建中间目录近似。
const artifactResources = adapter.intermediateRoot

// 清单的来源是真实产物，因此先如实报告缺失，而不是在读取二进制时抛出裸 ENOENT。
await requireArtifactReady(adapter, access)
await access(stagedResources)
await access(artifactResources)

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function fileManifest(directory) {
  const records = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else {
        const content = await readFile(path)
        records.push({ path: relative(directory, path), bytes: content.length, sha256: digest(content) })
      }
    }
  }
  await walk(directory)
  return records.sort((left, right) => left.path.localeCompare(right.path))
}

// 二进制标记搜索：darwin 用 /usr/bin/strings，win32 用适配器的字节精确子串搜索（设计 §4.5）。
async function readMarkerText() {
  if (adapter.platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/bin/strings', [adapter.binaryPath], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }
  return adapter.readBinaryStrings(adapter.binaryPath)
}

const featureArgs = mode === 'e2e' ? ['--features', 'poc-e2e'] : []
const [markerText, { stdout: cargoMetadata }, { stdout: cargoFeatureTree }, config, capability, profileManifest] = await Promise.all([
  readMarkerText(),
  execFileAsync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', resolve(root, 'src-tauri/Cargo.toml')], { maxBuffer: 64 * 1024 * 1024 }),
  execFileAsync('cargo', ['tree', '--locked', '--manifest-path', resolve(root, 'src-tauri/Cargo.toml'), '-e', 'features', ...featureArgs], { maxBuffer: 64 * 1024 * 1024 }),
  readFile(resolve(root, 'src-tauri/tauri.conf.json')),
  readFile(resolve(root, 'src-tauri/capabilities/main.json')),
  readFile(resolve(stagedResources, 'runtime/profile-template/template-manifest.json')),
])
const [cargoToml, cargoLock, sourceInputSha256] = await Promise.all([
  readFile(resolve(root, 'src-tauri/Cargo.toml')),
  readFile(resolve(root, 'src-tauri/Cargo.lock')),
  deterministicInputDigest(root),
])

// macOS 专属字段：`Info.plist` 哈希与 `codesign` 签名信息仅在 darwin 产出；Windows 如实标注
// （设计 §4.5 / §4.6 的差异项要求：显式 unavailable / unsigned，不得静默跳过）。
let platformSpecific = {}
if (adapter.platform === 'darwin') {
  const [signing, entitlements, infoPlist, linkedLibraries] = await Promise.all([
    execFileAsync('/usr/bin/codesign', ['-dvvv', adapter.artifactPath]).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' })),
    execFileAsync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', adapter.binaryPath]).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' })),
    readFile(resolve(adapter.artifactPath, 'Contents/Info.plist')),
    execFileAsync('/usr/bin/otool', ['-L', adapter.binaryPath], { maxBuffer: 4 * 1024 * 1024 })
  ])
  platformSpecific = {
    infoPlistSha256: digest(infoPlist),
    // 与改造前逐字一致：仍为 otool 输出解析出的动态库数组。
    linkedLibraries: linkedLibraries.stdout.trim().split('\n').slice(1).map(line => line.trim()).sort(),
    signing: {
      adhoc: `${signing.stdout}${signing.stderr}`.includes('Signature=adhoc'),
      identifier: /Identifier=com\.deepshell\.agent/.test(`${signing.stdout}${signing.stderr}`),
      entitlementsSha256: digest(`${entitlements.stdout}${entitlements.stderr}`.replace(/^Executable=.*$/m, ''))
    }
  }
} else {
  platformSpecific = {
    // otool 结构性不可得 → 对象形式显式标注（设计 §4.5 / §4.7 的类型约束）。
    linkedLibraries: adapter.linkedLibraries,
    signing: adapter.signing
  }
}

const manifest = {
  schemaVersion: 4,
  platform: adapter.runtimePlatform(),
  mode,
  artifactKind: adapter.artifactKind,
  buildProfile: markerText.includes('deepshell-build-profile:poc-e2e')
    ? 'poc-e2e'
    : markerText.includes('deepshell-build-profile:release') ? 'release' : 'unknown',
  configSha256: digest(config),
  capabilitySha256: digest(capability),
  profileManifestSha256: digest(profileManifest),
  cargoTomlSha256: digest(cargoToml),
  cargoLockSha256: digest(cargoLock),
  cargoMetadataSha256: digest(cargoMetadata),
  cargoFeatureTreeSha256: digest(cargoFeatureTree),
  cargoFeatureTreeHasWebdriver: cargoFeatureTree.includes('tauri-plugin-wdio-webdriver'),
  sourceInputSha256,
  webdriverMarker: markerText.includes('deepshell-build-profile:poc-e2e'),
  e2eStopCommandMarker: markerText.includes('poc_e2e_stop_runtime'),
  ...platformSpecific,
  configSources: ['src-tauri/tauri.conf.json'],
  // macOS：产物内 `Contents/Resources` 的真实文件清单。
  // Windows：NSIS **构建中间目录**的文件清单 → **语义近似**，不能证明压缩包内部内容（设计 §4.4）。
  resources: await fileManifest(artifactResources)
}
if (manifest.buildProfile !== (mode === 'e2e' ? 'poc-e2e' : 'release')) {
  throw new Error(`实际 binary build profile 与 ${mode} 清单不一致`)
}
const outputDirectory = resolve(root, 'runtime/staging')
await mkdir(outputDirectory, { recursive: true })
await writeFile(resolve(outputDirectory, `package-${mode}.json`), JSON.stringify(manifest, null, 2) + '\n')
console.log(`${mode} package manifest captured (platform=${manifest.platform}, schemaVersion=${manifest.schemaVersion})`)
