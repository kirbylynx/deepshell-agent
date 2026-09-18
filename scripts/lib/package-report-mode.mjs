function hasArgument(args, name) {
  return args.some(value => value === name || value.startsWith(`${name}=`))
}

export function isCombinedWindowsPackageReportInput({ args, hostPlatform }) {
  const crossDeviceWindowsManifestExplicit = [
    '--windows-nsis-manifest',
    '--windows-installed-tree-manifest',
    '--windows-portable-manifest',
  ].some(name => hasArgument(args, name))
  const crossDeviceWindowsAssetExplicit = hasArgument(args, '--windows-installer') ||
    hasArgument(args, '--windows-portable')

  return crossDeviceWindowsManifestExplicit ||
    (hostPlatform !== 'win32' && crossDeviceWindowsAssetExplicit)
}
