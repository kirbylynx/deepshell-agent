import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('官方 UI Branding 公开契约', () => {
  it('使用 dsh.client 和公开 Slots', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'dsh/bundles/deepshell-desktop/package.json'), 'utf8'))
    const client = await readFile(resolve(root, 'dsh/bundles/deepshell-desktop/lib/client.js'), 'utf8')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(client).toContain("sidebar.brand.mark")
    expect(client).toContain("sidebar.brand.name")
    expect(client).toContain("conversation.hero.brand.mark")
    expect(client).toContain('DeepShell Agent')
    expect(client).toContain('BrandIcon')
    expect(client).not.toContain('A desktop agent powered by DeepSeek Harness.')
    expect(client).not.toMatch(/querySelector|innerHTML|MutationObserver/)
  })

  it('通过公开 Host 扩展注入 CSP 和 instance-bound Ready', async () => {
    const host = await readFile(resolve(root, 'dsh/bundles/deepshell-desktop/lib/index.js'), 'utf8')
    expect(host).toContain('webserver/index-inject')
    expect(host).toContain('Content-Security-Policy')
    expect(host).toContain('/__deepshell/client-ready')
    expect(host).toContain('DSH_DESKTOP_INSTANCE_ID')
  })
})
