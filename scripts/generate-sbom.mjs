import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { root } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const inventory = await optionalJson(resolve(root, 'runtime/staging/license-inventory.json')) ??
  await optionalJson(resolve(root, 'docs/plans/v0.1.0-mvp/evidence/licenses.json'))
if (inventory === null) throw new Error('缺少 license inventory，请先运行 pnpm licenses:collect')

const components = [
  {
    name: inventory.application.name,
    version: inventory.application.version,
    type: 'application',
    license: 'MIT',
    scope: 'root'
  },
  {
    name: 'Bundled Node.js',
    version: inventory.bundledNode.version,
    type: 'runtime',
    license: 'Node.js bundled licenses',
    scope: 'bundled-runtime'
  },
  ...(inventory.bundledDshNpmPackages ?? []).map(pkg => ({
    name: pkg.name,
    version: pkg.version,
    type: 'npm',
    license: pkg.license ?? 'UNDECLARED',
    scope: 'bundled-dsh-runtime',
    optional: pkg.optional === true,
    installed: pkg.installed === true
  })),
  ...(inventory.directBuildAndTestNpmPackages ?? []).map(pkg => ({
    name: pkg.name,
    version: pkg.version,
    type: 'npm',
    license: pkg.license ?? 'UNDECLARED',
    scope: pkg.scope
  })),
  ...(inventory.rustRegistryPackages ?? []).map(pkg => ({
    name: pkg.name,
    version: pkg.version,
    type: 'cargo',
    license: pkg.license ?? 'UNDECLARED',
    scope: 'tauri-runtime'
  }))
].sort((left, right) => `${left.type}:${left.name}:${left.version}`.localeCompare(`${right.type}:${right.name}:${right.version}`))

const sbom = {
  schemaVersion: 1,
  format: 'deepshell-sbom-baseline',
  generatedAt: new Date().toISOString(),
  application: inventory.application,
  source: 'license-inventory',
  componentCount: components.length,
  components,
  notes: [
    'Baseline SBOM for release review automation.',
    'This is not legal advice and can later be expanded to SPDX or CycloneDX.'
  ]
}
await mkdir(resolve(root, 'runtime/staging'), { recursive: true })
await writeFile(resolve(root, 'runtime/staging/sbom.json'), redactedJson(sbom))
console.log(`SBOM baseline written: ${components.length} components`)
