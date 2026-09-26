import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('runtime lock', () => {
  it('只包含精确版本与固定安全配置', async () => {
    const lock = JSON.parse(await readFile(resolve(root, 'runtime/manifest/runtime-lock.json'), 'utf8'))
    expect(lock.applicationVersion).toBe('0.1.5')
    expect(lock.packageBaselineVersion).toBe('0.1.4')
    expect(lock.node.version).toBe('24.20.0')
    expect(lock.platforms).toEqual(['darwin-arm64', 'win32-x64'])
    expect(lock.node.targets['darwin-arm64'].archiveType).toBe('tar.gz')
    expect(lock.node.targets['win32-x64'].archiveType).toBe('zip')
    expect(lock.dsh.version).toBe('0.1.5-rc.2')
    expect(lock.dsh.desktopBundle).toBe('@deepshell-agent/dsh-desktop')
    expect(lock.sea).toMatchObject({
      packager: {
        package: '@yao-pkg/pkg',
        version: '6.22.0',
        patch: {
          path: 'patches/@yao-pkg__pkg@6.22.0.patch',
          sha256: '34295ed217a55fc962dda1c12ef756f84d94cd1afd739613b4d43ebee7b75e52'
        }
      },
      mode: 'enhanced',
      compression: 'Zstd',
      useSnapshot: false,
      transforms: ['node-pty-spawn-helper-v1'],
      targets: {
        'darwin-arm64': 'node24.20.0-macos-arm64',
        'win32-x64': 'node24.20.0-win-x64'
      }
    })
    expect(lock.security).toEqual({
      permissionMode: 'workspace-write',
      telemetryMode: 'DISABLED',
      bindAddress: '127.0.0.1',
      webFetch: 'public-http-only',
      credentials: 'credentials-local'
    })
    expect(JSON.stringify(lock)).not.toMatch(/latest|["']\^[0-9]|["']~[0-9]/i)
  })
})
