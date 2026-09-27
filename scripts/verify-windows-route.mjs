import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { root } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'

const execFileAsync = promisify(execFile)

// 解析 `--name <value>` / `--name=<value>` 形式的命令行取值；缺失取值立即报错。
function commandLineValue(name) {
  const argv = process.argv.slice(2)
  const inline = argv.find(value => value.startsWith(`${name}=`))
  if (inline !== undefined) {
    const value = inline.slice(name.length + 1)
    if (!value) throw new Error(`${name} 缺少取值`)
    return value
  }
  const index = argv.indexOf(name)
  if (index >= 0) {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少取值`)
    return value
  }
  return null
}

// F-1505-WR002：输出路径必须可显式隔离。
// 正式 route check（无 --output）写 runtime/staging/windows-route-check.json；
// 测试与脚本集成通过 `--output <临时路径>` 隔离，不得覆盖正式证据。
const explicitOutput = commandLineValue('--output')
const outputPath = resolve(root, explicitOutput ?? 'runtime/staging/windows-route-check.json')

// 探测命令是否存在并取一行版本信息。
// 约束：Node 出于安全考虑（CVE-2024-27980）拒绝在未启用 shell 时启动 .cmd/.bat，
// 在 Windows 上会以 spawn EINVAL 失败，而 pnpm 正是 pnpm.cmd。此处**不使用 shell: true**
// —— 那会触发 DEP0190 安全警告。改为经 `cmd.exe /d /s /c` 启动批处理；命令名是硬编码
// 常量、参数为固定量，不存在注入输入，故构造命令行是安全的。
// 存在性统一由 `where.exe` 判定，从而不依赖各命令自身的退出码约定
// （例如 `cl.exe /?` 返回 2，若按退出码判定会被误报为 missing）。
async function probeCommand(command, args = ['--version']) {
  const isWindows = process.platform === 'win32'
  const isWindowsBatch = isWindows && /\.(cmd|bat)$/i.test(command)
  const comSpec = process.env.ComSpec ?? 'cmd.exe'
  const run = async (executable, runArgs) => {
    try {
      const { stdout, stderr } = await execFileAsync(executable, runArgs, { timeout: 15_000 })
      return { ok: true, output: `${stdout}${stderr}`.trim() }
    } catch (error) {
      return { ok: false, message: error.code === 'ENOENT' ? 'command not found' : error.message }
    }
  }

  if (isWindows) {
    const located = await run(comSpec, ['/d', '/s', '/c', 'where.exe', command])
    if (!located.ok || !located.output) return { status: 'missing', message: 'command not found' }
  }

  const result = isWindowsBatch
    ? await run(comSpec, ['/d', '/s', '/c', [command, ...args].join(' ')])
    : await run(command, args)
  if (!result.ok) return { status: 'missing', message: result.message }
  const line = result.output.split(/\r?\n/).find(value => value.trim().length > 0) ?? ''
  return { status: 'present', output: line }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function runExecutable(executable, args, timeout = 15_000) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout })
    return { ok: true, output: `${stdout}${stderr}`.trim() }
  } catch (error) {
    return { ok: false, message: error.code === 'ENOENT' ? 'executable not found' : error.message }
  }
}

// 在 Visual Studio 安装目录的 VC/Tools/MSVC/<版本> 下寻找 MSVC 编译器（x64 优先）。
async function findMsvcCompiler(installationPath, detection) {
  const toolsRoot = resolve(installationPath, 'VC/Tools/MSVC')
  let versions
  try {
    versions = await readdir(toolsRoot)
  } catch {
    return null
  }
  for (const version of versions.sort().reverse()) {
    for (const host of ['Hostx64/x64', 'Hostx86/x64']) {
      const cl = resolve(toolsRoot, version, 'bin', host, 'cl.exe')
      if (await exists(cl)) {
        return { status: 'present', detection, installationPath, toolset: version, cl }
      }
    }
  }
  return null
}

// F-1505-WR002：MSVC 检测不得只看当前 shell 的 PATH。
// 普通 PowerShell 没有 Developer 环境（cl.exe 不在 PATH），但 Visual Studio / Build Tools
// 可能已经安装；必须通过 vswhere（Visual Studio 安装器官方接口）与标准安装路径继续确认，
// 也不能在都找不到时无条件判通过——最后如实记为 missing。
async function msvcCheck() {
  if (process.platform !== 'win32') return { status: 'not-checked-current-platform' }

  // ① 当前 PATH：Developer PowerShell / vcvars 环境
  const onPath = await probeCommand('cl.exe', [])
  if (onPath.status === 'present') {
    return { status: 'present', detection: 'path', output: onPath.output }
  }

  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'
  const programFiles = process.env.ProgramFiles ?? 'C:/Program Files'

  // ② vswhere：标准 Visual Studio 安装信息（含 Build Tools）
  const vswhere = resolve(programFilesX86, 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (await exists(vswhere)) {
    const queried = await runExecutable(vswhere, [
      '-latest', '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath'
    ])
    if (queried.ok) {
      const installation = queried.output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0]
      if (installation) {
        const found = await findMsvcCompiler(installation, 'vswhere')
        if (found) return found
      }
    }
  }

  // ③ 标准安装路径扫描：vswhere 不可用时仍可判定（VS 2019/2022 各 edition / BuildTools）
  for (const base of [programFilesX86, programFiles]) {
    const visualStudio = resolve(base, 'Microsoft Visual Studio')
    let years
    try {
      years = await readdir(visualStudio)
    } catch {
      continue
    }
    for (const year of years.sort().reverse()) {
      if (!/^\d{4}$/.test(year)) continue
      const yearRoot = resolve(visualStudio, year)
      let editions
      try {
        editions = await readdir(yearRoot)
      } catch {
        continue
      }
      for (const edition of editions) {
        const found = await findMsvcCompiler(resolve(yearRoot, edition), 'standard-install-path')
        if (found) return found
      }
    }
  }

  return {
    status: 'missing',
    message: '未在 PATH、vswhere 或 Visual Studio 标准安装路径中找到 MSVC cl.exe'
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
  pnpm: await probeCommand(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
  rustc: await probeCommand('rustc'),
  cargo: await probeCommand('cargo'),
  msvc: await msvcCheck(),
  webview2: await webview2Runtime(),
}
const commands = [
  'pnpm install --frozen-lockfile',
  'pnpm runtime:prepare --target all',
  'pnpm runtime:verify --target all',
  'pnpm profile:prepare',
  'pnpm profile:verify',
  'pnpm package:mvp',
  'pnpm security:audit',
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
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, redactedJson(result))

if (checks.platform.status !== 'pass') {
  console.log(`Windows 打包路线待验证：当前是 ${process.platform}-${process.arch}，需要 Windows x64 环境。`)
  console.log(`后续 Windows 环境执行：${commands.join(' && ')}`)
} else if (result.status === 'windows-preflight-pass') {
  console.log('Windows x64 打包路线前置检查完成，可继续执行 pnpm package:mvp。')
} else {
  console.log('Windows x64 打包路线已记录，但前置检查不完整；请先补齐缺失工具或运行 Tauri 打包暴露具体环境错误。')
}

// F-1505-WR002：Windows 正式检查不是 pass 时必须 fail closed（非零退出码），
// 停止交接链路——不得在 incomplete 状态下继续生成最终回传包。
if (process.platform === 'win32' && result.status !== 'windows-preflight-pass') {
  const missing = Object.entries(checks)
    .filter(([, value]) => value.status !== 'present' && value.status !== 'pass')
    .map(([name, value]) => `${name}:${value.status}`)
  console.error(`Windows preflight incomplete（fail closed）：${missing.join(', ')}；报告：${outputPath}`)
  process.exitCode = 1
}
