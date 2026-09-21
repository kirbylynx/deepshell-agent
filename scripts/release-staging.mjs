import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, sha256 } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'
import { windowsManifestFields, windowsNotesLine } from './lib/windows-acceptance.mjs'
import {
  assertArtifactNameMatchesVersion,
  isMacosDmgName,
  isWindowsNsisInstallerName,
  isWindowsPortableZipName,
  selectMacosDmgName,
  selectWindowsNsisInstallerName,
  selectWindowsPortableZipName,
} from './lib/artifact-selection.mjs'

function argValue(name, fallback) {
  const prefix = `${name}=`
  const inline = process.argv.find(value => value.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function explicitArgValue(name) {
  const prefix = `${name}=`
  const inline = process.argv.find(value => value.startsWith(prefix))
  if (inline) return { explicit: true, value: inline.slice(prefix.length) }
  const index = process.argv.indexOf(name)
  return index >= 0 ? { explicit: true, value: process.argv[index + 1] } : { explicit: false }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isSameOrChild(path, parent) {
  const child = resolve(path)
  const base = resolve(parent)
  const fromBase = relative(base, child)
  return fromBase === '' || (!fromBase.startsWith('..') && !fromBase.startsWith(sep))
}

function assertExplicitInputOutsideOutput(option, outputDirectory) {
  const input = explicitArgValue(option)
  if (input.explicit && isSameOrChild(input.value, outputDirectory)) {
    throw new Error(`${option} 显式输入不能位于将被替换的 release staging output 内：${input.value}`)
  }
}

async function assertOutputDirectoryMayBeReplaced(version, outputDirectory) {
  if (!await exists(outputDirectory)) return
  let entries
  try {
    entries = await readdir(outputDirectory)
  } catch {
    throw new Error(`release staging output 必须是目录：${outputDirectory}`)
  }
  if (entries.length === 0) return
  const manifestPath = resolve(outputDirectory, 'release-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error(`拒绝替换非空且缺少 release-manifest sentinel 的目录：${outputDirectory}`)
  }
  const actualVersion = manifest.application?.version
  if (manifest.application?.name !== 'DeepShell Agent' || actualVersion !== version) {
    throw new Error(`拒绝替换 release-manifest sentinel 不匹配的目录：expected ${version}, got ${actualVersion ?? 'unknown'}`)
  }
}

async function matchingAsset(directory, version, selector, extension, candidatePredicate = () => true) {
  if (!await exists(directory)) return { status: 'missing' }
  const files = (await readdir(directory))
    .filter(file => extname(file).toLowerCase() === extension && candidatePredicate(file))
    .sort()
  const selected = selector(files, version)
  if (selected !== null) return { status: 'present', path: resolve(directory, selected) }
  if (files.length === 0) return { status: 'missing' }
  throw new Error(`未找到当前版本 ${version} 的合法发布资产；候选文件：${files.join(', ')}`)
}

async function currentDmg(version) {
  const directory = resolve(argValue('--dmg-dir', resolve(root, 'src-tauri/target/release/bundle/dmg')))
  return matchingAsset(directory, version, selectMacosDmgName, '.dmg')
}

async function currentWindowsInstaller(version) {
  const directory = resolve(argValue('--windows-installer-dir', resolve(root, 'src-tauri/target/release/bundle/nsis')))
  return matchingAsset(
    directory,
    version,
    selectWindowsNsisInstallerName,
    '.exe',
    file => file.toLowerCase().endsWith('-setup.exe'),
  )
}

async function currentWindowsPortable(version) {
  const directory = resolve(argValue('--windows-portable-dir', resolve(root, 'src-tauri/target/release/bundle/portable')))
  return matchingAsset(
    directory,
    version,
    selectWindowsPortableZipName,
    '.zip',
    file => file.toLowerCase().endsWith('-portable.zip'),
  )
}

async function copyJsonIfPresent(source, target, assets, label, version) {
  if (!await exists(source)) {
    assets.push({ label, status: 'missing', asset: basename(target) })
    return null
  }
  const content = await readFile(source, 'utf8')
  const json = JSON.parse(content)
  if (json.application?.version !== version) {
    throw new Error(`${label} 版本不一致：expected ${version}, got ${json.application?.version ?? 'unknown'}`)
  }
  await writeFile(target, content)
  assets.push({ label, status: 'present', asset: basename(target), sha256: await sha256(target) })
  return json
}

function presentAsset(assets, label) {
  const asset = assets.find(item => item.label === label)
  if (!asset || asset.status !== 'present') {
    throw new Error(`combined release staging 要求 ${label} 资产存在，但状态为 ${asset?.status ?? 'missing'}`)
  }
  return asset
}

function assertPackageReportMetric(report, path, label) {
  const value = path.reduce((current, key) => current?.[key], report)
  if (value?.status !== 'present') {
    throw new Error(`combined release staging 的 package report 缺少 present 指标：${label}`)
  }
  return value
}

function assertPackageReportSummary(report, key) {
  const summary = report.manifests?.[key]
  if (summary?.status !== 'present') {
    throw new Error(`combined release staging 的 package report 缺少 present manifest summary：${key}`)
  }
  if (summary.runtime?.provisional !== false) {
    throw new Error(`combined release staging 拒绝 provisional Runtime：${key}`)
  }
}

function assertReportShaMatchesAsset(metricSha, asset, label) {
  if (metricSha !== asset.sha256) {
    throw new Error(`combined release staging 的 package report ${label} sha 与 staging 资产不一致`)
  }
}

function validateCombinedPackageReport(report, assets) {
  if (report?.schemaVersion !== 3) {
    throw new Error('combined release staging 要求 schemaVersion=3 的 package report')
  }
  if (report.runtime?.provisional !== false || report.runtimeAcceptance?.status !== 'present' ||
      report.runtimeAcceptance?.passed !== true) {
    throw new Error('combined release staging 要求非 provisional Runtime 和已通过的 Runtime acceptance')
  }
  if (report.firstRunFootprint?.status !== 'present' ||
      !Number.isSafeInteger(report.firstRunFootprint.total?.files) ||
      !Number.isSafeInteger(report.firstRunFootprint.total?.bytes)) {
    throw new Error('combined release staging 要求完整的首次运行总占用汇总')
  }
  const dmg = assertPackageReportMetric(report, ['assets', 'dmg'], 'assets.dmg')
  assertPackageReportMetric(report, ['assets', 'app'], 'assets.app')
  const windowsInstaller = assertPackageReportMetric(report, ['assets', 'windowsInstaller'], 'assets.windowsInstaller')
  assertPackageReportMetric(report, ['assets', 'windowsInstalledTree'], 'assets.windowsInstalledTree')
  const windowsPortable = assertPackageReportMetric(report, ['assets', 'windowsPortable'], 'assets.windowsPortable')
  const windowsPortableArchive = assertPackageReportMetric(report, ['assets', 'windowsPortable', 'archive'], 'assets.windowsPortable.archive')
  assertPackageReportSummary(report, 'releasePackageManifest')
  assertPackageReportSummary(report, 'releaseDmgManifest')
  assertPackageReportSummary(report, 'releaseWindowsNsisManifest')
  assertPackageReportSummary(report, 'releaseWindowsInstalledTreeManifest')
  assertPackageReportSummary(report, 'releasePortableManifest')
  assertReportShaMatchesAsset(dmg.sha256, presentAsset(assets, 'macos-dmg'), 'DMG')
  assertReportShaMatchesAsset(windowsInstaller.sha256, presentAsset(assets, 'windows-nsis'), 'Windows NSIS')
  assertReportShaMatchesAsset(windowsPortableArchive.sha256, presentAsset(assets, 'windows-portable'), 'Windows portable ZIP')
  if (windowsPortable.archive?.status !== 'present') {
    throw new Error('combined release staging 的 package report 缺少 present portable archive 指标')
  }
}

export async function replaceDirectory(stagingDirectory, outputDirectory, fs = { exists, rename, rm }) {
  const backupDirectory = resolve(dirname(outputDirectory), `.${basename(outputDirectory)}-previous-${process.pid}-${Date.now()}`)
  let movedExistingOutput = false
  try {
    if (await fs.exists(outputDirectory)) {
      await fs.rename(outputDirectory, backupDirectory)
      movedExistingOutput = true
    }
    await fs.rename(stagingDirectory, outputDirectory)
    if (movedExistingOutput) {
      try {
        await fs.rm(backupDirectory, { recursive: true, force: true })
      } catch (error) {
        try {
          await fs.rm(backupDirectory, { recursive: true, force: true })
        } catch (retryError) {
          console.warn(`release staging backup cleanup failed; committed output retained; backup may need manual cleanup: ${backupDirectory}: ${retryError?.message ?? error?.message ?? retryError}`)
        }
      }
    }
  } catch (error) {
    if (movedExistingOutput && !await fs.exists(outputDirectory)) {
      try {
        await fs.rename(backupDirectory, outputDirectory)
      } catch {
        // 保留原始异常，避免把真正的 staging 失败原因掩盖掉。
      }
    }
    throw error
  }
}

async function writeReleaseStaging(version, outputDirectory, stagingDirectory, options = {}) {
  const assets = []
  const dmgArg = argValue('--dmg', undefined)
  const dmg = dmgArg === undefined ? await currentDmg(version) : { status: 'present', path: resolve(dmgArg) }
  const windowsInstallerArg = argValue('--windows-installer', undefined)
  const windowsInstaller = windowsInstallerArg === undefined
    ? await currentWindowsInstaller(version)
    : { status: 'present', path: resolve(windowsInstallerArg) }
  const windowsPortableArg = argValue('--windows-portable', undefined)
  const windowsPortable = windowsPortableArg === undefined
    ? await currentWindowsPortable(version)
    : { status: 'present', path: resolve(windowsPortableArg) }
  if (dmg.status === 'missing') {
    assets.push({ label: 'macos-dmg', status: 'missing', asset: `DeepShell.Agent_${version}_aarch64.dmg` })
  } else {
    assertArtifactNameMatchesVersion(basename(dmg.path), version, 'macOS DMG', isMacosDmgName)
    const target = resolve(stagingDirectory, `DeepShell.Agent_${version}_aarch64.dmg`)
    await copyFile(dmg.path, target)
    assets.push({ label: 'macos-dmg', status: 'present', asset: basename(target), sha256: await sha256(target) })
  }
  if (windowsInstaller.status === 'missing') {
    assets.push({ label: 'windows-nsis', status: 'missing', asset: `DeepShell.Agent_${version}_x64-setup.exe` })
  } else {
    assertArtifactNameMatchesVersion(basename(windowsInstaller.path), version, 'Windows installer', isWindowsNsisInstallerName)
    const target = resolve(stagingDirectory, `DeepShell.Agent_${version}_x64-setup.exe`)
    await copyFile(windowsInstaller.path, target)
    assets.push({ label: 'windows-nsis', status: 'present', asset: basename(target), sha256: await sha256(target) })
  }
  if (windowsPortable.status === 'missing') {
    assets.push({ label: 'windows-portable', status: 'missing', asset: `DeepShell.Agent_${version}_x64-portable.zip` })
  } else {
    assertArtifactNameMatchesVersion(basename(windowsPortable.path), version, 'Windows portable ZIP', isWindowsPortableZipName)
    const target = resolve(stagingDirectory, `DeepShell.Agent_${version}_x64-portable.zip`)
    await copyFile(windowsPortable.path, target)
    assets.push({ label: 'windows-portable', status: 'present', asset: basename(target), sha256: await sha256(target) })
  }
  await copyJsonIfPresent(
    resolve(argValue('--license-inventory', resolve(root, 'runtime/staging/license-inventory.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-license-inventory.json`),
    assets,
    'license-inventory',
    version
  )
  await copyJsonIfPresent(
    resolve(argValue('--sbom', resolve(root, 'runtime/staging/sbom.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-sbom.json`),
    assets,
    'sbom',
    version
  )
  const packageReport = await copyJsonIfPresent(
    resolve(argValue('--package-report', resolve(root, 'runtime/staging/package-report.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-package-report.json`),
    assets,
    'package-report',
    version
  )
  await copyJsonIfPresent(
    resolve(argValue('--security-audit', resolve(root, 'runtime/staging/security-audit.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-security-audit.json`),
    assets,
    'security-audit',
    version
  )
  if (options.validateCombinedPackageReport) {
    validateCombinedPackageReport(packageReport, assets)
  }

  const presentAssets = assets.filter(asset => asset.status === 'present')
  const sums = presentAssets.map(asset => `${asset.sha256}  ${asset.asset}`).join('\n')
  await writeFile(resolve(stagingDirectory, 'SHA256SUMS.txt'), sums.length === 0 ? '' : `${sums}\n`)

  const notes = [
    `# DeepShell Agent v${version} Developer Preview`,
    '',
    'This draft is generated locally by `pnpm release:stage`.',
    '',
    '## Distribution status',
    '',
    '- macOS arm64: developer preview packaging lane.',
    '- Code signing: ad-hoc/local signing only.',
    '- Apple notarization: not performed.',
    windowsNotesLine(version),
    '',
    '## Assets',
    '',
    ...assets.map(asset => `- ${asset.asset}: ${asset.status}`),
    ''
  ]
  await writeFile(resolve(stagingDirectory, 'RELEASE_NOTES.md'), notes.join('\n'))
  await writeFile(resolve(stagingDirectory, 'release-manifest.json'), redactedJson({
    schemaVersion: 1,
    application: { name: 'DeepShell Agent', version },
    generatedAt: new Date().toISOString(),
    assets,
    publishPolicy: 'local staging only; GitHub release creation and asset upload require explicit user authorization',
    // Windows 验收事实由 `lib/windows-acceptance.mjs` **按版本**提供，notes 与 manifest 共用同一份渲染，
    // 因此两处不可能出现"版本与验收结论不一致"。未登记的版本会如实输出"无验收记录"。
    ...windowsManifestFields(version)
  }))
  return assets
}

export async function runReleaseStaging() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = argValue('--version', pkg.version)
  const outputDirectory = resolve(argValue('--output-dir', resolve(root, 'runtime/staging', `release-v${version}`)))
  // `--require-assets macos-dmg,windows-nsis,windows-portable`：combined release staging
  // 必须齐全的场景（macOS 收口）用它在替换 output 之前显式失败。
  const requiredAssets = (argValue('--require-assets', '') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  for (const option of ['--dmg', '--windows-installer', '--windows-portable', '--license-inventory', '--sbom', '--package-report', '--security-audit']) {
    assertExplicitInputOutsideOutput(option, outputDirectory)
  }
  await assertOutputDirectoryMayBeReplaced(version, outputDirectory)
  await mkdir(dirname(outputDirectory), { recursive: true })
  let stagingDirectory = await mkdtemp(resolve(dirname(outputDirectory), `.${basename(outputDirectory)}-tmp-`))
  try {
    const combinedPackageReportRequired = ['macos-dmg', 'windows-nsis', 'windows-portable']
      .every(label => requiredAssets.includes(label))
    const assets = await writeReleaseStaging(version, outputDirectory, stagingDirectory, {
      validateCombinedPackageReport: combinedPackageReportRequired,
    })
    for (const label of requiredAssets) {
      const asset = assets.find(item => item.label === label)
      if (!asset || asset.status !== 'present') {
        throw new Error(`release staging 要求 ${label} 资产存在，但状态为 ${asset?.status ?? 'missing'}`)
      }
    }
    await replaceDirectory(stagingDirectory, outputDirectory)
    stagingDirectory = null
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true })
  }

  console.log(`release staging written: ${outputDirectory}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runReleaseStaging()
}
