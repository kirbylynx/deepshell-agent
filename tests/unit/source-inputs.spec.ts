import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deterministicInputDigest } from '../../scripts/lib/source-inputs.mjs'

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
})
