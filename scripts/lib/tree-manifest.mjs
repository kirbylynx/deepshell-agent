import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export const TREE_MANIFEST_ALGORITHM = 'deepshell-tree-v1'

const stableCompare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function isInside(rootPath, candidatePath) {
  const path = relative(rootPath, candidatePath)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep))
}

export async function normalizedTreeManifest(directory) {
  const trustedRoot = await realpath(directory)
  const records = []

  async function addFile(path, relativePath) {
    const content = await readFile(path)
    records.push({
      path: relativePath.split(sep).join('/'),
      bytes: content.length,
      sha256: sha256(content),
    })
  }

  async function walk(current, relativeDirectory = '') {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => stableCompare(left.name, right.name))
    for (const entry of entries) {
      const path = resolve(current, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const metadata = await lstat(path)
      if (metadata.isDirectory()) {
        await walk(path, relativePath)
        continue
      }
      if (metadata.isSymbolicLink()) {
        let target
        try {
          target = await realpath(path)
        } catch {
          throw new Error(`不安全的悬空或循环符号链接：${relativePath}`)
        }
        if (!isInside(trustedRoot, target)) throw new Error(`符号链接逃逸受信目录：${relativePath}`)
        const targetMetadata = await stat(path)
        if (!targetMetadata.isFile()) throw new Error(`只允许指向普通文件的符号链接：${relativePath}`)
        await addFile(path, relativePath)
        continue
      }
      if (!metadata.isFile()) throw new Error(`不支持的 tree 项目类型：${relativePath}`)
      await addFile(path, relativePath)
    }
  }

  await walk(trustedRoot)
  records.sort((left, right) => stableCompare(left.path, right.path))
  const hash = createHash('sha256')
  let bytes = 0
  for (const record of records) {
    bytes += record.bytes
    hash.update(record.path)
    hash.update('\0')
    hash.update(String(record.bytes))
    hash.update('\0')
    hash.update(record.sha256)
    hash.update('\0')
  }
  return {
    algorithm: TREE_MANIFEST_ALGORITHM,
    bytes,
    files: records.length,
    contentSha256: hash.digest('hex'),
    entries: records,
  }
}

export async function assertEquivalentTrees(source, target, label = 'tree') {
  const [sourceManifest, targetManifest] = await Promise.all([
    normalizedTreeManifest(source),
    normalizedTreeManifest(target),
  ])
  if (sourceManifest.contentSha256 !== targetManifest.contentSha256) {
    const sourceRecords = new Map(sourceManifest.entries.map(record => [record.path, record]))
    const targetRecords = new Map(targetManifest.entries.map(record => [record.path, record]))
    const paths = [...new Set([...sourceRecords.keys(), ...targetRecords.keys()])].sort(stableCompare)
    const firstDifference = paths.find(path => JSON.stringify(sourceRecords.get(path)) !== JSON.stringify(targetRecords.get(path)))
    throw new Error(`${label} 内容不等价，首个差异：${firstDifference ?? '未知'}`)
  }
  return { source: sourceManifest, target: targetManifest }
}
