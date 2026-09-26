export const runtimeOwnedFileLimit = 2_000
export const minimumPerformanceRuns = 10
export const minimumIdleSeconds = 30
export const nativeCacheControlFiles = 2

function sameMetrics(left, right) {
  return left.files === right.files && left.bytes === right.bytes && left.allocatedBytes === right.allocatedBytes
}

function stableMetrics(samples, key, label) {
  const first = samples[0]?.[key]
  if (!first || !samples.every(sample => sameMetrics(sample[key], first))) {
    throw new Error(`${label} 在样本间发生变化`)
  }
  return first
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}

function closeEnough(left, right, tolerance = 0.001) {
  return Math.abs(left - right) <= tolerance
}

function metricsWithin(value, minimum, maximum) {
  return value.files >= minimum.files && value.files <= maximum.files
    && value.bytes >= minimum.bytes && value.bytes <= maximum.bytes
    && value.allocatedBytes >= minimum.allocatedBytes && value.allocatedBytes <= maximum.allocatedBytes
}

function verifyGroupSummary(name, group) {
  for (const [metric, key] of [['readyGateMs', 'readyGateMs'], ['rssKiB', 'rssKiB']]) {
    const values = group.samples.map(sample => sample[key])
    if (!closeEnough(group[metric].median, median(values)) || group[metric].max !== Math.max(...values)) {
      throw new Error(`Runtime acceptance ${name}.${metric} 聚合值与原始样本不一致`)
    }
  }
}

function verifyGate(gate, baseline, candidate, percentLimit, absoluteLimit, unitScale = 1) {
  const delta = candidate - baseline
  const percent = baseline === 0 ? null : delta / baseline * 100
  const passed = delta <= baseline * percentLimit / 100 && delta <= absoluteLimit * unitScale
  if (!closeEnough(gate.baseline, baseline) || !closeEnough(gate.candidate, candidate)
    || !closeEnough(gate.delta, delta) || gate.percentLimit !== percentLimit
    || gate.absoluteLimit !== absoluteLimit || gate.passed !== passed
    || (percent === null ? gate.percent !== null : !closeEnough(gate.percent, percent))) {
    throw new Error('Runtime acceptance gate 与原始样本或固定门槛不一致')
  }
}

export function summarizeRuntimeAcceptance(evidence, expected, onDevice, gateExceptions = []) {
  if (evidence.target !== expected.target) {
    throw new Error(`Runtime acceptance target 不匹配：expected ${expected.target}, got ${evidence.target}`)
  }
  if (evidence.dshVersion !== expected.dshVersion || evidence.nodeVersion !== expected.nodeVersion) {
    throw new Error('Runtime acceptance DSH/Node 版本与 runtime lock 不匹配')
  }
  if (evidence.seaSha256 !== expected.seaSha256) {
    throw new Error('Runtime acceptance SEA SHA256 与当前产物不匹配')
  }
  if (evidence.environment.runs < minimumPerformanceRuns || evidence.environment.idleSeconds < minimumIdleSeconds) {
    throw new Error(`Runtime acceptance 至少需要 ${minimumPerformanceRuns} 次样本和 ${minimumIdleSeconds} 秒 RSS 稳态窗口`)
  }
  for (const name of ['standard', 'seaFirstCache', 'seaWarm']) {
    const group = evidence.groups[name]
    if (group.samples.length !== evidence.environment.runs) {
      throw new Error(`Runtime acceptance ${name} 样本数与 environment.runs 不一致`)
    }
    verifyGroupSummary(name, group)
  }
  if (evidence.groups.seaFreshAppData.samples.length !== evidence.environment.freshRuns) {
    throw new Error('Runtime acceptance seaFreshAppData 样本数与 environment.freshRuns 不一致')
  }
  verifyGroupSummary('seaFreshAppData', evidence.groups.seaFreshAppData)
  const expectedEnvironment = expected.target === 'darwin-arm64'
    ? { os: 'darwin', arch: 'arm64' }
    : { os: 'win32', arch: 'x64' }
  if (evidence.environment.os !== expectedEnvironment.os || evidence.environment.arch !== expectedEnvironment.arch) {
    throw new Error('Runtime acceptance environment 与 target 不匹配')
  }
  verifyGate(
    evidence.gates.warmReady,
    evidence.groups.standard.readyGateMs.median,
    evidence.groups.seaWarm.readyGateMs.median,
    20,
    2_000,
  )
  verifyGate(
    evidence.gates.firstCacheReady,
    evidence.groups.standard.readyGateMs.median,
    evidence.groups.seaFirstCache.readyGateMs.median,
    50,
    5_000,
  )
  verifyGate(
    evidence.gates.warmRss,
    evidence.groups.standard.rssKiB.median,
    evidence.groups.seaWarm.rssKiB.median,
    20,
    64,
    1_024,
  )
  // 门槛例外：只有显式声明（runtime/manifest/windows-gate-exceptions.json）且经用户
  // 确认的失败项才可放行；任何未声明的失败项仍然阻断。
  const failedGates = Object.entries(evidence.gates)
    .filter(([, gate]) => !gate.passed)
    .map(([name]) => name)
  const unexceptedGates = failedGates.filter(name => !gateExceptions.includes(name))
  if (unexceptedGates.length > 0) {
    throw new Error(`Runtime acceptance 性能或内存门槛未通过（未声明例外：${unexceptedGates.join(', ')}）`)
  }

  const firstCache = stableMetrics(evidence.groups.seaFirstCache.samples, 'cache', '首次 Cache 指标')
  const firstProxy = stableMetrics(evidence.groups.seaFirstCache.samples, 'proxy', '首次 proxy 指标')
  const warmCache = stableMetrics(evidence.groups.seaWarm.samples, 'cache', 'Warm Cache 指标')
  const warmProxy = stableMetrics(evidence.groups.seaWarm.samples, 'proxy', 'Warm proxy 指标')
  if (!sameMetrics(firstCache, warmCache) || !sameMetrics(firstProxy, warmProxy)) {
    throw new Error('Runtime acceptance 第二次启动的 Cache/proxy 指标发生增长或变化')
  }
  const nativeProbes = evidence.nativeProbes
  if (!nativeProbes.passed || !nativeProbes.fileCountUnchanged || !nativeProbes.contentSizeUnchanged
    || !sameMetrics(nativeProbes.first, nativeProbes.second)) {
    throw new Error('Runtime acceptance Native probe 第二次运行发生增长或未通过')
  }
  if (!metricsWithin(nativeProbes.first, firstCache, nativeProbes.first)) {
    throw new Error('Runtime acceptance 完整 Native probe 未覆盖 Web Ready Cache 指标')
  }
  const maximumCache = nativeProbes.first
  if (onDevice.applicationVersion !== expected.applicationVersion || onDevice.target !== expected.target
    || onDevice.seaSha256 !== expected.seaSha256 || onDevice.passed !== true) {
    throw new Error('Runtime on-device evidence 与当前应用、平台或 SEA 不匹配')
  }
  if (!metricsWithin(onDevice.nativeCache, firstCache, maximumCache)) {
    throw new Error('Runtime on-device Native Cache 不在 Web Ready 与完整 probe 的已验证区间内')
  }
  if (onDevice.controller.files !== nativeCacheControlFiles) {
    throw new Error(`Runtime on-device controller 文件数必须为 ${nativeCacheControlFiles}`)
  }
  // Tauri 在 packager 的 pkg-native tree 外再维护一个 generation manifest 和一个
  // sibling lock；目录本身不计数，因此干净首启固定再计 2 个 Runtime-owned 文件。
  const totalFiles = maximumCache.files + firstProxy.files + nativeCacheControlFiles
  if (totalFiles > runtimeOwnedFileLimit) {
    throw new Error(`Runtime-owned 首次运行文件 ${totalFiles} 超过上限 ${runtimeOwnedFileLimit}`)
  }

  return {
    status: 'present',
    schemaVersion: evidence.schemaVersion,
    target: evidence.target,
    dshVersion: evidence.dshVersion,
    nodeVersion: evidence.nodeVersion,
    seaSha256: evidence.seaSha256,
    environment: evidence.environment,
    groups: evidence.groups,
    gates: evidence.gates,
    firstRun: {
      nativeCacheAtWebReady: firstCache,
      nativeCacheAfterCoreProbes: nativeProbes.first,
      nativeCacheOnDevice: onDevice.nativeCache,
      dshProxy: firstProxy,
      nativeCacheControl: {
        ...onDevice.controller,
        contents: ['generation-manifest', 'sibling-lock'],
      },
      otherRuntimeOwned: { files: 0, bytes: 0, allocatedBytes: 0, status: 'none-observed' },
      totalFiles,
      totalBytes: maximumCache.bytes + firstProxy.bytes + onDevice.controller.bytes,
      totalAllocatedBytes: maximumCache.allocatedBytes + firstProxy.allocatedBytes + onDevice.controller.allocatedBytes,
      fileLimit: runtimeOwnedFileLimit,
      passed: true,
    },
    warmRun: {
      nativeCache: warmCache,
      dshProxy: warmProxy,
      fileCountUnchanged: true,
    },
    freshAppData: evidence.groups.seaFreshAppData,
    nativeProbes,
    passed: true,
    gateExceptions: failedGates,
  }
}
