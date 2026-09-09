import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('Secret 与遥测策略', () => {
  it('生产启动配置强制关闭遥测', async () => {
    const files = [
      'runtime/manifest/runtime-lock.json',
      'scripts/prepare-profile.mjs'
    ]
    for (const file of files) {
      const body = await readFile(resolve(root, file), 'utf8')
      expect(body).toContain('DISABLED')
    }
  })
})
