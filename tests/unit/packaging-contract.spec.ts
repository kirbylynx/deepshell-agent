import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageAdapter } from '../../scripts/lib/package-platform.mjs'
import { summarizeInspections, validatePackageManifestV5 } from '../../scripts/lib/package-manifest.mjs'
import { uniqueMatchingArtifact } from '../../scripts/lib/artifact-selection.mjs'
import { packageCommandPlan } from '../../scripts/lib/process-plan.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const output = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const current = output[key]
    output[key] = value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current)
      ? merge(current as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return output
}

describe('v0.1.4 打包契约', () => {
  it('平台配置合并后保留共享 DSH/Profile 且只加入当前平台 Node', async () => {
    const base = JSON.parse(await readFile(resolve(workspace, 'src-tauri/tauri.conf.json'), 'utf8'))
    const macos = JSON.parse(await readFile(resolve(workspace, 'src-tauri/tauri.macos.conf.json'), 'utf8'))
    const windows = JSON.parse(await readFile(resolve(workspace, 'src-tauri/tauri.windows.conf.json'), 'utf8'))
    const macResources = merge(base, macos).bundle as { resources: Record<string, string> }
    const winResources = merge(base, windows).bundle as { resources: Record<string, string> }

    expect(Object.keys(macResources.resources)).toEqual(expect.arrayContaining([
      '../runtime/dsh/', '../runtime/profile-template/', '../runtime/node/darwin-arm64/',
    ]))
    expect(Object.keys(macResources.resources)).not.toContain('../runtime/node/win32-x64/')
    expect(Object.keys(winResources.resources)).toEqual(expect.arrayContaining([
      '../runtime/dsh/', '../runtime/profile-template/', '../runtime/node/win32-x64/',
    ]))
    expect(Object.keys(winResources.resources)).not.toContain('../runtime/node/darwin-arm64/')
  })

  it('adapter 锁定 macOS forbidden Runtime，并支持 Windows tree/portable 显式路径', () => {
    const lock = { dsh: { entry: 'node_modules/@deepseek-ai/dsh/lib/bin.js' } }
    const mac = packageAdapter('darwin', lock, 'macos-app')
    expect(mac.requiredArtifacts).toContain('Contents/Resources/runtime/node/darwin-arm64/bin/node')
    expect(mac.forbiddenArtifacts).toContain('Contents/Resources/runtime/node/win32-x64')

    const installed = packageAdapter('win32', lock, 'windows-installed-tree', { artifactPath: '/tmp/installed' })
    expect(installed.requiredArtifacts).toContain('runtime/node/win32-x64/node.exe')
    expect(installed.forbiddenArtifacts).toContain('runtime/node/darwin-arm64')
    const portable = packageAdapter('win32', lock, 'windows-portable', {
      stagingPath: '/tmp/staging', archivePath: '/tmp/archive.zip', extractedPath: '/tmp/extracted',
    })
    expect(portable.artifactKind).toBe('windows-portable')
  })

  it('schema 5 inspection 使用嵌套 size/resources/runtimePlatforms/baseline 契约', () => {
    const manifest = {
      schemaVersion: 5,
      platform: 'darwin-arm64',
      mode: 'release',
      applicationVersion: '0.1.4',
      artifactKind: 'macos-app',
      macosSourceInputSha256: 'a'.repeat(64),
      binarySourceInputSha256: 'a'.repeat(64),
      inspections: [{
        subject: 'macos-app', inspectionMode: 'exact-artifact-tree', status: 'present',
        resources: [{ path: 'runtime/node/darwin-arm64/bin/node', bytes: 1, sha256: 'a'.repeat(64) }],
        runtimePlatforms: ['darwin-arm64'], size: { bytes: 1, files: 1 }, contentSha256: 'b'.repeat(64),
      }],
      baseline: {
        status: 'canonical',
        canonicalSourceRef: 'v0.1.3', canonicalSourceCommit: 'commit',
        baselineSourceInputSha256: 'c'.repeat(64), algorithmVersion: 'v1', treeContentSha256: 'd'.repeat(64),
      },
    }
    expect(validatePackageManifestV5(manifest)).toBe(manifest)
  })

  it('reference-only baseline 保留非 canonical 状态', () => {
    const manifest = {
      schemaVersion: 5, platform: 'win32-x64', mode: 'release', applicationVersion: '0.1.4',
      artifactKind: 'nsis-installer', windowsSourceInputSha256: 'b'.repeat(64),
      binarySourceInputSha256: 'b'.repeat(64),
      inspections: [{
        subject: 'nsis-installer', inspectionMode: 'file-metadata-only', status: 'present',
        resources: [{ path: 'setup.exe', bytes: 1, sha256: 'a'.repeat(64) }], runtimePlatforms: [],
        size: { bytes: 1, files: 1 }, sha256: 'a'.repeat(64),
      }],
      baseline: {
        status: 'reference-only', reason: 'provenance pending', canonicalSourceRef: 'v0.1.3',
        canonicalSourceCommit: 'commit', baselineSourceInputSha256: 'c'.repeat(64),
        algorithmVersion: 'v1', artifactSha256: 'd'.repeat(64),
      },
    }
    expect(validatePackageManifestV5(manifest).baseline.status).toBe('reference-only')
    expect(manifest.inspections[0].runtimePlatforms).toEqual([])
  })

  it('schema 5 拒绝错平台 artifactKind 与双平台 digest', () => {
    const invalid = {
      schemaVersion: 5, platform: 'darwin-arm64', mode: 'release', applicationVersion: '0.1.4',
      artifactKind: 'nsis-installer', macosSourceInputSha256: 'a'.repeat(64),
      windowsSourceInputSha256: 'b'.repeat(64), inspections: [], baseline: {},
    }
    expect(() => validatePackageManifestV5(invalid)).toThrow(/artifactKind|inspections|digest/)
  })

  it('同版本产物存在多个候选时拒绝自动选择', () => {
    expect(() => uniqueMatchingArtifact(
      ['DeepShell_0.1.4_x64-setup.exe', 'DeepShell_0.1.4_x64-copy-setup.exe'],
      name => name.includes('0.1.4') && name.endsWith('-setup.exe'),
      'installer',
    )).toThrow('存在多个候选')
  })

  it('Windows 通过 cmd.exe 安全启动 pnpm.cmd 且不启用 shell', () => {
    expect(packageCommandPlan('pnpm.cmd', ['exec', 'tauri'], 'win32')).toEqual({
      command: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm.cmd', 'exec', 'tauri'],
    })
  })

  it('公开报告 inspection 只保留聚合值和 file basename', () => {
    const summaries = summarizeInspections([{
      subject: 'archive', inspectionMode: 'file-metadata-only', status: 'present',
      resources: [{ path: '/Users/private/secret/package.dmg', bytes: 1, sha256: 'a' }],
      runtimePlatforms: [], size: { bytes: 1, files: 1 }, sha256: 'a',
    }])
    expect(JSON.stringify(summaries)).not.toContain('/Users/private')
    expect(JSON.stringify(summaries)).toContain('package.dmg')
  })
})
