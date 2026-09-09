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
  for (const field of [
    'configSha256', 'capabilitySha256', 'profileManifestSha256', 'infoPlistSha256',
    'cargoTomlSha256', 'cargoLockSha256', 'cargoMetadataSha256', 'sourceInputSha256',
    'signing', 'configSources'
  ]) {
    if (JSON.stringify(e2e[field]) !== JSON.stringify(release[field])) throw new Error(`E2E/Release ${field} 不一致`)
  }
  if (JSON.stringify(e2e.resources) !== JSON.stringify(release.resources)) {
    throw new Error('E2E/Release bundled resources 不一致')
  }
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
  if (unexpectedE2eLibraries.length > 0 || e2eOnlyLibraries.length !== allowedE2eFrameworks.size) {
    throw new Error(`E2E feature 的额外动态库不在固定允许列表：${e2eOnlyLibraries.join(', ')}`)
  }
  if (e2e.buildProfile !== 'poc-e2e' || release.buildProfile !== 'release' ||
      !e2e.webdriverMarker || release.webdriverMarker ||
      !e2e.e2eStopCommandMarker || release.e2eStopCommandMarker ||
      !e2e.cargoFeatureTreeHasWebdriver || release.cargoFeatureTreeHasWebdriver) {
    throw new Error('embedded WebDriver 只能存在于 poc-e2e 构建')
  }
  console.log('E2E/Release 产物安全边界比较通过')
} else {
  console.log('E2E/Release 静态安全边界比较通过；构建两种产物后执行完整比较')
}
