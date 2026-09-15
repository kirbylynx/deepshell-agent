import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { root } from './runtime.mjs'
import { assertEquivalentTrees } from './tree-manifest.mjs'

const execFileAsync = promisify(execFile)

export async function verifyDmgContainsApp(dmgPath, expectedAppPath) {
  if (process.platform !== 'darwin') throw new Error('DMG 内容绑定验证只能在 macOS 执行')
  const staging = resolve(root, 'runtime/staging/dmg-mounts')
  await mkdir(staging, { recursive: true })
  const mountPoint = await mkdtemp(resolve(staging, 'mounted-'))
  let attached = false
  try {
    await execFileAsync('/usr/bin/hdiutil', [
      'attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath,
    ], { maxBuffer: 4 * 1024 * 1024 })
    attached = true
    const mountedApp = resolve(mountPoint, 'DeepShell Agent.app')
    return await assertEquivalentTrees(expectedAppPath, mountedApp, 'DMG 内应用')
  } finally {
    if (attached) {
      await execFileAsync('/usr/bin/hdiutil', ['detach', mountPoint], { maxBuffer: 4 * 1024 * 1024 })
    }
    await rm(mountPoint, { recursive: true, force: true })
  }
}
