import { describe, expect, it } from 'vitest'
import {
  minimumIdleSeconds,
  minimumPerformanceRuns,
  nativeCacheControlFiles,
  runtimeOwnedFileLimit,
  summarizeRuntimeAcceptance,
} from '../../scripts/lib/runtime-acceptance.mjs'

function samples(readyGateMs: number, rssKiB: number, cacheFiles: number, proxyFiles: number) {
  return Array.from({ length: 10 }, (_, index) => ({
    sample: index + 1,
    readyGateMs,
    rssKiB,
    cache: { files: cacheFiles, bytes: cacheFiles * 10, allocatedBytes: cacheFiles * 16 },
    proxy: { files: proxyFiles, bytes: proxyFiles * 10, allocatedBytes: proxyFiles * 16 },
  }))
}

function group(readyGateMs: number, rssKiB: number, cacheFiles: number, proxyFiles: number) {
  return {
    samples: samples(readyGateMs, rssKiB, cacheFiles, proxyFiles),
    readyGateMs: { median: readyGateMs, max: readyGateMs },
    rssKiB: { median: rssKiB, max: rssKiB },
  }
}

function evidence() {
  return {
    schemaVersion: 1,
    target: 'darwin-arm64',
    dshVersion: '0.1.5-rc.2',
    nodeVersion: '24.20.0',
    seaSha256: 'a'.repeat(64),
    environment: { os: 'darwin', arch: 'arm64', browser: 'Chromium', runs: 10, freshRuns: 1, idleSeconds: 30 },
    groups: {
      standard: group(4_000, 200_000, 0, 1_660),
      seaFirstCache: group(5_500, 210_000, 44, 1_660),
      seaWarm: group(4_500, 210_000, 44, 1_660),
      seaFreshAppData: {
        samples: samples(7_000, 220_000, 44, 1_660).slice(0, 1),
        readyGateMs: { median: 7_000, max: 7_000 },
        rssKiB: { median: 220_000, max: 220_000 },
      },
    },
    nativeProbes: {
      probes: ['identity', 'worker', 'self-spawn', 'node-pty', 'sharp', 'koffi', 'flock', 'require-builtin', 'client-resolution'],
      first: { files: 51, bytes: 510, allocatedBytes: 816 },
      second: { files: 51, bytes: 510, allocatedBytes: 816 },
      fileCountUnchanged: true,
      contentSizeUnchanged: true,
      passed: true,
    },
    gates: {
      warmReady: {
        baseline: 4_000, candidate: 4_500, delta: 500, percent: 12.5,
        percentLimit: 20, absoluteLimit: 2_000, passed: true,
      },
      firstCacheReady: {
        baseline: 4_000, candidate: 5_500, delta: 1_500, percent: 37.5,
        percentLimit: 50, absoluteLimit: 5_000, passed: true,
      },
      warmRss: {
        baseline: 200_000, candidate: 210_000, delta: 10_000, percent: 5,
        percentLimit: 20, absoluteLimit: 64, passed: true,
      },
    },
    passed: true,
  }
}

const expected = {
  applicationVersion: '0.1.5',
  target: 'darwin-arm64',
  dshVersion: '0.1.5-rc.2',
  nodeVersion: '24.20.0',
  seaSha256: 'a'.repeat(64),
}

const onDevice = {
  schemaVersion: 1,
  applicationVersion: '0.1.5',
  target: 'darwin-arm64',
  seaSha256: 'a'.repeat(64),
  nativeCache: { files: 44, bytes: 440, allocatedBytes: 704 },
  controller: { files: 2, bytes: 200, allocatedBytes: 8_192 },
  passed: true,
}

describe('Runtime acceptance evidence', () => {
  it('固定最少样本、稳态窗口和 Runtime-owned 文件上限', () => {
    expect(minimumPerformanceRuns).toBe(10)
    expect(minimumIdleSeconds).toBe(30)
    expect(runtimeOwnedFileLimit).toBe(2_000)
    expect(nativeCacheControlFiles).toBe(2)
    const summary = summarizeRuntimeAcceptance(evidence(), expected, onDevice)
    expect(summary.firstRun.totalFiles).toBe(1_713)
    expect(summary.firstRun.totalBytes).toBe(17_310)
    expect(summary.firstRun.totalAllocatedBytes).toBe(35_568)
    expect(summary.firstRun.nativeCacheControl.bytes).toBe(200)
    expect(summary.warmRun.fileCountUnchanged).toBe(true)
    expect(summary.passed).toBe(true)
  })

  it('拒绝篡改后的聚合、gate、SEA 摘要与 Warm 文件增长', () => {
    const aggregate = evidence()
    aggregate.groups.seaWarm.readyGateMs.median = 1
    expect(() => summarizeRuntimeAcceptance(aggregate, expected, onDevice)).toThrow(/聚合值/)

    const gate = evidence()
    gate.gates.warmReady.passed = false
    expect(() => summarizeRuntimeAcceptance(gate, expected, onDevice)).toThrow(/gate/)

    const digest = evidence()
    digest.seaSha256 = 'b'.repeat(64)
    expect(() => summarizeRuntimeAcceptance(digest, expected, onDevice)).toThrow(/SHA256/)

    const growth = evidence()
    growth.groups.seaWarm.samples.forEach(sample => { sample.proxy.files += 1 })
    expect(() => summarizeRuntimeAcceptance(growth, expected, onDevice)).toThrow(/发生增长或变化/)

    const probeGrowth = evidence()
    probeGrowth.nativeProbes.second.files += 1
    expect(() => summarizeRuntimeAcceptance(probeGrowth, expected, onDevice)).toThrow(/Native probe/)

    const probeUndercount = evidence()
    probeUndercount.nativeProbes.first.bytes = 400
    probeUndercount.nativeProbes.second.bytes = 400
    expect(() => summarizeRuntimeAcceptance(probeUndercount, expected, onDevice)).toThrow(/未覆盖 Web Ready Cache/)
  })

  it('拒绝超过 2,000 个 Runtime-owned 文件', () => {
    const value = evidence()
    value.groups.seaFirstCache.samples.forEach(sample => { sample.proxy.files = 1_948 })
    value.groups.seaWarm.samples.forEach(sample => { sample.proxy.files = 1_948 })
    expect(() => summarizeRuntimeAcceptance(value, expected, onDevice)).toThrow(/超过上限 2000/)
  })

  it('拒绝错误设备证据、越界 Cache 和缺少控制文件', () => {
    expect(() => summarizeRuntimeAcceptance(evidence(), expected, {
      ...onDevice,
      seaSha256: 'b'.repeat(64),
    })).toThrow(/on-device evidence/)

    expect(() => summarizeRuntimeAcceptance(evidence(), expected, {
      ...onDevice,
      nativeCache: { files: 52, bytes: 520, allocatedBytes: 832 },
    })).toThrow(/已验证区间/)

    expect(() => summarizeRuntimeAcceptance(evidence(), expected, {
      ...onDevice,
      controller: { files: 1, bytes: 100, allocatedBytes: 4_096 },
    })).toThrow(/文件数必须为 2/)
  })
})
