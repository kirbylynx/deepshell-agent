import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertEquivalentTrees, normalizedTreeManifest } from '../../scripts/lib/tree-manifest.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory() {
  const path = await mkdtemp(resolve(tmpdir(), 'deepshell-tree-'))
  temporaryDirectories.push(path)
  return path
}

describe('规范化 tree manifest', () => {
  it.skipIf(process.platform === 'win32')('安全文件 symlink 物化后仍保持内容等价，并忽略空目录', async () => {
    const root = await temporaryDirectory()
    const source = resolve(root, 'source')
    const target = resolve(root, 'target')
    await mkdir(resolve(source, 'bin'), { recursive: true })
    await mkdir(resolve(source, 'empty'), { recursive: true })
    await mkdir(resolve(target, 'bin'), { recursive: true })
    await writeFile(resolve(source, 'bin/node'), 'node-bytes')
    await symlink('node', resolve(source, 'bin/npm'))
    await writeFile(resolve(target, 'bin/node'), 'node-bytes')
    await writeFile(resolve(target, 'bin/npm'), 'node-bytes')

    const result = await assertEquivalentTrees(source, target)
    expect(result.source.contentSha256).toBe(result.target.contentSha256)
    expect(result.source.files).toBe(2)
  })

  it.skipIf(process.platform === 'win32')('拒绝逃逸受信子树的 symlink', async () => {
    const root = await temporaryDirectory()
    const source = resolve(root, 'source')
    await mkdir(source)
    await writeFile(resolve(root, 'secret'), 'secret')
    await symlink('../secret', resolve(source, 'escape'))

    await expect(normalizedTreeManifest(source)).rejects.toThrow('逃逸受信目录')
  })

  it('缺失非入口依赖时比较失败', async () => {
    const root = await temporaryDirectory()
    const source = resolve(root, 'source')
    const target = resolve(root, 'target')
    await mkdir(source)
    await mkdir(target)
    await writeFile(resolve(source, 'entry.js'), 'entry')
    await writeFile(resolve(source, 'dependency.js'), 'dependency')
    await writeFile(resolve(target, 'entry.js'), 'entry')

    await expect(assertEquivalentTrees(source, target, 'DSH')).rejects.toThrow('内容不等价')
  })

  it.skipIf(process.platform === 'win32')('拒绝悬空、循环和目录 symlink', async () => {
    for (const kind of ['dangling', 'cycle', 'directory']) {
      const root = await temporaryDirectory()
      const source = resolve(root, kind)
      await mkdir(resolve(source, 'directory'), { recursive: true })
      if (kind === 'dangling') await symlink('missing', resolve(source, 'link'))
      if (kind === 'cycle') {
        await symlink('b', resolve(source, 'a'))
        await symlink('a', resolve(source, 'b'))
      }
      if (kind === 'directory') await symlink('directory', resolve(source, 'link'))
      await expect(normalizedTreeManifest(source)).rejects.toThrow(/符号链接/)
    }
  })

  it('删除官方 Web UI asset 时比较失败', async () => {
    const root = await temporaryDirectory()
    const source = resolve(root, 'source')
    const target = resolve(root, 'target')
    await mkdir(resolve(source, 'web/assets'), { recursive: true })
    await mkdir(resolve(target, 'web/assets'), { recursive: true })
    await writeFile(resolve(source, 'web/index.html'), '<main>DSH</main>')
    await writeFile(resolve(source, 'web/assets/client.js'), 'client')
    await writeFile(resolve(target, 'web/index.html'), '<main>DSH</main>')
    await expect(assertEquivalentTrees(source, target, 'official Web UI')).rejects.toThrow('内容不等价')
  })

  it('改变 Profile 文件时比较失败', async () => {
    const root = await temporaryDirectory()
    const source = resolve(root, 'source')
    const target = resolve(root, 'target')
    await mkdir(source)
    await mkdir(target)
    await writeFile(resolve(source, 'template-manifest.json'), '{"version":1}')
    await writeFile(resolve(target, 'template-manifest.json'), '{"version":2}')
    await expect(assertEquivalentTrees(source, target, 'Profile')).rejects.toThrow('内容不等价')
  })
})
