import { browser, expect } from '@wdio/globals'

describe('DeepShell Agent .app smoke', () => {
  it('通过 Ready Gate 显示品牌化官方 React UI，且 URL 不含 token', async () => {
    await browser.waitUntil(async () => {
      return await browser.execute(() =>
        document.documentElement.dataset.deepshellRuntimeReady === 'true' &&
        document.body.innerText.includes('DeepShell Agent'))
    }, { timeout: 60_000, interval: 500, timeoutMsg: '品牌化官方 UI 未在 60 秒内就绪' })

    const currentUrl = await browser.getUrl()
    const source = await browser.getPageSource()
    await expect(currentUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    await expect(currentUrl).not.toContain('token=')
    await expect(source).toContain('Content-Security-Policy')
    await expect(source).toContain('@deepshell-agent/dsh-desktop')
    const ipcBoundary = await browser.executeAsync((done) => {
      const internals = (window as Window & {
        __TAURI_INTERNALS__?: { invoke?: (command: string) => Promise<unknown> }
      }).__TAURI_INTERNALS__
      if (typeof internals?.invoke !== 'function') {
        done('unavailable')
        return
      }
      internals.invoke('runtime_status').then(
        () => done('allowed'),
        () => done('blocked'),
      )
    })
    await expect(ipcBoundary).not.toBe('allowed')

    await browser.url('tauri://localhost/index.html')
    await browser.waitUntil(
      async () => (await browser.getUrl()).startsWith('tauri://localhost/'),
      { timeout: 5_000, interval: 100, timeoutMsg: '未能返回本地 Bootstrap 页面执行测试清理' },
    )
    const cleanup = await browser.executeAsync((done) => {
      const internals = (window as Window & {
        __TAURI_INTERNALS__?: { invoke?: (command: string) => Promise<unknown> }
      }).__TAURI_INTERNALS__
      if (typeof internals?.invoke !== 'function') {
        done('unavailable')
        return
      }
      internals.invoke('poc_e2e_stop_runtime').then(
        () => done('stopped'),
        () => done('failed'),
      )
    })
    await expect(cleanup).toBe('stopped')
  })
})
