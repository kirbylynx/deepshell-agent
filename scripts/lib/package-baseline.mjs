import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export function packageBaselinePath(workspaceRoot, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package baseline 版本无效：${version ?? 'missing'}`)
  }
  return resolve(workspaceRoot, 'tests/fixtures/package-size-baselines', `v${version}.json`)
}

export async function loadPackageBaseline(workspaceRoot, version) {
  const path = packageBaselinePath(workspaceRoot, version)
  const fixture = JSON.parse(await readFile(path, 'utf8'))
  if (fixture.baselineVersion !== version || fixture.canonicalSource?.tag !== `v${version}`) {
    throw new Error(`package baseline fixture 与显式版本不一致：${path}`)
  }
  return fixture
}

export function packageBaselineArtifact(fixture, artifactKind) {
  return {
    'macos-app': fixture.artifacts?.macosApp,
    'macos-dmg': fixture.artifacts?.macosDmg,
    'nsis-installer': fixture.artifacts?.windowsNsis,
    'windows-installed-tree': fixture.artifacts?.windowsInstalledTree,
    'windows-portable': fixture.artifacts?.windowsPortable,
  }[artifactKind] ?? null
}

export function packageBaselineSourceTree(fixture, runtimePlatform, subject) {
  const platformPrefix = runtimePlatform === 'darwin-arm64' ? 'darwin' : runtimePlatform === 'win32-x64' ? 'windows' : null
  if (platformPrefix === null) throw new Error(`不支持的 package baseline 平台：${runtimePlatform}`)
  const key = {
    'runtime-node': `${platformPrefix}Node`,
    'runtime-dsh': `${platformPrefix}Dsh`,
    'profile-template': `${platformPrefix}ProfileTemplate`,
  }[subject]
  if (!key) return null
  // v0.1.3 只有平台无关的旧字段；保留历史 fixture 的读取能力。
  return fixture.sourceTrees?.[key] ?? fixture.sourceTrees?.[
    subject === 'runtime-dsh' ? 'dsh' : subject === 'profile-template' ? 'profileTemplate' : key
  ] ?? null
}
