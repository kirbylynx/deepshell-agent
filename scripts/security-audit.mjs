import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { root } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'

const execFileAsync = promisify(execFile)
const dryRun = process.argv.includes('--dry-run')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function parseAuditJson(text) {
  try {
    const json = JSON.parse(text || '{}')
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
    const vulnerabilities = json.metadata?.vulnerabilities ?? json.vulnerabilities ?? {}
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
    const { stdout } = await execFileAsync(command, args, { ...options, maxBuffer: 64 * 1024 * 1024 })
    return { label, ...parseAuditJson(stdout) }
  } catch (error) {
    if (error.code === 'ENOENT') return { label, status: 'tool-missing', install: label === 'rust' ? 'cargo install cargo-audit' : undefined }
    const stderr = String(error.stderr ?? '')
    if (label === 'rust' && /no such command:\s*`audit`|no such command:\s*'audit'|no such command:\s+"audit"/i.test(stderr)) {
      return { label, status: 'tool-missing', install: 'cargo install cargo-audit' }
    }
    const parsed = parseAuditJson(String(error.stdout ?? ''))
    return { label, ...parsed, exitCode: error.code ?? 1 }
  }
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const audits = [
  await runAudit('node-root-production', pnpm, ['audit', '--prod', '--json'], { cwd: root }),
  await runAudit('node-root-all', pnpm, ['audit', '--json'], { cwd: root }),
]
if (await exists(resolve(root, 'runtime/manifest/dsh-install/package-lock.json'))) {
  audits.push(await runAudit('dsh-runtime', npm, ['audit', '--json', '--omit', 'dev'], { cwd: resolve(root, 'runtime/manifest/dsh-install') }))
} else {
  audits.push({ label: 'dsh-runtime', status: 'missing-lockfile' })
}
audits.push(await runAudit('rust', 'cargo', ['audit', '--json'], { cwd: resolve(root, 'src-tauri') }))

const criticalCount = audits.reduce((sum, item) => {
  const value = item.vulnerabilities?.critical
  return sum + (Number.isFinite(value) ? value : 0)
}, 0)
const report = {
  schemaVersion: 1,
  application: { name: 'DeepShell Agent', version: pkg.version },
  generatedAt: new Date().toISOString(),
  status: criticalCount > 0 ? 'fail-critical' : 'completed',
  gatePolicy: {
    critical: 'failure',
    high: 'warning unless runtime code execution, credential leak, or sandbox bypass',
    medium: 'warning',
    low: 'informational'
  },
  audits,
  knownExceptions: [
    {
      scope: 'node-root-all',
      status: 'non-blocking-warning',
      note: 'Root all-dependency audit includes development and test toolchain dependencies. Release runtime risk should be judged together with node-root-production, dsh-runtime, rust, and package boundary comparison.'
    }
  ]
}
await mkdir(resolve(root, 'runtime/staging'), { recursive: true })
await writeFile(resolve(root, 'runtime/staging/security-audit.json'), redactedJson(report))
console.log(`security audit written: ${report.status}`)
if (criticalCount > 0) process.exitCode = 1
