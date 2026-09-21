const inspectionModes = new Set([
  'exact-artifact-tree',
  'exact-installed-tree',
  'archive-extracted-tree',
  'file-metadata-only',
])
const isSha256 = value => /^[0-9a-f]{64}$/.test(value ?? '')

function validatePackageManifestBase(manifest, schemaVersion) {
  if (manifest?.schemaVersion !== schemaVersion) throw new Error(`package manifest schemaVersion 必须为 ${schemaVersion}`)
  if (!['darwin-arm64', 'win32-x64'].includes(manifest.platform)) throw new Error('package manifest platform 无效')
  if (!['e2e', 'release'].includes(manifest.mode)) throw new Error('package manifest mode 无效')
  const platformKinds = {
    'darwin-arm64': new Set(['macos-app', 'macos-dmg']),
    'win32-x64': new Set(['nsis-installer', 'windows-installed-tree', 'windows-portable']),
  }
  if (!platformKinds[manifest.platform].has(manifest.artifactKind)) {
    throw new Error('package manifest platform/artifactKind 组合无效')
  }
  const expectedDigest = manifest.platform === 'darwin-arm64' ? 'macosSourceInputSha256' : 'windowsSourceInputSha256'
  const forbiddenDigest = manifest.platform === 'darwin-arm64' ? 'windowsSourceInputSha256' : 'macosSourceInputSha256'
  if (!isSha256(manifest[expectedDigest]) || manifest[forbiddenDigest] !== undefined) {
    throw new Error('package manifest 平台 source input digest 无效')
  }
  if (manifest.binarySourceInputSha256 !== manifest[expectedDigest]) {
    throw new Error('package manifest binary source receipt 无效')
  }
  if (typeof manifest.applicationVersion !== 'string' || manifest.applicationVersion === '') {
    throw new Error('package manifest 缺少 applicationVersion')
  }
  if (!Array.isArray(manifest.inspections) || manifest.inspections.length === 0) {
    throw new Error('package manifest inspections 不得为空')
  }
  for (const inspection of manifest.inspections) {
    if (typeof inspection.subject !== 'string' || !inspectionModes.has(inspection.inspectionMode)) {
      throw new Error('package manifest inspection subject/mode 无效')
    }
    if (!Array.isArray(inspection.resources) || !Array.isArray(inspection.runtimePlatforms)) {
      throw new Error(`${inspection.subject} inspection 缺少 resources/runtimePlatforms`)
    }
    for (const resource of inspection.resources) {
      if (typeof resource.path !== 'string' || resource.path === '' || resource.path.startsWith('/') ||
          /^[A-Za-z]:[\\/]/.test(resource.path) || resource.path.split(/[\\/]/).includes('..') ||
          !Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || !isSha256(resource.sha256)) {
        throw new Error(`${inspection.subject} inspection resource 无效`)
      }
    }
    if (!Number.isSafeInteger(inspection.size?.bytes) || inspection.size.bytes < 0 ||
        !Number.isSafeInteger(inspection.size?.files) || inspection.size.files < 0) {
      throw new Error(`${inspection.subject} inspection size 无效`)
    }
    if (inspection.inspectionMode === 'file-metadata-only') {
      if (!isSha256(inspection.sha256)) throw new Error(`${inspection.subject} inspection 缺少有效 sha256`)
    } else if (!isSha256(inspection.contentSha256)) {
      throw new Error(`${inspection.subject} inspection 缺少 contentSha256`)
    }
  }
  const baseline = manifest.baseline
  if (!['canonical', 'reference-only', 'pending'].includes(baseline?.status) ||
      typeof baseline?.canonicalSourceRef !== 'string' ||
      typeof baseline?.canonicalSourceCommit !== 'string' ||
      !isSha256(baseline?.baselineSourceInputSha256) ||
      typeof baseline?.algorithmVersion !== 'string' ||
      (baseline.status !== 'pending' && !isSha256(baseline.artifactSha256) && !isSha256(baseline.treeContentSha256)) ||
      (baseline.status === 'reference-only' && (typeof baseline.reason !== 'string' || baseline.reason === ''))) {
    throw new Error('package manifest baseline 契约不完整')
  }
  return manifest
}

export function validatePackageManifestV5(manifest) {
  return validatePackageManifestBase(manifest, 5)
}

export function validatePackageManifestV6(manifest) {
  validatePackageManifestBase(manifest, 6)
  const runtime = manifest.runtime
  if (runtime?.format !== 'sea' || runtime.platform !== manifest.platform) {
    throw new Error('package manifest runtime format/platform 无效')
  }
  if (typeof runtime.provisional !== 'boolean') {
    throw new Error('package manifest runtime provisional 状态无效')
  }
  if (runtime.sourceInputSha256 !== manifest.binarySourceInputSha256 || !isSha256(runtime.sourceInputSha256) ||
      !/^[0-9a-f]{40}$/.test(runtime.artifactSourceCommit ?? '')) {
    throw new Error('package manifest runtime source receipt 无效')
  }
  if (runtime.dsh?.package !== '@deepseek-ai/dsh' || typeof runtime.dsh.version !== 'string' ||
      !Array.isArray(runtime.dsh.patches) || runtime.dsh.patches.some(patch =>
        typeof patch.package !== 'string' || typeof patch.version !== 'string' || !isSha256(patch.sha256))) {
    throw new Error('package manifest runtime DSH 契约无效')
  }
  if (typeof runtime.node?.version !== 'string' || typeof runtime.node?.target !== 'string' ||
      !isSha256(runtime.node?.archiveSha256)) {
    throw new Error('package manifest runtime Node 契约无效')
  }
  if (runtime.packager?.package !== '@yao-pkg/pkg' || typeof runtime.packager.version !== 'string' ||
      runtime.packager.mode !== 'enhanced' || typeof runtime.packager.compression !== 'string' ||
      runtime.packager.useSnapshot !== false || !isSha256(runtime.packager.patchSha256) ||
      !isSha256(runtime.packager.configSha256)) {
    throw new Error('package manifest runtime packager 契约无效')
  }
  const executable = runtime.executable
  if (typeof executable?.path !== 'string' || executable.path === '' || executable.path.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(executable.path) || executable.path.split(/[\\/]/).includes('..') ||
      !Number.isSafeInteger(executable.bytes) || executable.bytes <= 0 || !isSha256(executable.sha256) ||
      !['signed-adhoc', 'unsigned'].includes(executable.signing)) {
    throw new Error('package manifest runtime executable 契约无效')
  }
  const inventory = runtime.nativeInventory
  if (typeof inventory?.file !== 'string' || inventory.file.includes('/') || inventory.file.includes('\\') ||
      !isSha256(inventory.sha256) || !isSha256(inventory.contentSha256) ||
      !Number.isSafeInteger(inventory.files) || inventory.files < 0 ||
      !Number.isSafeInteger(inventory.bytes) || inventory.bytes < 0) {
    throw new Error('package manifest runtime native inventory 契约无效')
  }
  const packagedTree = runtime.packagedTree
  if (!Number.isSafeInteger(packagedTree?.files) || packagedTree.files <= 0 ||
      !Number.isSafeInteger(packagedTree?.bytes) || packagedTree.bytes <= 0 || !isSha256(packagedTree?.contentSha256)) {
    throw new Error('package manifest runtime packaged tree 契约无效')
  }
  if (JSON.stringify(runtime.standardRuntimeForbiddenPaths) !== JSON.stringify(['runtime/node', 'runtime/dsh'])) {
    throw new Error('package manifest 未证明标准 Runtime 禁止路径')
  }
  return manifest
}

export function validatePackageManifest(manifest) {
  if (manifest?.schemaVersion === 5) return validatePackageManifestV5(manifest)
  if (manifest?.schemaVersion === 6) return validatePackageManifestV6(manifest)
  throw new Error('package manifest schemaVersion 必须为 5 或 6')
}

export function summarizeInspections(inspections) {
  return inspections.map(inspection => ({
    subject: inspection.subject,
    inspectionMode: inspection.inspectionMode,
    status: inspection.status,
    size: inspection.size,
    runtimePlatforms: inspection.runtimePlatforms,
    resourceCount: inspection.resources.length,
    ...(inspection.sha256 ? { sha256: inspection.sha256 } : {}),
    ...(inspection.contentSha256 ? { contentSha256: inspection.contentSha256 } : {}),
    ...(inspection.inspectionMode === 'file-metadata-only' && inspection.resources[0]
      ? { asset: inspection.resources[0].path.split(/[\\/]/).at(-1) }
      : {}),
  }))
}
