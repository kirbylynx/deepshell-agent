import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      const windowsInstaller = resolve(temporary, 'DeepShell Agent_0.1.4_x64-setup.exe')
      const license = resolve(temporary, 'license-inventory.json')
      await writeFile(dmg, 'dmg')
      await writeFile(windowsInstaller, 'windows')
      await writeFile(license, '{"application":{"version":"0.1.4"}}\n')
      const output = resolve(temporary, 'release')

      await runNode([
        'scripts/collect-package-report.mjs',
        '--version', '0.1.4',
        '--output-dir', output,
        '--app', app,
        '--dmg', dmg,
        '--windows-installer', windowsInstaller,
        '--runtime-node', node,
        '--runtime-dsh', dsh,
        '--profile-template', profile,
        '--license-inventory', license,
        '--package-manifest', 'none',
        '--dmg-manifest', 'none',
        '--allow-missing-release-manifests'
      ])

      const reportText = await readFile(resolve(output, 'package-report.json'), 'utf8')
      const report = JSON.parse(reportText)
      expect(report.assets.app.status).toBe('present')
      expect(report.assets.dmg.asset).toBe('DeepShell Agent_0.1.4_aarch64.dmg')
      expect(report.assets.windowsInstaller.asset).toBe('DeepShell Agent_0.1.4_x64-setup.exe')
      expect(reportText).not.toContain(temporary)
      expect(reportText).not.toContain(root)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('package report 默认写 output 外路径，release staging 默认读取同一路径', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-report-stage-chain-'))
    const defaultPackageReport = resolve(root, 'runtime/staging/package-report.json')
    const staleReleaseReport = resolve(root, 'runtime/staging/release-v9.8.7/package-report.json')
    let originalReport: string | null = null
    try {
      try {
        originalReport = await readFile(defaultPackageReport, 'utf8')
      } catch {
        originalReport = null
      }
      await rm(resolve(root, 'runtime/staging/release-v9.8.7'), { recursive: true, force: true })
      const version = '9.8.7'
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
      const dmg = resolve(temporary, `DeepShell Agent_${version}_aarch64.dmg`)
      const windowsInstaller = resolve(temporary, `DeepShell Agent_${version}_x64-setup.exe`)
      const support = resolve(temporary, 'support.json')
      await writeFile(dmg, 'dmg')
      await writeFile(windowsInstaller, 'windows')
      await writeFile(support, `{"application":{"version":"${version}"}}\n`)
      await runNode([
        'scripts/collect-package-report.mjs',
        '--version', version,
        '--app', app,
        '--dmg', dmg,
        '--windows-installer', windowsInstaller,
        '--runtime-node', node,
        '--runtime-dsh', dsh,
        '--profile-template', profile,
        '--license-inventory', support,
        '--package-manifest', 'none',
        '--dmg-manifest', 'none',
        '--allow-missing-release-manifests'
      ])
      await expect(access(staleReleaseReport)).rejects.toThrow()

      const output = resolve(temporary, 'release')
      await runNode([
        'scripts/release-staging.mjs',
        '--version', version,
        '--output-dir', output,
        '--dmg', dmg,
        '--windows-installer', windowsInstaller,
        '--license-inventory', support,
        '--sbom', support,
        '--security-audit', support
      ])
      const stagedReport = await readFile(resolve(output, `deepshell-agent-v${version}-package-report.json`), 'utf8')
      const report = JSON.parse(stagedReport)
      expect(report.schemaVersion).toBe(2)
      expect(report.application.version).toBe(version)
    } finally {
      if (originalReport === null) {
        await rm(defaultPackageReport, { force: true })
      } else {
        await writeFile(defaultPackageReport, originalReport)
      }
      await rm(resolve(root, 'runtime/staging/release-v9.8.7'), { recursive: true, force: true })
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('生成 release staging 资产、SHA256SUMS 和本地 release notes 草稿', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-'))
    try {
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      const license = resolve(temporary, 'license.json')
      const sbom = resolve(temporary, 'sbom.json')
      const report = resolve(temporary, 'package-report.json')
      const security = resolve(temporary, 'security-audit.json')
      const windowsInstaller = resolve(temporary, 'DeepShell Agent_0.1.4_x64-setup.exe')
      const output = resolve(temporary, 'release')
      await writeFile(dmg, 'dmg')
      await writeFile(windowsInstaller, 'windows')
      await writeFile(license, '{"application":{"version":"0.1.4"}}\n')
      await writeFile(sbom, '{"application":{"version":"0.1.4"}}\n')
      await writeFile(report, '{"application":{"version":"0.1.4"}}\n')
      await writeFile(security, '{"application":{"version":"0.1.4"}}\n')

      await runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
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
      expect(sums).toContain('DeepShell.Agent_0.1.4_aarch64.dmg')
      expect(sums).toContain('DeepShell.Agent_0.1.4_x64-setup.exe')
      expect(sums).toContain('deepshell-agent-v0.1.4-security-audit.json')
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

  it('release staging 连续重跑会替换为新快照，且默认从 output 外读取 package report', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-rerun-'))
    const defaultPackageReport = resolve(root, 'runtime/staging/package-report.json')
    let originalReport: string | null = null
    try {
      try {
        originalReport = await readFile(defaultPackageReport, 'utf8')
      } catch {
        originalReport = null
      }
      const output = resolve(temporary, 'release')
      const license = resolve(temporary, 'license.json')
      const sbom = resolve(temporary, 'sbom.json')
      const security = resolve(temporary, 'security-audit.json')
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      const windowsInstaller = resolve(temporary, 'DeepShell Agent_0.1.4_x64-setup.exe')
      for (const path of [license, sbom, security]) {
        await writeFile(path, '{"application":{"version":"0.1.4"}}\n')
      }
      await writeFile(dmg, 'dmg')
      await writeFile(windowsInstaller, 'windows')
      await mkdir(resolve(root, 'runtime/staging'), { recursive: true })
      await runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
        '--output-dir', output,
        '--dmg', dmg,
        '--windows-installer', windowsInstaller,
        '--license-inventory', license,
        '--sbom', sbom,
        '--package-report', license,
        '--security-audit', security
      ])

      await writeFile(defaultPackageReport, '{"application":{"version":"0.1.4"},"source":"default-outside-output"}\n')
      const emptyDmgDirectory = resolve(temporary, 'dmg')
      const emptyInstallerDirectory = resolve(temporary, 'nsis')
      await mkdir(emptyDmgDirectory)
      await mkdir(emptyInstallerDirectory)
      await runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
        '--output-dir', output,
        '--dmg-dir', emptyDmgDirectory,
        '--windows-installer-dir', emptyInstallerDirectory,
        '--license-inventory', license,
        '--sbom', sbom,
        '--security-audit', security
      ])

      await expect(access(resolve(output, 'DeepShell.Agent_0.1.4_x64-setup.exe'))).rejects.toThrow()
      const copiedReport = await readFile(resolve(output, 'deepshell-agent-v0.1.4-package-report.json'), 'utf8')
      expect(copiedReport).toContain('"source":"default-outside-output"')
      const manifest = JSON.parse(await readFile(resolve(output, 'release-manifest.json'), 'utf8'))
      expect(manifest.assets.find((asset: { label: string }) => asset.label === 'windows-nsis').status).toBe('missing')
    } finally {
      if (originalReport === null) {
        await rm(defaultPackageReport, { force: true })
      } else {
        await writeFile(defaultPackageReport, originalReport)
      }
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('release staging 拒绝替换非专用非空目录和位于 output 内的显式输入', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-output-guard-'))
    try {
      const output = resolve(temporary, 'release')
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      const support = resolve(temporary, 'support.json')
      await mkdir(output)
      await writeFile(resolve(output, 'unrelated.txt'), 'do-not-delete')
      await writeFile(dmg, 'dmg')
      await writeFile(support, '{"application":{"version":"0.1.4"}}\n')

      await expect(runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
        '--output-dir', output,
        '--dmg', dmg,
        '--license-inventory', support,
        '--sbom', support,
        '--package-report', support,
        '--security-audit', support
      ])).rejects.toThrow(/缺少 release-manifest sentinel/)
      expect(await readFile(resolve(output, 'unrelated.txt'), 'utf8')).toBe('do-not-delete')

      const safeOutput = resolve(temporary, 'safe-release')
      await expect(runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
        '--output-dir', safeOutput,
        '--dmg', dmg,
        '--license-inventory', support,
        '--sbom', support,
        '--package-report', resolve(safeOutput, 'package-report.json'),
        '--security-audit', support
      ])).rejects.toThrow(/显式输入不能位于将被替换/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('release staging 新 output 提交后 backup 清理失败只警告并保留新快照', async () => {
    const { replaceDirectory } =
      // @ts-expect-error 该脚本是 CLI，同时导出少量 guard 供聚焦测试使用。
      await import('../../scripts/release-staging.mjs')
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-rollback-'))
    const warnings: string[] = []
    const originalWarn = console.warn
    try {
      const output = resolve(temporary, 'release')
      const staging = resolve(temporary, 'staging')
      await mkdir(output)
      await mkdir(staging)
      await writeFile(resolve(output, 'old.txt'), 'old-output')
      await writeFile(resolve(staging, 'new.txt'), 'new-output')
      console.warn = (message?: unknown) => { warnings.push(String(message)) }
      await replaceDirectory(staging, output, {
        exists: async (path: string) => access(path).then(() => true, () => false),
        rename,
        rm: async (path: string, options: { recursive?: boolean, force?: boolean }) => {
          if (path.includes('-previous-')) {
            await rm(resolve(path, 'old.txt'), { force: true })
            throw new Error('simulated partial backup cleanup failure')
          }
          return rm(path, options)
        },
      })
      expect(await readFile(resolve(output, 'new.txt'), 'utf8')).toBe('new-output')
      await expect(access(resolve(output, 'old.txt'))).rejects.toThrow()
      expect(warnings.join('\n')).toContain('backup cleanup failed')
      expect((await readdir(temporary)).some(entry => entry.includes('-previous-'))).toBe(true)
    } finally {
      console.warn = originalWarn
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('release staging 失败时保留既有正式目录，不留下半成品', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-failure-'))
    try {
      const output = resolve(temporary, 'release')
      const good = resolve(temporary, 'good.json')
      const bad = resolve(temporary, 'bad.json')
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      await writeFile(good, '{"application":{"version":"0.1.4"}}\n')
      await writeFile(bad, '{"application":{"version":"0.1.0"}}\n')
      await writeFile(dmg, 'dmg')
      await runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
        '--output-dir', output,
        '--dmg', dmg,
        '--license-inventory', good,
        '--sbom', good,
        '--package-report', good,
        '--security-audit', good
      ])
      await writeFile(resolve(output, 'KEEP.txt'), 'old-snapshot')

      await expect(runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
        '--output-dir', output,
        '--dmg', dmg,
        '--license-inventory', bad,
        '--sbom', good,
        '--package-report', good,
        '--security-audit', good
      ])).rejects.toThrow()

      expect(await readFile(resolve(output, 'KEEP.txt'), 'utf8')).toBe('old-snapshot')
      const manifest = JSON.parse(await readFile(resolve(output, 'release-manifest.json'), 'utf8'))
      expect(manifest.assets.find((asset: { label: string }) => asset.label === 'macos-dmg').status).toBe('present')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('release staging 拒绝版本不一致的支持资产', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-mismatch-'))
    try {
      const dmg = resolve(temporary, 'DeepShell Agent_0.1.4_aarch64.dmg')
      const license = resolve(temporary, 'license.json')
      const sbom = resolve(temporary, 'sbom.json')
      const report = resolve(temporary, 'package-report.json')
      const output = resolve(temporary, 'release')
      await writeFile(dmg, 'dmg')
      await writeFile(license, '{"application":{"version":"0.1.0"}}\n')
      await writeFile(sbom, '{"application":{"version":"0.1.4"}}\n')
      await writeFile(report, '{"application":{"version":"0.1.4"}}\n')

      await expect(runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
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

  it('release staging 拒绝显式传入旧版本或相近版本 installer', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-installer-version-'))
    try {
      const output = resolve(temporary, 'release')
      const wrongInstaller = resolve(temporary, 'DeepShell Agent_0.1.40_x64-setup.exe')
      await writeFile(wrongInstaller, 'windows')

      await expect(runNode([
        'scripts/release-staging.mjs',
        '--version', '0.1.4',
        '--output-dir', output,
        '--windows-installer', wrongInstaller,
      ])).rejects.toThrow(/版本不一致/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('release staging 自动发现时拒绝 old-only、错误产品名和错误架构资产', async () => {
    const cases = [
      ['old-only', 'DeepShell Agent_0.1.3_x64-setup.exe'],
      ['wrong-product', 'Other_0.1.4_x64-setup.exe'],
      ['wrong-arch', 'DeepShell Agent_0.1.4_arm64-setup.exe'],
    ] as const
    for (const [name, installerName] of cases) {
      const temporary = await mkdtemp(resolve(tmpdir(), `deepshell-stage-${name}-`))
      try {
        const dmgDirectory = resolve(temporary, 'dmg')
        const installerDirectory = resolve(temporary, 'nsis')
        await mkdir(dmgDirectory)
        await mkdir(installerDirectory)
        await writeFile(resolve(installerDirectory, installerName), 'windows')

        await expect(runNode([
          'scripts/release-staging.mjs',
          '--version', '0.1.4',
          '--output-dir', resolve(temporary, 'release'),
          '--dmg-dir', dmgDirectory,
          '--windows-installer-dir', installerDirectory,
        ])).rejects.toThrow(/未找到当前版本 0\.1\.4 的合法发布资产/)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  })

  it('release notes 与 manifest 的 Windows 验收说法必须与请求的版本语义一致', async () => {
    // 针对 F-001：`release-staging.mjs` 可用任意 `--version` 生成发布资料，若把某个版本的
    // 验收结论写死在脚本里，就会产出"v0.1.4 的标题 + 声明 v0.1.3 验收"的自相矛盾资料。
    // 本用例用**未登记验收的合成版本**驱动同一条路径，断言产物中不出现其它版本的说法。
    const synthetic = '9.9.9'
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-stage-version-'))
    try {
      const license = resolve(temporary, 'license.json')
      const sbom = resolve(temporary, 'sbom.json')
      const report = resolve(temporary, 'package-report.json')
      const security = resolve(temporary, 'security-audit.json')
      const windowsInstaller = resolve(temporary, 'DeepShell Agent_9.9.9_x64-setup.exe')
      const dmgDirectory = resolve(temporary, 'dmg')
      const output = resolve(temporary, 'release')
      await mkdir(dmgDirectory)
      await writeFile(windowsInstaller, 'windows')
      for (const path of [license, sbom, report, security]) {
        await writeFile(path, `{"application":{"version":"${synthetic}"}}\n`)
      }

      await runNode([
        'scripts/release-staging.mjs',
        '--version', synthetic,
        '--output-dir', output,
        '--dmg-dir', dmgDirectory,
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

  it('baseline 捕获拒绝源码/配置漂移和 rename/copy 任一异常端，但构建后允许明确生成目录和产物路径', async () => {
    // @ts-expect-error 该脚本是 CLI，同时导出少量 guard 供聚焦测试使用。
    const { parseBaselineStatusEntries, unexpectedBaselineStatusEntries } = await import('../../scripts/capture-package-baseline.mjs')
    const renamedIntoGenerated = parseBaselineStatusEntries(
      Buffer.from('R  dist/generated.js\0src-tauri/tauri.conf.json\0')
    )
    const typeChanges = parseBaselineStatusEntries(
      Buffer.from('T  src-tauri/Cargo.toml\0 T src-tauri/build.rs\0')
    )
    expect(unexpectedBaselineStatusEntries([
      '?? src-tauri/tauri.macos.conf.json',
      '!! src-tauri/local.secret',
      ...renamedIntoGenerated,
      ...typeChanges,
    ])).toEqual([
      '?? src-tauri/tauri.macos.conf.json',
      '!! src-tauri/local.secret',
      'R  dist/generated.js\0src-tauri/tauri.conf.json',
      'T  src-tauri/Cargo.toml',
      ' T src-tauri/build.rs',
    ])
    expect(unexpectedBaselineStatusEntries([
      ' M src-tauri/gen/schemas/desktop-schema.json',
      '?? src-tauri/target/release/bundle/macos/DeepShell Agent.app/Contents/MacOS/deepshell-agent',
      '!! dist/index.html',
      '!! runtime/node/win32-x64/node.exe',
      '!! runtime/dsh/node_modules/@deepseek-ai/dsh/package.json',
      '?? artifacts/manual.dmg',
    ], ['artifacts/manual.dmg'])).toEqual([])
  })

  it('baseline 初始检查拒绝已有生成残留，并锁定 install/rebuild command', async () => {
    const { baselineInstallCommand, baselineRebuildCommand, unexpectedInitialBaselineStatusEntries } =
      // @ts-expect-error 该脚本是 CLI，同时导出少量 guard 供聚焦测试使用。
      await import('../../scripts/capture-package-baseline.mjs')
    expect(baselineInstallCommand('pnpm')).toEqual({ command: 'pnpm', args: ['install', '--frozen-lockfile'] })
    expect(baselineRebuildCommand('pnpm')).toEqual({ command: 'pnpm', args: ['package:verified'] })
    expect(unexpectedInitialBaselineStatusEntries([
      '!! node_modules/.pnpm/lock.yaml',
      '!! dist/index.html',
      '?? runtime/node/win32-x64/node.exe',
      '?? src-tauri/target/release/deepshell-agent',
    ])).toEqual([
      '!! node_modules/.pnpm/lock.yaml',
      '!! dist/index.html',
      '?? runtime/node/win32-x64/node.exe',
      '?? src-tauri/target/release/deepshell-agent',
    ])
  })

  it('baseline 捕获只接受固定 release 产物路径，并强制写当前 canonical fixture', async () => {
    const { assertCanonicalBaselineCapturePaths, canonicalBaselineArtifactPaths } =
      // @ts-expect-error 该脚本是 CLI，同时导出少量 guard 供聚焦测试使用。
      await import('../../scripts/capture-package-baseline.mjs')
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-baseline-paths-'))
    try {
      const canonical = canonicalBaselineArtifactPaths(temporary)
      const output = resolve(root, 'tests/fixtures/package-size-baselines/v0.1.3.json')
      expect(() => assertCanonicalBaselineCapturePaths(temporary, {
        ...canonical,
        output,
      }, {
        canonicalOutput: output,
      })).not.toThrow()
      expect(() => assertCanonicalBaselineCapturePaths(temporary, {
        ...canonical,
        app: resolve(temporary, 'old-artifacts/DeepShell Agent.app'),
        output,
      })).toThrow(/package:verified.*固定 release 产物路径/)
      expect(() => assertCanonicalBaselineCapturePaths(temporary, {
        ...canonical,
        output: resolve(temporary, 'baseline.tmp.json'),
      }, {
        canonicalOutput: output,
      })).toThrow(/必须写入当前 canonical fixture/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('baseline 捕获拒绝 app Info.plist 版本漂移或缺失主二进制名', async () => {
    // @ts-expect-error 该脚本是 CLI，同时导出少量 guard 供聚焦测试使用。
    const { assertBaselineAppInfoPlist } = await import('../../scripts/capture-package-baseline.mjs')
    const valid = [
      '<plist><dict>',
      '<key>CFBundleShortVersionString</key><string>0.1.3</string>',
      '<key>CFBundleExecutable</key><string>DeepShell Agent</string>',
      '</dict></plist>',
    ].join('')
    expect(assertBaselineAppInfoPlist(valid)).toEqual({ version: '0.1.3', executable: 'DeepShell Agent' })
    expect(() => assertBaselineAppInfoPlist(valid.replace('0.1.3', '0.1.4'))).toThrow(/Info\.plist 版本不一致/)
    expect(() => assertBaselineAppInfoPlist(valid.replace('<key>CFBundleExecutable</key><string>DeepShell Agent</string>', ''))).toThrow(/CFBundleExecutable/)
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

  it('Windows release workflow 在构建前固定获取并断言 canonical v0.1.3 tag', async () => {
    const workflow = await readFile(resolve(root, '.github/workflows/windows-release.yml'), 'utf8')
    const canonicalCommit = 'ca4add9dc52c5053278570abb28e1d21ae5a0239'
    const checkoutIndex = workflow.indexOf('uses: actions/checkout@v4')
    const tagVerifyIndex = workflow.indexOf('name: Verify canonical v0.1.3 baseline tag')
    const packageIndex = workflow.indexOf('name: Package NSIS installer')

    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(tagVerifyIndex).toBeGreaterThan(checkoutIndex)
    expect(packageIndex).toBeGreaterThan(tagVerifyIndex)
    expect(workflow).toMatch(/fetch-depth:\s*0/)
    expect(workflow).toMatch(/fetch-tags:\s*true/)
    expect(workflow).toContain("git ls-remote --tags origin 'refs/tags/v0.1.3^{}'")
    expect(workflow).toContain("'+refs/tags/v0.1.3:refs/tags/v0.1.3'")
    expect(workflow).toContain("git rev-parse 'v0.1.3^{commit}'")
    expect(workflow).toContain('$remotePeeled =')
    expect(workflow).toContain('$actual =')
    expect(workflow).toContain('.Trim()')
    expect(workflow).toContain('$LASTEXITCODE')
    expect(workflow).toContain(canonicalCommit)
  })

  it('README 双语准确描述 Windows package:mvp 当前边界', async () => {
    const [english, chinese, packageScript] = await Promise.all([
      readFile(resolve(root, 'README.md'), 'utf8'),
      readFile(resolve(root, 'README.zh.md'), 'utf8'),
      readFile(resolve(root, 'scripts/package-mvp.mjs'), 'utf8'),
    ])

    const windowsPackageBranch = packageScript.slice(
      packageScript.indexOf("} else if (process.platform === 'win32') {"),
      packageScript.indexOf('} else {'),
    )
    expect(windowsPackageBranch).toContain("['scripts/capture-package-manifest.mjs', 'release', 'nsis-installer']")
    expect(windowsPackageBranch).toContain("['scripts/compare-e2e-release.mjs']")
    expect(windowsPackageBranch).not.toMatch(/\['scripts\/compare-e2e-release\.mjs',\s*'--require-artifacts'\]/)

    const englishWindowsSection = english.slice(
      english.indexOf('### Windows x64 build'),
      english.indexOf('### Common development commands'),
    )
    const chineseWindowsSection = chinese.slice(
      chinese.indexOf('### Windows x64 构建'),
      chinese.indexOf('### 常用开发命令'),
    )

    expect(englishWindowsSection).toContain('release NSIS package manifest')
    expect(englishWindowsSection).toContain('static security-boundary checks')
    expect(englishWindowsSection).toContain('does not run the macOS-only E2E/Release artifact comparison on Windows')
    expect(englishWindowsSection).not.toContain('runs the E2E/Release security-boundary comparison')
    expect(chineseWindowsSection).toContain('release NSIS 产物清单')
    expect(chineseWindowsSection).toContain('静态安全边界检查')
    expect(chineseWindowsSection).toContain('不会在 Windows 上执行仅属于 macOS 路线的 E2E/Release 产物比较')
    expect(chineseWindowsSection).not.toContain('执行 E2E/Release 安全边界比较')
  })
})
