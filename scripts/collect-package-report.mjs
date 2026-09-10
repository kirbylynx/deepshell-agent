import { access, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import { root } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'

function argValue(name, fallback) {
  const prefix = `${name}=`
  const inline = process.argv.find(value => value.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function directoryMetrics(path) {
  if (!await exists(path)) return { status: 'missing' }
  let bytes = 0
  let files = 0
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        const info = await stat(full)
        bytes += info.size
        files += 1
      }
    }
  }
  await walk(path)
  return { status: 'present', bytes, files }
}

async function fileMetric(path) {
  if (!await exists(path)) return { status: 'missing', asset: basename(path) }
  const info = await stat(path)
  return { status: 'present', asset: basename(path), bytes: info.size }
}

async function newestByExtension(directory, extension) {
  if (!await exists(directory)) return null
  const files = (await readdir(directory)).filter(file => extname(file).toLowerCase() === extension).sort()
  return files.length === 0 ? null : resolve(directory, files.at(-1))
}

async function newestDmg() {
  return newestByExtension(resolve(root, 'src-tauri/target/release/bundle/dmg'), '.dmg')
}

async function newestWindowsInstaller() {
  return newestByExtension(resolve(root, 'src-tauri/target/release/bundle/nsis'), '.exe')
}

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const version = argValue('--version', pkg.version)
const outputDirectory = resolve(argValue('--output-dir', resolve(root, 'runtime/staging', `release-v${version}`)))
await mkdir(outputDirectory, { recursive: true })
const appPath = resolve(argValue('--app', resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')))
const dmgArg = argValue('--dmg', undefined)
const explicitDmg = dmgArg !== undefined
const dmg = dmgArg === undefined ? await newestDmg() : resolve(dmgArg)
const windowsInstallerArg = argValue('--windows-installer', undefined)
const explicitWindowsInstaller = windowsInstallerArg !== undefined
const windowsInstaller = windowsInstallerArg === undefined ? await newestWindowsInstaller() : resolve(windowsInstallerArg)
const dmgMetric = async () => {
  if (dmg === null) return { status: 'missing' }
  if (!explicitDmg && !basename(dmg).includes(version)) {
    return { status: 'stale-version', asset: basename(dmg), expectedVersion: version }
  }
  return fileMetric(dmg)
}
const windowsInstallerMetric = async () => {
  if (windowsInstaller === null) return { status: 'missing' }
  if (!explicitWindowsInstaller && !basename(windowsInstaller).includes(version)) {
    return { status: 'stale-version', asset: basename(windowsInstaller), expectedVersion: version }
  }
  return fileMetric(windowsInstaller)
}
const licenseInventory = await optionalJson(resolve(root, 'runtime/staging/license-inventory.json')) ??
  await optionalJson(resolve(root, 'docs/plans/v0.1.0-mvp/evidence/licenses.json'))
const releaseManifest = await optionalJson(resolve(root, 'runtime/staging/package-release.json'))
const report = {
  schemaVersion: 1,
  application: { name: 'DeepShell Agent', version },
  generatedAt: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch },
  assets: {
    app: await directoryMetrics(appPath),
    dmg: await dmgMetric(),
    windowsInstaller: await windowsInstallerMetric(),
    runtimeNode: await directoryMetrics(resolve(argValue('--runtime-node', resolve(root, 'runtime/node')))),
    runtimeDsh: await directoryMetrics(resolve(argValue('--runtime-dsh', resolve(root, 'runtime/dsh')))),
    profileTemplate: await directoryMetrics(resolve(argValue('--profile-template', resolve(root, 'runtime/profile-template')))),
  },
  manifests: {
    releasePackageManifest: releaseManifest === null ? { status: 'missing' } : {
      status: 'present',
      resourceCount: Array.isArray(releaseManifest.resources) ? releaseManifest.resources.length : 0
    },
    licenseInventory: licenseInventory === null ? { status: 'missing' } : {
      status: 'present',
      bundledDshNpmPackages: licenseInventory.bundledDshNpmPackages?.length ?? 0,
      directBuildAndTestNpmPackages: licenseInventory.directBuildAndTestNpmPackages?.length ?? 0,
      rustRegistryPackages: licenseInventory.rustRegistryPackages?.length ?? 0
    }
  },
  privacy: {
    pathPolicy: 'only aggregate metrics and asset basenames are recorded',
    rootRelativeOnly: true
  }
}
if (JSON.stringify(report).includes(root) || JSON.stringify(report).includes(relative('/', root))) {
  throw new Error('package report 包含本地绝对路径')
}
const output = resolve(outputDirectory, 'package-report.json')
await writeFile(output, redactedJson(report))
console.log(`package report written: ${output}`)
