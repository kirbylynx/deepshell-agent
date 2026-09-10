import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const rowIds = (content: string) =>
  [...content.matchAll(/^- id:\s*([^\s]+)\s*$/gm)].map(match => match[1])

describe('DeepShell Agent Mode Preset 契约', () => {
  it('General/Coding/Work Mode 与 legacy deepshell 兼容别名保留官方 standard 插件集合', async () => {
    const upstream = await readFile(resolve(
      root,
      'runtime/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml'
    ), 'utf8')
    const manifest = JSON.parse(await readFile(resolve(
      root,
      'runtime/profile-template/template-manifest.json'
    ), 'utf8'))
    const patch = await readFile(resolve(
      root,
      'dsh/bundles/deepshell-desktop/cordis.patch.yml'
    ), 'utf8')

    for (const presetId of ['deepshell-coding', 'deepshell-work', 'deepshell-general', 'deepshell']) {
      const derived = await readFile(resolve(
        root,
        `runtime/profile-template/.agent-presets/${presetId}/agent.cordis.yml`
      ), 'utf8')
      expect(rowIds(derived)).toEqual(rowIds(upstream))
      expect(rowIds(derived)).toContain('tool-web')
      expect(manifest.agentPresets[presetId].source).toBe('official-standard')
      expect(manifest.agentPresets[presetId].fingerprint).toBe(createHash('sha256').update(derived).digest('hex'))
    }
    expect(manifest.defaultAgentPresetId).toBe('deepshell-coding')
    expect(manifest.legacyAgentPresetIds).toEqual(['deepshell'])
    expect(Object.keys(manifest.agentPresets).sort()).toEqual([
      'deepshell',
      'deepshell-coding',
      'deepshell-general',
      'deepshell-work'
    ])
    expect(manifest.agentPresetSourceSha256).toBe(createHash('sha256').update(upstream).digest('hex'))
    expect(patch).toMatch(/id:\s*agent-presets[\s\S]*?default:\s*deepshell-coding/)
    expect(patch).not.toMatch(/id:\s*(tool-web|web-search-deepseek|web-fetch-http)[\s\S]*?disabled:\s*true/)
  })

  it('不修改官方 workspace-write Permission Preset', async () => {
    const source = await readFile(resolve(root, 'scripts/prepare-profile.mjs'), 'utf8')
    expect(source).toContain("DSH_PERMISSION_MODE: 'workspace-write'")
    expect(source).not.toContain('.permission-presets')
    expect(source).not.toContain('dsh-permission-presets')
  })
})
