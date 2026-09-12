// E2E 与 Release 产物清单的安全边界比较。
//
// 本脚本本身就是跨平台的（只用 cargo + 文件哈希），但清单里存在**平台专属字段**，
// 因此必须按平台裁剪比较项，并把跳过项**显式记录**到 `skippedChecks`（设计 §4.7）。
//
// 三条不得违反的规则：
// 1. `platform` 不一致时**立即拒绝比较**——禁止把 Windows 清单与 macOS 清单放在一起比，
//    否则 `configSha256` 等字段会因构建主机差异而产生误导性结论（设计 §4.7 第 4 项）；
// 2. 跳过的比较项必须写入 `skippedChecks`（`{ name, reason }`），非 darwin 平台上该数组
//    不得为空——为空即说明「跳过」未生效、仍在静默通过（设计 §4.7 设计约束）；
// 3. `linkedLibraries` 必须先判形再比较：**数组**才执行白名单检查，**对象**则整项跳过。
//    禁止把对象强转为空数组后静默通过（设计 §4.7 第 2 项）。
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { root } from './lib/runtime.mjs'
import { deterministicInputDigest } from './lib/source-inputs.mjs'

const execFileAsync = promisify(execFile)
const digest = content => createHash('sha256').update(content).digest('hex')

const cargo = await readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8')
if (!cargo.includes('poc-e2e')) throw new Error('缺少 poc-e2e feature')
if (/default\s*=\s*\[[^\]]*poc-e2e/.test(cargo)) throw new Error('Release 默认启用了 poc-e2e')
if (!/poc-e2e\s*=\s*\["dep:tauri-plugin-wdio-webdriver"\]/.test(cargo)) {
  throw new Error('poc-e2e feature 必须只启用 embedded WebDriver Rust 插件')
}
const capability = JSON.parse(await readFile(resolve(root, 'src-tauri/capabilities/main.json'), 'utf8'))
const serialized = JSON.stringify(capability)
if (/shell:|fs:|wdio/i.test(serialized)) throw new Error('Release capability 含通用 Shell/File 或 WDIO 权限')

async function optionalManifest(mode) {
  try {
    return JSON.parse(await readFile(resolve(root, `runtime/staging/package-${mode}.json`), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const requireArtifacts = process.argv.includes('--require-artifacts')
const [e2e, release] = await Promise.all([optionalManifest('e2e'), optionalManifest('release')])
if (requireArtifacts && (!e2e || !release)) {
  throw new Error('完整比较要求同时存在 E2E 与 Release 产物清单')
}
if (e2e && release) {
  // ① 跨平台拒绝（设计 §4.7 第 4 项）：`platform` 由清单提供，取值为
  // `currentRuntimePlatform()` 的 `darwin-arm64` / `win32-x64`。旧版（schemaVersion 3）清单
  // 没有该字段，同样在此被拒绝——这是结构变更的预期后果，须重建产物而非放宽校验。
  const incomplete = [
    e2e.platform ? null : 'E2E 清单缺少 platform 字段（schemaVersion 3 及更早的清单需重建）',
    release.platform ? null : 'Release 清单缺少 platform 字段（schemaVersion 3 及更早的清单需重建）'
  ].filter(Boolean)
  if (incomplete.length > 0) {
    throw new Error(`产物清单结构过时，必须重建两种产物：${incomplete.join('；')}`)
  }
  if (e2e.platform !== release.platform) {
    throw new Error(`E2E/Release 产物清单来自不同平台，拒绝比较：${e2e.platform} vs ${release.platform}`)
  }
  const darwin = e2e.platform === 'darwin-arm64'

  const commonInputs = {
    configSha256: digest(await readFile(resolve(root, 'src-tauri/tauri.conf.json'))),
    capabilitySha256: digest(await readFile(resolve(root, 'src-tauri/capabilities/main.json'))),
    profileManifestSha256: digest(await readFile(resolve(root, 'runtime/profile-template/template-manifest.json'))),
    cargoTomlSha256: digest(await readFile(resolve(root, 'src-tauri/Cargo.toml'))),
    cargoLockSha256: digest(await readFile(resolve(root, 'src-tauri/Cargo.lock'))),
    sourceInputSha256: await deterministicInputDigest(root),
  }
  const cargoMetadata = await execFileAsync('cargo', [
    'metadata', '--locked', '--no-deps', '--format-version', '1',
    '--manifest-path', resolve(root, 'src-tauri/Cargo.toml')
  ], { maxBuffer: 64 * 1024 * 1024 })
  commonInputs.cargoMetadataSha256 = digest(cargoMetadata.stdout)
  const skippedChecks = darwin ? [] : [
    { name: 'infoPlistSha256', reason: 'Info.plist is macOS-only' },
    { name: 'linkedLibraries', reason: 'otool is macOS-only' },
    { name: 'signing', reason: 'Windows has no application signature' }
  ]
  const staleFields = []
  for (const [field, current] of Object.entries(commonInputs)) {
    if (e2e[field] !== current || release[field] !== current) {
      if (requireArtifacts) {
        throw new Error(`E2E/Release 清单的 ${field} 已与当前构建输入不同，必须重建两种产物`)
      }
      staleFields.push(field)
    }
  }
  if (staleFields.length > 0) {
    console.log(`E2E/Release 静态安全边界通过；已有产物清单已过期，重打包后再执行完整比较：${staleFields.join(', ')}`)
    console.log(JSON.stringify({ ok: true, platform: e2e.platform, skippedChecks }))
    process.exit(0)
  }
  for (const manifest of [e2e, release]) {
    const featureArgs = manifest.mode === 'e2e' ? ['--features', 'poc-e2e'] : []
    const featureTree = await execFileAsync('cargo', [
      'tree', '--locked', '--manifest-path', resolve(root, 'src-tauri/Cargo.toml'),
      '-e', 'features', ...featureArgs
    ], { maxBuffer: 64 * 1024 * 1024 })
    if (manifest.cargoFeatureTreeSha256 !== digest(featureTree.stdout)) {
      throw new Error(`${manifest.mode} 清单的实际 Cargo feature tree 已过期`)
    }
  }
  // ② `infoPlistSha256` 仅在 darwin 参与比较（设计 §4.7 第 1 项）；非 darwin 平台移入
  // `skippedChecks`，而不是「两侧同为 undefined」的隐式通过。
  const comparableFields = [
    'configSha256', 'capabilitySha256', 'profileManifestSha256',
    ...(darwin ? ['infoPlistSha256'] : []),
    'cargoTomlSha256', 'cargoLockSha256', 'cargoMetadataSha256', 'sourceInputSha256',
    ...(darwin ? ['signing'] : []),
    'configSources'
  ]
  for (const field of comparableFields) {
    if (JSON.stringify(e2e[field]) !== JSON.stringify(release[field])) throw new Error(`E2E/Release ${field} 不一致`)
  }
  if (JSON.stringify(e2e.resources) !== JSON.stringify(release.resources)) {
    throw new Error('E2E/Release bundled resources 不一致')
  }
  // ③ `linkedLibraries` 先判形再比较（设计 §4.7 第 2 项）：数组才走白名单检查。
  if (Array.isArray(e2e.linkedLibraries) && Array.isArray(release.linkedLibraries)) {
    const releaseOnlyLibraries = release.linkedLibraries.filter(library => !e2e.linkedLibraries.includes(library))
    if (releaseOnlyLibraries.length > 0) {
      throw new Error(`Release 含 E2E 未链接的动态库：${releaseOnlyLibraries.join(', ')}`)
    }
    const e2eOnlyLibraries = e2e.linkedLibraries.filter(library => !release.linkedLibraries.includes(library))
    const allowedE2eFrameworks = new Set([
      'CloudKit', 'CoreData', 'CoreImage', 'CoreText', 'JavaScriptCore', 'QuartzCore', 'Security'
    ])
    const unexpectedE2eLibraries = e2eOnlyLibraries.filter(library => {
      const framework = library.match(/Frameworks\/([^/.]+)\.framework/)?.[1]
      return !framework || !allowedE2eFrameworks.has(framework)
    })
    // ④ Framework 白名单 `size` 硬断言仅在 darwin 执行（设计 §4.7 第 3 项）。
    // 不使用 `0 !== 7` 之类的降级比较代替。
    if (unexpectedE2eLibraries.length > 0 || e2eOnlyLibraries.length !== allowedE2eFrameworks.size) {
      throw new Error(`E2E feature 的额外动态库不在固定允许列表：${e2eOnlyLibraries.join(', ')}`)
    }
  } else if (darwin) {
    // darwin 上 `linkedLibraries` 必须是数组（otool 可用）；不是数组说明清单结构异常，
    // 不能在 macOS 上静默跳过——那会削弱 macOS 侧既有检查。
    throw new Error('darwin 产物清单的 linkedLibraries 应为数组')
  }
  if (e2e.buildProfile !== 'poc-e2e' || release.buildProfile !== 'release' ||
      !e2e.webdriverMarker || release.webdriverMarker ||
      !e2e.e2eStopCommandMarker || release.e2eStopCommandMarker ||
      !e2e.cargoFeatureTreeHasWebdriver || release.cargoFeatureTreeHasWebdriver) {
    throw new Error('embedded WebDriver 只能存在于 poc-e2e 构建')
  }
  console.log('E2E/Release 产物安全边界比较通过')
  console.log(JSON.stringify({ ok: true, platform: e2e.platform, skippedChecks }))
} else {
  console.log('E2E/Release 静态安全边界比较通过；构建两种产物后执行完整比较')
}
