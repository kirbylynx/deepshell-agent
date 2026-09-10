import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { currentRuntimePlatform, nodeExecutablePath, readLock, root } from './lib/runtime.mjs'

const bundleFiles = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml']
const desktopBundle = '@deepshell-agent/dsh-desktop'
const desktopBundlePath = resolve(root, 'dsh/bundles/deepshell-desktop')
const agentPresets = [
  {
    id: 'deepshell-coding',
    name: 'DeepShell Coding',
    description: '基于官方 standard Preset 的 Coding Mode；保留官方 tool-web、凭据与 workspace-write 权限语义。'
  },
  {
    id: 'deepshell-work',
    name: 'DeepShell Work',
    description: '基于官方 standard Preset 的 Work Mode；MVP 聚焦 Web research 与本地文本/Markdown 文件任务。'
  },
  {
    id: 'deepshell-general',
    name: 'DeepShell General',
    description: '基于官方 standard Preset 的 General Mode；用于通用问答、本地任务和轻量研究入口。'
  },
  {
    id: 'deepshell',
    name: 'DeepShell Coding (Legacy)',
    description: '兼容 v0.0.1 POC 旧会话的 Preset ID；配置与 DeepShell Coding 同源，默认新会话不再使用。',
    legacy: true
  }
]

async function bundleFingerprint(directory) {
  const hash = createHash('sha256')
  for (const file of bundleFiles) {
    hash.update(file)
    hash.update(await readFile(resolve(directory, file)))
  }
  return hash.digest('hex')
}

function run(executable, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`profile command 退出码 ${code}`)))
  })
}

const lock = await readLock()
const node = nodeExecutablePath(lock, currentRuntimePlatform())
const entry = resolve(root, 'runtime/dsh', lock.dsh.entry)
const target = resolve(root, 'runtime/profile-template')
const staging = await mkdtemp(resolve(tmpdir(), 'deepshell-profile-'))
const bootstrapWorkspace = resolve(staging, 'bootstrap-workspace')
await mkdir(bootstrapWorkspace, { recursive: true })

try {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    DSH_HOME: staging,
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_CLIENT_TITLE: 'DeepShell Agent'
  }
  await run(node, [entry, 'plugin', '--profile', 'web', 'add', desktopBundlePath], { cwd: bootstrapWorkspace, env })
  await rm(resolve(staging, '.credentials.yaml'), { force: true })
  const upstreamPresetPath = resolve(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml')
  const upstreamPreset = await readFile(upstreamPresetPath, 'utf8')
  if (!/^- id:\s*tool-web\s*$/m.test(upstreamPreset)) {
    throw new Error('官方 standard Agent Preset 缺少 tool-web，无法满足 MVP Web Search/Fetch 契约')
  }
  const presetFingerprints = {}
  for (const [index, preset] of agentPresets.entries()) {
    const presetTarget = resolve(staging, '.agent-presets', preset.id)
    await mkdir(presetTarget, { recursive: true })
    await writeFile(resolve(presetTarget, 'agent.cordis.yml'), upstreamPreset, { mode: 0o600 })
    await writeFile(resolve(presetTarget, 'preset.yml'), [
      `name: ${preset.name}`,
      `description: ${preset.description}`,
      `order: ${preset.legacy ? 99 : index}`,
      ''
    ].join('\n'), { mode: 0o600 })
    presetFingerprints[preset.id] = createHash('sha256').update(upstreamPreset).digest('hex')
  }
  const bundlePackage = JSON.parse(await readFile(resolve(desktopBundlePath, 'package.json'), 'utf8'))
  if (bundlePackage.name !== desktopBundle) throw new Error('DeepShell Desktop Bundle 包名不一致')
  const fingerprint = await bundleFingerprint(desktopBundlePath)
  await writeFile(resolve(staging, 'template-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    dshVersion: lock.dsh.version,
    profile: 'web',
    desktopBundle,
    desktopBundleVersion: bundlePackage.version,
    bundleFingerprint: fingerprint,
    defaultAgentPresetId: 'deepshell-coding',
    legacyAgentPresetIds: agentPresets.filter(preset => preset.legacy).map(preset => preset.id),
    agentPresetSourceSha256: createHash('sha256').update(upstreamPreset).digest('hex'),
    agentPresets: Object.fromEntries(agentPresets.map(preset => [preset.id, {
      source: 'official-standard',
      fingerprint: presetFingerprints[preset.id]
    }]))
  }, null, 2) + '\n', { mode: 0o644 })
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(staging, target, { recursive: true, dereference: true })
  await rm(staging, { recursive: true, force: true })
  const profilePackagePath = resolve(target, 'profiles/web/package.json')
  const profilePackage = JSON.parse(await readFile(profilePackagePath, 'utf8'))
  profilePackage.dependencies ??= {}
  delete profilePackage.dependencies?.['@deepshell-agent/dsh-poc']
  profilePackage.dependencies[desktopBundle] = bundlePackage.version
  await writeFile(profilePackagePath, JSON.stringify(profilePackage, null, 2) + '\n')
  for (const generated of [
    'profiles/web/pnpm-lock.yaml',
    'profiles/web/pnpm-workspace.yaml',
    'profiles/web/node_modules/.modules.yaml',
    'profiles/web/node_modules/.pnpm/lock.yaml',
    'profiles/web/node_modules/.pnpm-workspace-state-v1.json'
  ]) await rm(resolve(target, generated), { force: true })
  console.log('relocatable web profile template prepared')
} catch (error) {
  await rm(staging, { recursive: true, force: true })
  throw error
}
