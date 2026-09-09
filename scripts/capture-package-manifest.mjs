import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { relative, resolve } from 'node:path'
import { root } from './lib/runtime.mjs'
import { deterministicInputDigest } from './lib/source-inputs.mjs'

const mode = process.argv[2]
if (!['e2e', 'release'].includes(mode)) throw new Error('用法：capture-package-manifest.mjs <e2e|release>')

const execFileAsync = promisify(execFile)
const app = resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')
const resources = resolve(app, 'Contents/Resources')
const binary = resolve(app, 'Contents/MacOS/deepshell-agent')

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

const featureArgs = mode === 'e2e' ? ['--features', 'poc-e2e'] : []
const [
  { stdout: strings },
  { stdout: cargoMetadata },
  { stdout: cargoFeatureTree },
  { stdout: linkedLibraries },
  signing,
  entitlements,
  config,
  capability,
  profileManifest,
  infoPlist
] = await Promise.all([
  execFileAsync('/usr/bin/strings', [binary], { maxBuffer: 64 * 1024 * 1024 }),
  execFileAsync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', resolve(root, 'src-tauri/Cargo.toml')], { maxBuffer: 64 * 1024 * 1024 }).then(result => result),
  execFileAsync('cargo', ['tree', '--locked', '--manifest-path', resolve(root, 'src-tauri/Cargo.toml'), '-e', 'features', ...featureArgs], { maxBuffer: 64 * 1024 * 1024 }),
  execFileAsync('/usr/bin/otool', ['-L', binary], { maxBuffer: 4 * 1024 * 1024 }),
  execFileAsync('/usr/bin/codesign', ['-dvvv', app]).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' })),
  execFileAsync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', binary]).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' })),
  readFile(resolve(root, 'src-tauri/tauri.conf.json')),
  readFile(resolve(root, 'src-tauri/capabilities/main.json')),
  readFile(resolve(resources, 'runtime/profile-template/template-manifest.json')),
  readFile(resolve(app, 'Contents/Info.plist')),
])
const [cargoToml, cargoLock, sourceInputSha256] = await Promise.all([
  readFile(resolve(root, 'src-tauri/Cargo.toml')),
  readFile(resolve(root, 'src-tauri/Cargo.lock')),
  deterministicInputDigest(root),
])

const manifest = {
  schemaVersion: 3,
  mode,
  buildProfile: strings.includes('deepshell-build-profile:poc-e2e')
    ? 'poc-e2e'
    : strings.includes('deepshell-build-profile:release') ? 'release' : 'unknown',
  configSha256: digest(config),
  capabilitySha256: digest(capability),
  profileManifestSha256: digest(profileManifest),
  infoPlistSha256: digest(infoPlist),
  cargoTomlSha256: digest(cargoToml),
  cargoLockSha256: digest(cargoLock),
  cargoMetadataSha256: digest(cargoMetadata),
  cargoFeatureTreeSha256: digest(cargoFeatureTree),
  cargoFeatureTreeHasWebdriver: cargoFeatureTree.includes('tauri-plugin-wdio-webdriver'),
  sourceInputSha256,
  webdriverMarker: strings.includes('deepshell-build-profile:poc-e2e'),
  e2eStopCommandMarker: strings.includes('poc_e2e_stop_runtime'),
  linkedLibraries: linkedLibraries.trim().split('\n').slice(1).map(line => line.trim()).sort(),
  signing: {
    adhoc: `${signing.stdout}${signing.stderr}`.includes('Signature=adhoc'),
    identifier: /Identifier=com\.deepshell\.agent/.test(`${signing.stdout}${signing.stderr}`),
    entitlementsSha256: digest(`${entitlements.stdout}${entitlements.stderr}`.replace(/^Executable=.*$/m, ''))
  },
  configSources: ['src-tauri/tauri.conf.json'],
  resources: await fileManifest(resources),
}
if (manifest.buildProfile !== (mode === 'e2e' ? 'poc-e2e' : 'release')) {
  throw new Error(`实际 binary build profile 与 ${mode} 清单不一致`)
}
const outputDirectory = resolve(root, 'runtime/staging')
await mkdir(outputDirectory, { recursive: true })
await writeFile(resolve(outputDirectory, `package-${mode}.json`), JSON.stringify(manifest, null, 2) + '\n')
console.log(`${mode} package manifest captured`)
