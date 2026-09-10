import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('DSH 上游边界', () => {
  it('固定官方 npm 包且不导入私有源码路径', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
    expect(pkg.devDependencies['@deepseek-ai/dsh']).toBe('0.1.2-rc.1')
    const client = await readFile(resolve(root, 'dsh/bundles/deepshell-desktop/lib/client.js'), 'utf8')
    expect(client).not.toMatch(/@deepseek-ai\/.*\/src\//)
  })

  it('显式拒绝新 WebView，并限制 Tauri Capability 为本地 Bootstrap', async () => {
    const source = await readFile(resolve(root, 'src-tauri/src/lib.rs'), 'utf8')
    const webview = await readFile(resolve(root, 'src-tauri/src/webview.rs'), 'utf8')
    const capability = JSON.parse(await readFile(resolve(root, 'src-tauri/capabilities/main.json'), 'utf8'))
    expect(source).toContain('.on_new_window')
    expect(source).toContain('NewWindowResponse::Deny')
    expect(webview).toContain('#[cfg(target_os = "macos")]')
    expect(webview).toContain('#[cfg(target_os = "windows")]')
    expect(webview).toContain('Command::new("cmd")')
    expect(capability.local).toBe(true)
    expect(capability.remote).toBeUndefined()
  })

  it('第二实例按 Runtime phase 分流且不会暴露 pending DSH 页面', async () => {
    const source = await readFile(resolve(root, 'src-tauri/src/lib.rs'), 'utf8')
    const supervisor = await readFile(resolve(root, 'src-tauri/src/sidecar/supervisor.rs'), 'utf8')
    const callback = source.match(/tauri_plugin_single_instance::init\([\s\S]*?\n\s*\}\s*,\s*\n\s*\)\)/)?.[0]
    expect(callback).toContain('show_for_second_instance(app)')
    expect(supervisor).toContain('RuntimePhase::Starting | RuntimePhase::Recovering')
    expect(supervisor).toContain('SecondInstanceVisibility::DeferUntilReady')
    expect(supervisor).toContain('RuntimePhase::Ready => SecondInstanceVisibility::ShowCurrent')
  })

  it('按锁定 DSH 的 detached Shell 契约登记并清理多个 owned groups', async () => {
    const upstream = await readFile(resolve(
      root,
      'runtime/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js'
    ), 'utf8')
    const processTree = await readFile(resolve(root, 'src-tauri/src/sidecar/process_tree.rs'), 'utf8')
    const supervisor = await readFile(resolve(root, 'src-tauri/src/sidecar/supervisor.rs'), 'utf8')

    expect(upstream).toContain('detached: platform !== "win32"')
    expect(processTree).toContain('descendants_of(record.leader.pid')
    expect(processTree).toContain('pub fn terminate_registered')
    expect(supervisor).toContain('process_tree::terminate_registered(')
  })
})
