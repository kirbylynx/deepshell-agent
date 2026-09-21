import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isForeignTargetPath,
  packagerArguments,
  applySeaCompatibilityTransforms,
  writeFileTransactionally,
  seaRuntimeFinalizedAtPrepare,
  seaTarget,
  verifyPackagerPatch,
} from '../../scripts/lib/sea-runtime.mjs'

const root = resolve(import.meta.dirname, '../..')

describe('Enhanced SEA runtime', () => {
  it('packager 始终显式启用 SEA 模式', () => {
    expect(packagerArguments('/input/package.json', '/output/runtime')).toEqual([
      '--sea',
      '/input/package.json',
      '--output',
      '/output/runtime',
    ])
  })

  it('只接受与 Node 精确三段版本匹配的目标', async () => {
    const lock = JSON.parse(await readFile(resolve(root, 'runtime/manifest/runtime-lock.json'), 'utf8'))
    expect(seaTarget(lock, 'darwin-arm64')).toBe('node24.20.0-macos-arm64')
    expect(seaTarget(lock, 'win32-x64')).toBe('node24.20.0-win-x64')
    expect(() => seaTarget({ ...lock, node: { ...lock.node, version: '24.20.1' } }, 'darwin-arm64')).toThrow()
  })

  it('Windows prepare 直接最终化，macOS 等待签名后最终化', () => {
    expect(seaRuntimeFinalizedAtPrepare('darwin-arm64')).toBe(false)
    expect(seaRuntimeFinalizedAtPrepare('win32-x64')).toBe(true)
    expect(() => seaRuntimeFinalizedAtPrepare('linux-x64')).toThrow(/不支持/)
  })

  it('把异平台完整目录识别为裁剪对象', () => {
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe')).toBe(true)
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/node-pty/prebuilds/linux-x64/pty.node')).toBe(true)
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).toBe(false)
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/@deepseek-ai/dsh-win32-process/lib/index.js')).toBe(false)
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/index.js')).toBe(false)
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe')).toBe(true)
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib')).toBe(false)
    expect(isForeignTargetPath('darwin-arm64', 'node_modules/@img/sharp-libvips-win32-x64/lib/libvips.dll')).toBe(true)
    expect(isForeignTargetPath('win32-x64', 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).toBe(true)
    expect(isForeignTargetPath('win32-x64', 'node_modules/node-pty/prebuilds/win32-arm64/conpty.pdb')).toBe(true)
    expect(isForeignTargetPath('win32-x64', 'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe')).toBe(false)
  })

  it('验证锁定补丁摘要和安装后的关键补丁标记', async () => {
    const lock = JSON.parse(await readFile(resolve(root, 'runtime/manifest/runtime-lock.json'), 'utf8'))
    await expect(verifyPackagerPatch(lock)).resolves.toEqual(lock.sea.packager.patch)
  })

  it('packager 补丁保留 SEA readdir 的 Dirent 契约', async () => {
    const patchRoot = resolve(root, 'node_modules/@yao-pkg/pkg/prelude')
    const [source, bundle] = await Promise.all([
      readFile(resolve(patchRoot, 'sea-vfs-setup.js'), 'utf8'),
      readFile(resolve(patchRoot, 'sea-bootstrap.bundle.js'), 'utf8'),
    ])
    expect(source).toContain('function _makeDirent(')
    expect(source).toContain('options.withFileTypes')
    expect(source).toContain('isDirectory: function ()')
    expect(source).toContain('return super.readdirSync(p, options)')
    expect(bundle).toContain('function _makeDirent(name, parentPath, meta, isSymbolicLink, options)')
    expect(bundle).toContain('return super.readdirSync(p, options)')
  })

  it('packager 使用稳定的 SEA bootstrap 逻辑路径', async () => {
    const source = await readFile(resolve(root, 'node_modules/@yao-pkg/pkg/lib-es5/sea.js'), 'utf8')
    expect(source).toContain("main: 'sea-main.js'")
    expect(source).not.toContain('main: bootstrapPath')
  })

  it('packager Worker 兼容层支持 snapshot 内的 file URL', async () => {
    const patchRoot = resolve(root, 'node_modules/@yao-pkg/pkg/prelude')
    const [source, bundle] = await Promise.all([
      readFile(resolve(patchRoot, 'sea-bootstrap-core.js'), 'utf8'),
      readFile(resolve(patchRoot, 'sea-bootstrap.bundle.js'), 'utf8'),
    ])
    for (const content of [source, bundle]) {
      expect(content).toContain('var workerFilename = filename;')
      expect(content).toContain('fileURLToPath(filename)')
      expect(content).toContain('insideSnapshot(workerFilename)')
    }
  })

  it('构建期兼容变换精确且可审计', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-sea-transform-'))
    try {
      const source = resolve(temporary, 'node_modules/node-pty/lib/unixTerminal.js')
      await mkdir(resolve(source, '..'), { recursive: true })
      await writeFile(source, 'before\nhelperPath = path.resolve(__dirname, helperPath);\nafter\n')
      await expect(applySeaCompatibilityTransforms(temporary)).resolves.toEqual(['node-pty-spawn-helper-v1'])
      expect(await readFile(source, 'utf8')).toContain('process.pkgNativePath')
      await expect(applySeaCompatibilityTransforms(temporary)).rejects.toThrow('预期命中 1 次，实际 0 次')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('清单事务写入不会留下临时文件', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-sea-write-'))
    try {
      const target = resolve(temporary, 'manifest.json')
      await writeFile(target, 'old')
      await writeFileTransactionally(target, 'new')
      expect(await readFile(target, 'utf8')).toBe('new')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
