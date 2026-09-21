import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  deterministicInputDigest,
  gitRevisionInputDigest,
  platformSourceInputs,
  v013BaselineSourceInputs,
  v014BaselineSourceInputs,
} from '../../scripts/lib/source-inputs.mjs'

const execFileAsync = promisify(execFile)
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EXPECTED_V013_COMMIT = 'ca4add9dc52c5053278570abb28e1d21ae5a0239'

describe('构建输入指纹', () => {
  it('任意被纳入的生命周期源码变化都会使旧指纹失效', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-inputs-'))
    try {
      await mkdir(resolve(temporary, 'src-tauri/src'), { recursive: true })
      const state = resolve(temporary, 'src-tauri/src/app_state.rs')
      await writeFile(state, 'const STATE: &str = "before";\n')
      const before = await deterministicInputDigest(temporary, ['src-tauri/src'])

      await writeFile(state, 'const STATE: &str = "after";\n')
      const after = await deterministicInputDigest(temporary, ['src-tauri/src'])

      expect(after).not.toBe(before)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('DSH 安装 lock 与 Rust toolchain 都属于构建输入', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-build-inputs-'))
    try {
      await mkdir(resolve(temporary, 'runtime/manifest/dsh-install'), { recursive: true })
      await writeFile(resolve(temporary, 'runtime/manifest/dsh-install/package-lock.json'), '{"lockfileVersion":3}\n')
      await writeFile(resolve(temporary, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.96.0"\n')
      const inputs = ['runtime/manifest/dsh-install/package-lock.json', 'rust-toolchain.toml']
      const before = await deterministicInputDigest(temporary, inputs)

      await writeFile(resolve(temporary, 'runtime/manifest/dsh-install/package-lock.json'), '{"lockfileVersion":4}\n')
      const afterLockChange = await deterministicInputDigest(temporary, inputs)
      await writeFile(resolve(temporary, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.97.0"\n')
      const afterToolchainChange = await deterministicInputDigest(temporary, inputs)

      expect(afterLockChange).not.toBe(before)
      expect(afterToolchainChange).not.toBe(afterLockChange)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('当前平台 digest 包含 tracked baseline，而冻结的 v0.1.3 输入排除它', () => {
    const fixture = 'tests/fixtures/package-size-baselines/v0.1.3.json'
    expect(platformSourceInputs['darwin-arm64']).toContain('tests')
    expect(platformSourceInputs['win32-x64']).toContain('tests')
    expect(platformSourceInputs['darwin-arm64']).toContain('patches')
    expect(platformSourceInputs['win32-x64']).toContain('patches')
    expect(v013BaselineSourceInputs).not.toContain('patches')
    expect(v013BaselineSourceInputs).not.toContain(fixture)
    expect(platformSourceInputs['darwin-arm64']).toContain('src-tauri/tauri.macos.conf.json')
    expect(platformSourceInputs['win32-x64']).toContain('src-tauri/tauri.windows.conf.json')
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/lib/package-manifest.mjs')
    expect(platformSourceInputs['win32-x64']).toContain('scripts/lib/package-manifest.mjs')
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/lib/package-report-mode.mjs')
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/lib/runtime-acceptance.mjs')
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/benchmark-sea-runtime.mjs')
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/collect-sea-on-device.mjs')
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/test-sea-external-plugin.mjs')
    expect(platformSourceInputs['win32-x64']).toContain('scripts/collect-sea-on-device.mjs')
    expect(platformSourceInputs['win32-x64']).toContain('scripts/test-sea-external-plugin.mjs')
    expect(platformSourceInputs['win32-x64']).toContain('scripts/lib/package-report-mode.mjs')
    for (const declaration of [
      'scripts/lib/artifact-selection.d.mts',
      'scripts/lib/package-manifest.d.mts',
      'scripts/lib/package-report-mode.d.mts',
      'scripts/lib/package-platform.d.mts',
      'scripts/lib/package-size.d.mts',
      'scripts/lib/process-plan.d.mts',
      'scripts/lib/source-inputs.d.mts',
      'scripts/lib/tree-manifest.d.mts',
      'scripts/lib/windows-acceptance.d.mts',
    ]) {
      expect(platformSourceInputs['darwin-arm64']).toContain(declaration)
      expect(platformSourceInputs['win32-x64']).toContain(declaration)
    }
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/run-e2e.mjs')
    expect(platformSourceInputs['darwin-arm64']).toContain('wdio.conf.ts')
    expect(platformSourceInputs['win32-x64']).not.toContain('scripts/run-e2e.mjs')
    expect(platformSourceInputs['win32-x64']).not.toContain('wdio.conf.ts')
    expect(platformSourceInputs['darwin-arm64']).toContain('scripts/lib/windows-acceptance.mjs')
    expect(platformSourceInputs['win32-x64']).toContain('scripts/lib/windows-acceptance.mjs')
  })

  it('v0.1.4 baseline 输入集合保持冻结且可从 tag 重算', async () => {
    expect(v014BaselineSourceInputs).not.toContain('patches')
    expect(v014BaselineSourceInputs).not.toContain('scripts/prepare-sea-runtime.mjs')
    expect(v014BaselineSourceInputs).not.toContain('scripts/benchmark-sea-runtime.mjs')
    await expect(gitRevisionInputDigest(
      workspace,
      'refs/tags/v0.1.4',
      v014BaselineSourceInputs,
    )).resolves.toBe('83d29f18d03c4629a287b0335e265f3313b2b43b38fc021551c370c4ed478b00')
  }, 30_000)

  it('平台专属输入的 digest 变化只影响对应平台输入集', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-platform-inputs-'))
    try {
      await writeFile(resolve(temporary, 'shared.txt'), 'shared\n')
      await writeFile(resolve(temporary, 'mac.txt'), 'mac-before\n')
      await writeFile(resolve(temporary, 'win.txt'), 'win-before\n')
      const macInputs = ['shared.txt', 'mac.txt']
      const winInputs = ['shared.txt', 'win.txt']
      const macBefore = await deterministicInputDigest(temporary, macInputs)
      const winBefore = await deterministicInputDigest(temporary, winInputs)

      await writeFile(resolve(temporary, 'mac.txt'), 'mac-after\n')
      const macAfter = await deterministicInputDigest(temporary, macInputs)
      const winAfterMacChange = await deterministicInputDigest(temporary, winInputs)
      await writeFile(resolve(temporary, 'win.txt'), 'win-after\n')
      const winAfter = await deterministicInputDigest(temporary, winInputs)

      expect(macAfter).not.toBe(macBefore)
      expect(winAfterMacChange).toBe(winBefore)
      expect(winAfter).not.toBe(winBefore)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('共享声明文件变化会同时影响两平台 digest', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-declaration-inputs-'))
    try {
      await writeFile(resolve(temporary, 'shared.d.mts'), 'export const value: string\n')
      await writeFile(resolve(temporary, 'mac-only.ts'), 'export const platform = "mac"\n')
      await writeFile(resolve(temporary, 'win-only.ts'), 'export const platform = "win"\n')
      const macInputs = ['shared.d.mts', 'mac-only.ts']
      const winInputs = ['shared.d.mts', 'win-only.ts']
      const macBefore = await deterministicInputDigest(temporary, macInputs)
      const winBefore = await deterministicInputDigest(temporary, winInputs)

      await writeFile(resolve(temporary, 'shared.d.mts'), 'export const value: number\n')
      const macAfter = await deterministicInputDigest(temporary, macInputs)
      const winAfter = await deterministicInputDigest(temporary, winInputs)

      expect(macAfter).not.toBe(macBefore)
      expect(winAfter).not.toBe(winBefore)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('冻结的 v0.1.3 Git blob 输入可重算并匹配 tracked fixture', async () => {
    const fixture = JSON.parse(await readFile(resolve(workspace, 'tests/fixtures/package-size-baselines/v0.1.3.json'), 'utf8'))
    const { stdout: liveCommit } = await execFileAsync('git', ['rev-parse', 'v0.1.3^{commit}'], { cwd: workspace })
    expect(liveCommit.trim()).toBe(EXPECTED_V013_COMMIT)
    expect(fixture.canonicalSource.peeledCommit).toBe(EXPECTED_V013_COMMIT)
    const digest = await gitRevisionInputDigest(workspace, 'v0.1.3^{commit}', v013BaselineSourceInputs)
    expect(digest).toBe(fixture.canonicalSource.baselineSourceInputSha256)
  }, 15_000)

  it('Git blob baseline digest 不受 working tree LF/CRLF 转换影响', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-git-inputs-'))
    try {
      await execFileAsync('git', ['init'], { cwd: temporary })
      await execFileAsync('git', ['config', 'user.name', 'DeepShell Test'], { cwd: temporary })
      await execFileAsync('git', ['config', 'user.email', 'test@deepshell.invalid'], { cwd: temporary })
      await writeFile(resolve(temporary, 'input.txt'), 'first\nsecond\n')
      await execFileAsync('git', ['add', 'input.txt'], { cwd: temporary })
      await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: temporary })
      const blobDigest = await gitRevisionInputDigest(temporary, 'HEAD', ['input.txt'])
      const workingLf = await deterministicInputDigest(temporary, ['input.txt'])

      await writeFile(resolve(temporary, 'input.txt'), 'first\r\nsecond\r\n')
      const workingCrlf = await deterministicInputDigest(temporary, ['input.txt'])
      const blobDigestAfter = await gitRevisionInputDigest(temporary, 'HEAD', ['input.txt'])

      expect(workingCrlf).toBe(workingLf)
      expect(blobDigestAfter).toBe(blobDigest)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('无 NUL 的非法 UTF-8 二进制差异不会被规范化吞掉', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-binary-inputs-'))
    try {
      const path = resolve(temporary, 'asset.bin')
      await writeFile(path, Buffer.from([0xff, 0xfe, 13, 1]))
      const before = await deterministicInputDigest(temporary, ['asset.bin'])
      await writeFile(path, Buffer.from([0xff, 0xfd, 13, 1]))
      const after = await deterministicInputDigest(temporary, ['asset.bin'])
      expect(after).not.toBe(before)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
