import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
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

const dryRun = process.argv.includes('--dry-run')

// F-1505-WR001：输出路径必须可显式隔离。
// - 正式非 dry-run 审计默认写 runtime/staging/security-audit.json（正式证据）；
// - 测试与脚本集成一律通过 `--output <临时路径>` 隔离；
// - dry-run 默认**不落盘**（只打印 JSON），避免覆盖正式审计证据。
const explicitOutput = commandLineValue('--output')
const outputPath = resolve(root, explicitOutput ?? 'runtime/staging/security-audit.json')

// npmmirror 等镜像不实现 npm audit 端点（ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS），
// 必须显式使用官方 registry 的 advisory 数据；CI 默认 registry 即官方，行为一致。
// 如需自建审计源，可用 DEEPSHELL_AUDIT_REGISTRY 覆盖（仅影响 audit 查询）。
const auditRegistry = process.env.DEEPSHELL_AUDIT_REGISTRY ?? 'https://registry.npmjs.org/'

// Windows 上 pnpm/npm 都是 `.cmd` 批处理，而 Node 出于安全考虑（CVE-2024-27980）
// 拒绝在未启用 shell 时启动 `.cmd`/`.bat`——`spawn` 与 `execFile` 均报 `spawn EINVAL`。
// 因此经 `cmd.exe /d /s /c` 启动；**不使用** `shell: true`，避免参数拼接引发的 DEP0190。
// Unix 上两者都是可执行脚本，走原路径。
function execPlan(command, args) {
  if (process.platform === 'win32' && command.endsWith('.cmd')) {
    return ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
  }
  return [command, args]
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function parseAuditJson(text, label) {
  // 成功与异常退出共用解析边界：空输出不能被补成 {} 后误判为零漏洞。
  if (!String(text ?? '').trim()) {
    return {
      status: 'completed-unparseable',
      error: { code: 'empty-output', summary: '审计命令没有输出任何 JSON 结果' },
      vulnerabilities: {}
    }
  }
  try {
    const json = JSON.parse(text)
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('无效审计对象')
    if (json.error) {
      return {
        status: 'audit-error',
        error: {
          code: json.error.code ?? 'unknown',
          summary: json.error.summary ?? 'audit failed'
        },
        vulnerabilities: {}
      }
    }
    const vulnerabilities = json.metadata?.vulnerabilities ?? json.vulnerabilities
    // 可解析 JSON 不等于审计报告：拒绝 {}、任意对象及缺少正式漏洞摘要的结果。
    const hasCounts = vulnerabilities && ['info', 'low', 'moderate', 'high', 'critical']
      .every(key => Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] >= 0)
    const hasRustSummary = label === 'rust' && vulnerabilities
      && typeof vulnerabilities.found === 'boolean'
      && Number.isSafeInteger(vulnerabilities.count) && vulnerabilities.count >= 0
      && Array.isArray(vulnerabilities.list)
      && vulnerabilities.count === vulnerabilities.list.length
      && vulnerabilities.found === (vulnerabilities.count > 0)
    if (label === 'rust' ? !hasRustSummary : !hasCounts) throw new Error('缺少有效审计摘要')
    const advisories = Object.entries(json.advisories ?? {}).map(([id, advisory]) => ({
      id,
      module: advisory.module_name ?? advisory.name ?? 'unknown',
      severity: advisory.severity ?? 'unknown',
      title: advisory.title ?? advisory.overview ?? 'untitled advisory',
      patchedVersions: advisory.patched_versions ?? advisory.patchedVersions ?? 'unknown',
      paths: (advisory.findings ?? [])
        .flatMap((finding) => finding.paths ?? [])
        .slice(0, 5)
    }))
    return {
      status: 'completed',
      vulnerabilities,
      advisories
    }
  } catch {
    return { status: 'completed-unparseable', vulnerabilities: {} }
  }
}

async function runAudit(label, command, args, options = {}) {
  if (dryRun) return { label, status: 'dry-run', command: [command, ...args].join(' ') }
  try {
    const { stdout } = await execFileAsync(...execPlan(command, args), { ...options, maxBuffer: 64 * 1024 * 1024 })
    return { label, ...parseAuditJson(stdout, label) }
  } catch (error) {
    if (error.code === 'ENOENT') return { label, status: 'tool-missing', install: label === 'rust' ? 'cargo install cargo-audit' : undefined }
    const stderr = String(error.stderr ?? '')
    if (label === 'rust' && /no such command:\s*`audit`|no such command:\s*'audit'|no such command:\s+"audit"/i.test(stderr)) {
      return { label, status: 'tool-missing', install: 'cargo install cargo-audit' }
    }
    // ⚠️ 审计命令**根本没启动**时（如 Windows 上直接 spawn `.cmd` 报 `EINVAL`），
    // 旧解析逻辑会把空 stdout 补成 {} 并形成 completed + 零漏洞的假通过。
    // 这类失败必须如实报为 failed，不得参与任何 gate 判定。
    // 只有明确的数字退出码才可解析漏洞报告；超时/信号终止也不能形成已完成审计。
    if (typeof error.code !== 'number' || error.killed || error.signal) {
      return { label, status: 'failed', error: { code: error.code ?? 'process-interrupted', summary: String(error.message ?? '').split('\n')[0] } }
    }
    const parsed = parseAuditJson(error.stdout, label)
    return { label, ...parsed, exitCode: error.code ?? 1 }
  }
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const audits = [
  await runAudit('node-root-production', pnpm, ['audit', '--prod', '--json', '--registry', auditRegistry], { cwd: root }),
  await runAudit('node-root-all', pnpm, ['audit', '--json', '--registry', auditRegistry], { cwd: root }),
]
if (await exists(resolve(root, 'runtime/manifest/dsh-install/package-lock.json'))) {
  audits.push(await runAudit('dsh-runtime', npm, ['audit', '--json', '--omit', 'dev', '--registry', auditRegistry], { cwd: resolve(root, 'runtime/manifest/dsh-install') }))
} else {
  audits.push({ label: 'dsh-runtime', status: 'missing-lockfile' })
}
audits.push(await runAudit('rust', 'cargo', ['audit', '--json'], { cwd: resolve(root, 'src-tauri') }))

const criticalCount = audits.reduce((sum, item) => {
  const value = item.vulnerabilities?.critical
  return sum + (Number.isFinite(value) ? value : 0)
}, 0)
// cargo-audit 使用 found/count/list，而不是 npm 的 critical 等级计数。
// 在没有可靠的 Rust 严重度分类器之前，任何 Rust 漏洞都必须阻断并人工审查，不能当成零漏洞。
const rustVulnerabilityCount = audits.find(item => item.label === 'rust')?.vulnerabilities?.count ?? 0
// F-1505-WR001：顶层 status 只有在**全部子审计真实执行完成**时才允许是 completed。
// 任何 dry-run/tool-missing/failed/audit-error/completed-unparseable/missing-lockfile
// 都必须体现为 incomplete，且非 dry-run 运行时返回非零退出码（fail closed）。
const incompleteAudits = audits.filter((item) => item.status !== 'completed')
const status = dryRun
  ? 'dry-run'
  : criticalCount > 0
    ? 'fail-critical'
    : rustVulnerabilityCount > 0
      ? 'fail-rust-review'
      : incompleteAudits.length > 0 ? 'incomplete' : 'completed'
const report = {
  schemaVersion: 1,
  application: { name: 'DeepShell Agent', version: pkg.version },
  generatedAt: new Date().toISOString(),
  status,
  gatePolicy: {
    critical: 'failure',
    high: 'warning unless runtime code execution, credential leak, or sandbox bypass',
    medium: 'warning',
    low: 'informational',
    rust: 'any vulnerability fails pending manual severity and runtime-impact review'
  },
  auditRegistry,
  audits,
  knownExceptions: [
    {
      scope: 'node-root-all',
      status: 'non-blocking-warning',
      note: 'Root all-dependency audit includes development and test toolchain dependencies. Release runtime risk should be judged together with node-root-production, dsh-runtime, rust, and package boundary comparison.'
    }
  ]
}
const serialized = redactedJson(report)
if (dryRun && explicitOutput === null) {
  process.stdout.write(serialized)
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized)
  console.log(`security audit written: ${outputPath} (${status})`)
}

if (!dryRun) {
  const failures = []
  if (criticalCount > 0) failures.push(`critical vulnerabilities: ${criticalCount}`)
  if (rustVulnerabilityCount > 0) failures.push(`Rust vulnerabilities require review: ${rustVulnerabilityCount}`)
  for (const item of incompleteAudits) failures.push(`${item.label}: ${item.status}`)
  if (failures.length > 0) {
    console.error(`security audit failed (fail closed): ${failures.join('; ')}`)
    process.exitCode = 1
  }
}
