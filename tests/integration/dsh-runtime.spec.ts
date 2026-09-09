import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')

describe('真实 DSH Runtime 集成', () => {
  it('通过动态端口认证、CSP、实例绑定与品牌插件冒烟', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [resolve(root, 'scripts/smoke-dsh.mjs')],
      { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 },
    )

    expect(stderr).toBe('')
    expect(JSON.parse(stdout.trim())).toEqual({
      ok: true,
      host: '127.0.0.1',
      dynamicPort: true,
      authCookie: true,
      csp: true,
      instanceBound: true,
      brandingGraph: true,
    })
  }, 35_000)
})
