import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { root } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'

const execFileAsync = promisify(execFile)

async function commandVersion(command, args = ['--version']) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 15_000 })
    return { status: 'present', output: `${stdout}${stderr}`.trim().split(/\r?\n/)[0] ?? '' }
  } catch (error) {
    return { status: 'missing', message: error.code === 'ENOENT' ? 'command not found' : error.message }
  }
}

async function registryValuePresent(key, valueName) {
  try {
    const { stdout, stderr } = await execFileAsync('reg.exe', ['query', key, '/v', valueName], { timeout: 15_000 })
    return `${stdout}${stderr}`.includes('REG_')
  } catch {
    return false
  }
}

async function webview2Runtime() {
  if (process.platform !== 'win32') return { status: 'not-checked-current-platform' }
  const applicationDirectories = [
    resolve(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/EdgeWebView/Application'),
    resolve(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/EdgeWebView/Application'),
    process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Microsoft/EdgeWebView/Application') : null
  ].filter(Boolean)
  const candidates = []
  for (const directory of applicationDirectories) {
    candidates.push(resolve(directory, 'msedgewebview2.exe'))
    try {
      const children = await readdir(directory, { withFileTypes: true })
      for (const child of children) {
        if (child.isDirectory()) candidates.push(resolve(directory, child.name, 'msedgewebview2.exe'))
      }
    } catch {
      // 没有该目录时继续检查其他标准安装位置。
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return { status: 'present' }
    } catch {
      // 继续检查下一个候选路径。
    }
  }
  if (await registryValuePresent('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv')) return { status: 'present' }
  if (await registryValuePresent('HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv')) return { status: 'present' }
  return { status: 'missing', message: 'Microsoft Edge WebView2 Runtime was not found in standard install paths or registry locations' }
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const checks = {
  platform: process.platform === 'win32' && process.arch === 'x64'
    ? { status: 'pass', current: `${process.platform}-${process.arch}` }
    : { status: 'unable-current-platform', current: `${process.platform}-${process.arch}`, required: 'win32-x64' },
  pnpm: await commandVersion(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
  rustc: await commandVersion('rustc'),
  cargo: await commandVersion('cargo'),
  msvc: process.platform === 'win32'
    ? await commandVersion('cl.exe', ['/?'])
    : { status: 'not-checked-current-platform' },
  webview2: await webview2Runtime(),
}
const commands = [
  'pnpm install --frozen-lockfile',
  'pnpm runtime:prepare --target all',
  'pnpm runtime:verify --target all',
  'pnpm profile:prepare',
  'pnpm profile:verify',
  'pnpm package:mvp',
  'pnpm release:stage'
]
const result = {
  schemaVersion: 1,
  application: { name: 'DeepShell Agent', version: pkg.version },
  route: 'windows-x64',
  status: checks.platform.status === 'pass' &&
    checks.pnpm.status === 'present' &&
    checks.rustc.status === 'present' &&
    checks.cargo.status === 'present' &&
    checks.msvc.status === 'present' &&
    checks.webview2.status === 'present'
    ? 'windows-preflight-pass'
    : checks.platform.status === 'pass' ? 'windows-preflight-incomplete' : 'route-documented-current-platform-unable',
  checks,
  requiredEnvironment: [
    'Windows 11 x64',
    'Microsoft Edge WebView2 Runtime',
    'Rust stable MSVC toolchain',
    'Visual Studio Build Tools / MSVC C++ build tools',
    'Node.js and pnpm for build hosts only',
    'Git',
    'PowerShell 7 or Windows PowerShell'
  ],
  commands,
  validationPolicy: 'macOS route checks never count as Windows installer pass'
}
const outputDirectory = resolve(root, 'runtime/staging')
await mkdir(outputDirectory, { recursive: true })
await writeFile(resolve(outputDirectory, 'windows-route-check.json'), redactedJson(result))
if (checks.platform.status !== 'pass') {
  console.log(`Windows 打包路线待验证：当前是 ${process.platform}-${process.arch}，需要 Windows x64 环境。`)
  console.log(`后续 Windows 环境执行：${commands.join(' && ')}`)
} else if (result.status === 'windows-preflight-pass') {
  console.log('Windows x64 打包路线前置检查完成，可继续执行 pnpm package:mvp。')
} else {
  console.log('Windows x64 打包路线已记录，但前置检查不完整；请先补齐缺失工具或运行 Tauri 打包暴露具体环境错误。')
}
