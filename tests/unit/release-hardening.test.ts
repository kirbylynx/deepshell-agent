import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
        '--license-inventory', license,
        '--package-manifest', 'none',
        '--dmg-manifest', 'none'
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
      // 断言 notes 的**结构**而非具体措辞：此前这里写死了当时的 Windows 状态文案
      // （'Windows x64: route/checklist prepared'），导致 `release-staging.mjs` 更新该文案后
      // 测试立即断裂——而那次改动本身是正确的（v0.1.3 已完成真机验收）。
      // 产品文案会随验收进展变化，测试应当锁定"notes 必须存在状态章节、且必须交代 Windows x64 情况"
      // 这一不变式，而不是锁定某一句话。
      expect(notes).toContain('## Distribution status')
      expect(notes).toContain('Windows x64:')
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

  it('release notes 与 manifest 的 Windows 验收说法必须与请求的版本语义一致', async () => {
    // 针对 F-001：`release-staging.mjs` 可用任意 `--version` 生成发布资料，若把某个版本的
    // 验收结论写死在脚本里，就会产出"v0.1.4 的标题 + 声明 v0.1.3 验收"的自相矛盾资料。
    // 本用例用**未登记验收的合成版本**驱动同一条路径，断言产物中不出现其它版本的说法。
    const synthetic = '0.1.4-test'
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-version-'))
    try {
      const license = resolve(temporary, 'license.json')
      const sbom = resolve(temporary, 'sbom.json')
      const report = resolve(temporary, 'package-report.json')
      const security = resolve(temporary, 'security-audit.json')
      const windowsInstaller = resolve(temporary, 'source.exe')
      const output = resolve(temporary, 'release')
      await writeFile(windowsInstaller, 'windows')
      for (const path of [license, sbom, report, security]) {
        await writeFile(path, `{"application":{"version":"${synthetic}"}}\n`)
      }

      await runNode([
        'scripts/release-staging.mjs',
        '--version', synthetic,
        '--output-dir', output,
        '--windows-installer', windowsInstaller,
        '--license-inventory', license,
        '--sbom', sbom,
        '--package-report', report,
        '--security-audit', security
      ])

      const notes = await readFile(resolve(output, 'RELEASE_NOTES.md'), 'utf8')
      const manifest = JSON.parse(await readFile(resolve(output, 'release-manifest.json'), 'utf8'))

      // ① notes 与 manifest 的版本必须是请求的版本
      expect(notes).toContain(`# DeepShell Agent v${synthetic} Developer Preview`)
      expect(manifest.application.version).toBe(synthetic)

      // ② 合成版本没有任何验收记录 → 必须如实声明缺失，且**不得**出现别的版本号
      //    针对 F-002：机器可读状态必须是稳定枚举，人类可读措辞另置 summary 字段。
      expect(manifest.windowsStatusCode).toBe('not-recorded-for-this-version')
      expect(typeof manifest.windowsStatusSummary).toBe('string')
      expect(manifest.windowsAcceptanceRecord).toBeNull()
      expect(notes).toContain('no Windows on-device acceptance is recorded for this version')
      expect(notes).not.toContain('v0.1.3')
      expect(JSON.stringify(manifest)).not.toContain('v0.1.3')

      // ③ 已登记版本必须给出存在且版本匹配的验收记录路径
      const { acceptanceFor, WindowsStatusCode, windowsStatusCodes, windowsManifestFields } =
        await import('../../scripts/lib/windows-acceptance.mjs')
      const recorded = acceptanceFor('0.1.3')
      expect(recorded.recorded).toBe(true)
      if (recorded.recorded) {
        expect(recorded.record).toContain('0.1.3')
        await access(resolve(root, recorded.record))
      }

      // ④ 针对 F-002：状态码必须是**已知枚举**，不得退化为自由文本。
      //    任何新状态都必须先加入 WindowsStatusCode，从而强制一次有意识的契约变更。
      const accepted = windowsManifestFields('0.1.3')
      expect(windowsStatusCodes).toContain(accepted.windowsStatusCode)
      expect(accepted.windowsStatusCode).toBe(WindowsStatusCode.AcceptedOnDevice)
      expect(windowsStatusCodes).toContain(manifest.windowsStatusCode)
      // 状态码本身不含空格等自然语言特征，避免机器契约再次被文案污染
      expect(accepted.windowsStatusCode).not.toMatch(/\s/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('验收记录没有遗留缺陷时必须输出专门文案，而不是空列表占位', async () => {
    // 针对 F-003：缺陷列表为空时，原实现用 `map().join(', ')` 渲染，会产出
    // `… Known unfixed defects ship with this version: .` —— 冒号后直接跟句点。
    // 本用例注入一个"已验收且无遗留缺陷"的版本，断言走专门文案。
    const { windowsAcceptance, windowsNotesLine } =
      await import('../../scripts/lib/windows-acceptance.mjs')
    const injected = '9.9.9-test'
    expect(windowsAcceptance[injected]).toBeUndefined()
    windowsAcceptance[injected] = {
      record: 'docs/releases/v9.9.9.md',
      scope: 'all scenarios passed; no deferred defects',
      unfixed: []
    }
    try {
      const line = windowsNotesLine(injected)
      expect(line).toContain('none for this version')
      expect(line).not.toMatch(/:\s*\./) // 不得出现 ": ."
      expect(line).not.toMatch(/version:\s*\./)
      // 有遗留缺陷时仍须逐个列出，避免"修空列表"把正常路径也改坏
      const withDefects = windowsNotesLine('0.1.3')
      expect(withDefects).toContain('REL-022')
      expect(withDefects).toContain('DESK-023')
    } finally {
      delete windowsAcceptance[injected]
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
        bundledDshNpmPackages: [{ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1', license: 'MIT', installed: true }],
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
