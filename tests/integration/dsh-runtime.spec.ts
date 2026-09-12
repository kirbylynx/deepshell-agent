import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')

describe('真实 DSH Runtime 集成', () => {
  it('通过动态端口认证、CSP、实例绑定与品牌插件冒烟', async () => {
    // Windows 实测：稳态约 10.3s（两次连测均为 10.3s），但冷启动（首次运行、
    // 或紧接 cargo 全量编译后的高负载）观测到超过 30s。原 30s 限制对稳态有 3 倍裕度、
    // 对冷启动却不足，会导致门禁出现假失败。放宽以覆盖冷启动，同时仍能在真正挂死时收敛。
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [resolve(root, 'scripts/smoke-dsh.mjs')],
      { cwd: root, timeout: 90_000, maxBuffer: 1024 * 1024 },
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
  }, 120_000)
})
