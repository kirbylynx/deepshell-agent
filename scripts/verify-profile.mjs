import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readLock, root } from './lib/runtime.mjs'

const bundleFiles = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml']
const desktopBundle = '@deepshell-agent/dsh-desktop'

async function bundleFingerprint(directory) {
  const hash = createHash('sha256')
  for (const file of bundleFiles) {
    hash.update(file)
    hash.update(await readFile(resolve(directory, file)))
  }
  return hash.digest('hex')
}

const template = resolve(root, 'runtime/profile-template')
const profile = resolve(template, 'profiles/web')
const bundledPlugin = resolve(profile, 'node_modules/@deepshell-agent/dsh-desktop')
const lock = await readLock()
const presetIds = ['deepshell-coding', 'deepshell-work', 'deepshell-general', 'deepshell']

const manifest = JSON.parse(await readFile(resolve(template, 'template-manifest.json'), 'utf8'))
if (
  manifest.schemaVersion !== 1 ||
  manifest.profile !== 'web' ||
  manifest.dshVersion !== lock.dsh.version ||
  manifest.desktopBundle !== desktopBundle ||
  manifest.defaultAgentPresetId !== 'deepshell-coding' ||
  JSON.stringify(manifest.legacyAgentPresetIds) !== JSON.stringify(['deepshell'])
) {
  throw new Error('Profile 模板清单与 runtime lock 不一致')
}
if (manifest.bundleFingerprint !== await bundleFingerprint(bundledPlugin)) {
  throw new Error('Profile 模板清单与实际 DeepShell Bundle 内容不一致')
}
const upstreamPreset = await readFile(resolve(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml'), 'utf8')
const rowIds = content => [...content.matchAll(/^- id:\s*([^\s]+)\s*$/gm)].map(match => match[1])
const upstreamIds = rowIds(upstreamPreset)
if (!upstreamIds.includes('tool-web')) throw new Error('官方 standard Preset 缺少 tool-web')
if (manifest.agentPresetSourceSha256 !== createHash('sha256').update(upstreamPreset).digest('hex')) {
  throw new Error('DeepShell Agent Preset 来源与官方 standard 不一致')
}
for (const presetId of presetIds) {
  const preset = resolve(template, '.agent-presets', presetId)
  const derivedPreset = await readFile(resolve(preset, 'agent.cordis.yml'), 'utf8')
  const derivedIds = rowIds(derivedPreset)
  if (JSON.stringify(derivedIds) !== JSON.stringify(upstreamIds)) {
    throw new Error(`${presetId} 必须保持 official standard 的顶层插件集合`)
  }
  const expectedFingerprint = createHash('sha256').update(derivedPreset).digest('hex')
  if (manifest.agentPresets?.[presetId]?.source !== 'official-standard' || manifest.agentPresets?.[presetId]?.fingerprint !== expectedFingerprint) {
    throw new Error(`${presetId} Preset 指纹不一致`)
  }
}

const profilePackage = JSON.parse(await readFile(resolve(profile, 'package.json'), 'utf8'))
if (profilePackage.dependencies?.[desktopBundle] !== manifest.desktopBundleVersion) {
  throw new Error('Profile 中的 DeepShell Bundle 版本未精确锁定')
}

const patch = await readFile(resolve(bundledPlugin, 'cordis.patch.yml'), 'utf8')
if (!/id:\s*session-telemetry-otel[\s\S]*?disabled:\s*true/.test(patch)) {
  throw new Error('Profile 未禁用 session telemetry')
}
for (const required of ['web-search-deepseek', 'web-fetch-http', 'tool-web']) {
  const expression = new RegExp(`id:\\s*${required}[\\s\\S]*?disabled:\\s*true`)
  if (expression.test(patch)) throw new Error(`MVP Profile 不允许禁用 ${required}`)
}
if (!/id:\s*agent-presets[\s\S]*?default:\s*deepshell-coding/.test(patch)) {
  throw new Error('Profile 未把默认 Agent Preset 固定为 deepshell-coding')
}

const forbiddenRoots = [root, process.cwd()].filter((value, index, values) => values.indexOf(value) === index)
async function verifyTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`Profile 不允许包含符号链接：${relative(template, path)}`)
    if (stat.isDirectory()) {
      await verifyTree(path)
      continue
    }
    const content = await readFile(path)
    const text = content.toString('utf8')
    for (const forbidden of forbiddenRoots) {
      if (text.includes(forbidden)) throw new Error(`Profile 含构建机绝对路径：${relative(template, path)}`)
    }
  }
}

await verifyTree(template)
console.log('profile template verified')
