import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')

async function runNode(args: string[]) {
  return execFileAsync(process.execPath, args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024
  })
}

describe('v0.1.1 release hardening scripts', () => {
  it('导出脱敏诊断包且不包含 Secret、Prompt 或本地 Home 路径', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-diagnostics-'))
    try {
      const log = resolve(temporary, 'app.jsonl')
      const output = resolve(temporary, 'out')
      const windowsUserPath = 'C:\\Users\\Alice\\AppData\\Roaming\\DeepShell\\secrets.txt'
      const windowsDocumentPath = 'C:\\Users\\Alice\\Documents\\private.md'
      await writeFile(log, [
        '{"level":"error","authorization":"Bearer sk-1234567890abcdefghijklmnop","prompt":"' + 'x'.repeat(120) + '"}',
        '{"cookie":"session=secret-cookie","path":"' + process.env.HOME + '/Documents/private.md"}',
        '{"path":"' + windowsUserPath.replace(/\\/g, '\\\\') + '","message":"' + windowsDocumentPath.replace(/\\/g, '\\\\') + '"}'
      ].join('\n'))
      await runNode(['scripts/collect-diagnostics.mjs', '--log-file', log, '--output', output])

      const diagnostics = await readFile(resolve(output, 'diagnostics.json'), 'utf8')
      const redactedLog = await readFile(resolve(output, 'app-log.redacted.jsonl'), 'utf8')
      const combined = `${diagnostics}\n${redactedLog}`
      expect(combined).toContain('[REDACTED_SECRET]')
      expect(combined).toContain('[REDACTED_CONTENT]')
      expect(combined).not.toContain('secret-cookie')
      expect(combined).not.toContain('1234567890abcdefghijklmnop')
      if (process.env.HOME) expect(combined).not.toContain(process.env.HOME)
      expect(combined).not.toContain('C:\\\\Users\\\\Alice')
      expect(combined).not.toContain('AppData\\\\Roaming')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('生成 package report，且只包含聚合指标和 asset basename', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-report-'))
    try {
      const app = resolve(temporary, 'DeepShell Agent.app')
      const node = resolve(temporary, 'node')
      const dsh = resolve(temporary, 'dsh')
      const profile = resolve(temporary, 'profile')
      await mkdir(resolve(app, 'Contents'), { recursive: true })
      await mkdir(node)
      await mkdir(dsh)
      await mkdir(profile)
      await writeFile(resolve(app, 'Contents/file.txt'), 'app')
      await writeFile(resolve(node, 'node.txt'), 'node')
      await writeFile(resolve(dsh, 'dsh.txt'), 'dsh')
      await writeFile(resolve(profile, 'profile.txt'), 'profile')
      const dmg = resolve(temporary, 'fixture.dmg')
      const windowsInstaller = resolve(temporary, 'fixture.exe')
      const license = resolve(temporary, 'license-inventory.json')
      await writeFile(dmg, 'dmg')
      await writeFile(windowsInstaller, 'windows')
      await writeFile(license, '{"application":{"version":"0.1.1-test"}}\n')
      const output = resolve(temporary, 'release')

      await runNode([
        'scripts/collect-package-report.mjs',
        '--version', '0.1.1-test',
        '--output-dir', output,
        '--app', app,
        '--dmg', dmg,
        '--windows-installer', windowsInstaller,
        '--runtime-node', node,
        '--runtime-dsh', dsh,
        '--profile-template', profile,
        '--license-inventory', license
      ])

      const reportText = await readFile(resolve(output, 'package-report.json'), 'utf8')
      const report = JSON.parse(reportText)
      expect(report.assets.app.status).toBe('present')
      expect(report.assets.dmg.asset).toBe('fixture.dmg')
      expect(report.assets.windowsInstaller.asset).toBe('fixture.exe')
      expect(reportText).not.toContain(temporary)
      expect(reportText).not.toContain(root)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('生成 release staging 资产、SHA256SUMS 和本地 release notes 草稿', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-'))
    try {
      const dmg = resolve(temporary, 'source.dmg')
      const license = resolve(temporary, 'license.json')
      const sbom = resolve(temporary, 'sbom.json')
      const report = resolve(temporary, 'package-report.json')
      const security = resolve(temporary, 'security-audit.json')
      const windowsInstaller = resolve(temporary, 'source.exe')
      const output = resolve(temporary, 'release')
      await writeFile(dmg, 'dmg')
      await writeFile(windowsInstaller, 'windows')
      await writeFile(license, '{"application":{"version":"0.1.1-test"}}\n')
      await writeFile(sbom, '{"application":{"version":"0.1.1-test"}}\n')
      await writeFile(report, '{"application":{"version":"0.1.1-test"}}\n')
      await writeFile(security, '{"application":{"version":"0.1.1-test"}}\n')

      await runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.1-test',
        '--output-dir', output,
        '--dmg', dmg,
        '--windows-installer', windowsInstaller,
        '--license-inventory', license,
        '--sbom', sbom,
        '--package-report', report,
        '--security-audit', security
      ])

      const sums = await readFile(resolve(output, 'SHA256SUMS.txt'), 'utf8')
      const manifest = JSON.parse(await readFile(resolve(output, 'release-manifest.json'), 'utf8'))
      const notes = await readFile(resolve(output, 'RELEASE_NOTES.md'), 'utf8')
      expect(sums).toContain('DeepShell.Agent_0.1.1-test_aarch64.dmg')
      expect(sums).toContain('DeepShell.Agent_0.1.1-test_x64-setup.exe')
      expect(sums).toContain('deepshell-agent-v0.1.1-test-security-audit.json')
      expect(sums).not.toContain(temporary)
      expect(manifest.publishPolicy).toContain('explicit user authorization')
      expect(notes).toContain('Windows x64: route/checklist prepared')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('release staging 拒绝版本不一致的支持资产', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-mismatch-'))
    try {
      const dmg = resolve(temporary, 'source.dmg')
      const license = resolve(temporary, 'license.json')
      const sbom = resolve(temporary, 'sbom.json')
      const report = resolve(temporary, 'package-report.json')
      const output = resolve(temporary, 'release')
      await writeFile(dmg, 'dmg')
      await writeFile(license, '{"application":{"version":"0.1.0"}}\n')
      await writeFile(sbom, '{"application":{"version":"0.1.1-test"}}\n')
      await writeFile(report, '{"application":{"version":"0.1.1-test"}}\n')

      await expect(runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.1-test',
        '--output-dir', output,
        '--dmg', dmg,
        '--license-inventory', license,
        '--sbom', sbom,
        '--package-report', report
      ])).rejects.toThrow()
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('从 license inventory 派生 SBOM baseline', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-sbom-'))
    try {
      const inventory = resolve(temporary, 'license-inventory.json')
      const output = resolve(temporary, 'sbom.json')
      await writeFile(inventory, JSON.stringify({
        application: { name: 'DeepShell Agent', version: '0.1.1-test' },
        bundledNode: { version: '24.20.0' },
        bundledDshNpmPackages: [{ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1', license: 'MIT', installed: true }],
        directBuildAndTestNpmPackages: [],
        rustRegistryPackages: []
      }))
      await runNode(['scripts/generate-sbom.mjs', '--input', inventory, '--output', output, '--expected-version', '0.1.1-test'])
      const sbom = JSON.parse(await readFile(output, 'utf8'))
      expect(sbom.format).toBe('deepshell-sbom-baseline')
      expect(sbom.components.some((component: { name: string }) => component.name === '@deepseek-ai/dsh')).toBe(true)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('security audit dry-run 和 Windows route check 不产生伪通过', async () => {
    await runNode(['scripts/security-audit.mjs', '--dry-run'])
    await runNode(['scripts/verify-windows-route.mjs'])
    const audit = JSON.parse(await readFile(resolve(root, 'runtime/staging/security-audit.json'), 'utf8'))
    const windows = JSON.parse(await readFile(resolve(root, 'runtime/staging/windows-route-check.json'), 'utf8'))
    expect(audit.audits.every((item: { status: string }) => item.status === 'dry-run' || item.status === 'missing-runtime')).toBe(true)
    if (process.platform !== 'win32') {
      expect(windows.status).toBe('route-documented-current-platform-unable')
      expect(windows.validationPolicy).toContain('never count as Windows installer pass')
      expect(windows.checks.msvc.status).toBe('not-checked-current-platform')
    }
    expect(windows.commands).toContain('pnpm security:audit')
    expect(windows.commands.indexOf('pnpm security:audit')).toBeLessThan(windows.commands.indexOf('pnpm release:stage'))
  })
})
