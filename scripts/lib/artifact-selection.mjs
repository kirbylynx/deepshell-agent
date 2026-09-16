export function uniqueMatchingArtifact(names, predicate, label) {
  const matches = names.filter(predicate).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (matches.length > 1) throw new Error(`${label} 存在多个候选，必须显式指定：${matches.join(', ')}`)
  return matches[0] ?? null
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function artifactVersionPattern(version) {
  return new RegExp(`(^|[\\s_-])${escapedRegex(version)}(?=([\\s_-]|\\.|$))`)
}

export function artifactNameMatchesVersion(name, version) {
  return artifactVersionPattern(version).test(name)
}

const productNamePattern = '(?:DeepShell Agent|DeepShell\\.Agent)'

export function isWindowsNsisInstallerName(name, version) {
  return new RegExp(`^${productNamePattern}_${escapedRegex(version)}_x64-setup\\.exe$`).test(name)
}

export function isWindowsPortableZipName(name, version) {
  return new RegExp(`^${productNamePattern}_${escapedRegex(version)}_x64-portable\\.zip$`).test(name)
}

export function isMacosDmgName(name, version) {
  return new RegExp(`^${productNamePattern}_${escapedRegex(version)}_aarch64\\.dmg$`).test(name)
}

export function selectWindowsNsisInstallerName(names, version, label = `Windows ${version} installer`) {
  return uniqueMatchingArtifact(names, name => isWindowsNsisInstallerName(name, version), label)
}

export function selectWindowsPortableZipName(names, version, label = `Windows ${version} portable ZIP`) {
  return uniqueMatchingArtifact(names, name => isWindowsPortableZipName(name, version), label)
}

export function selectMacosDmgName(names, version, label = `macOS ${version} DMG`) {
  return uniqueMatchingArtifact(names, name => isMacosDmgName(name, version), label)
}

export function assertArtifactNameMatchesVersion(name, version, label, matcher = artifactNameMatchesVersion) {
  if (!matcher(name, version)) {
    throw new Error(`${label} 版本不一致：expected ${version}, got ${name}`)
  }
}
