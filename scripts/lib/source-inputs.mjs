import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export const packageSourceInputs = [
  'package.json',
  'pnpm-lock.yaml',
  'rust-toolchain.toml',
  'tsconfig.json',
  'vite.config.ts',
  'src-bootstrap',
  'src-tauri/build.rs',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities',
  'src-tauri/icons',
  'src-tauri/src',
  'dsh/bundles/deepshell-desktop',
  'runtime/manifest',
  'scripts/lib/runtime.mjs',
  'scripts/lib/source-inputs.mjs',
  'scripts/lib/package-platform.mjs',
  'scripts/prepare-runtime.mjs',
  'scripts/prepare-profile.mjs',
  'scripts/sign-package.mjs',
  'scripts/package-mvp.mjs',
  'scripts/create-macos-dmg.mjs',
  'scripts/verify-package.mjs',
  'scripts/capture-package-manifest.mjs',
  'scripts/compare-e2e-release.mjs',
]

export async function deterministicInputDigest(workspaceRoot, inputs = packageSourceInputs) {
  const records = []
  async function walk(path) {
    const metadata = await lstat(path)
    const name = relative(workspaceRoot, path)
    if (metadata.isDirectory()) {
      const entries = await readdir(path)
      entries.sort()
      for (const entry of entries) await walk(resolve(path, entry))
      return
    }
    if (metadata.isSymbolicLink()) {
      records.push({ path: name, type: 'symlink', content: Buffer.from(await readlink(path)) })
      return
    }
    if (!metadata.isFile()) throw new Error(`不支持的构建输入类型：${name}`)
    records.push({ path: name, type: 'file', content: await readFile(path) })
  }
  for (const input of [...inputs].sort()) await walk(resolve(workspaceRoot, input))

  const hash = createHash('sha256')
  for (const record of records.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(record.type)
    hash.update('\0')
    hash.update(record.path)
    hash.update('\0')
    hash.update(String(record.content.length))
    hash.update('\0')
    hash.update(record.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}
