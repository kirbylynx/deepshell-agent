import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { platformInputDigest } from './source-inputs.mjs'

const sha256Pattern = /^[0-9a-f]{64}$/
const commitPattern = /^[0-9a-f]{40}$/
const allowedIdentitySources = new Set(['package-report', 'package-manifest'])

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isSha256(value) {
  return sha256Pattern.test(value ?? '')
}

function isCommit(value) {
  return commitPattern.test(value ?? '')
}

function identityFromRuntime(runtime, applicationVersion, source) {
  if (runtime?.format !== 'sea' || !['darwin-arm64', 'win32-x64'].includes(runtime.platform) ||
      typeof applicationVersion !== 'string' || applicationVersion === '' ||
      !isSha256(runtime.sourceInputSha256) || !isCommit(runtime.artifactSourceCommit) ||
      !Number.isSafeInteger(runtime.executable?.bytes) || runtime.executable.bytes <= 0 ||
      !isSha256(runtime.executable?.sha256) || typeof runtime.provisional !== 'boolean') {
    return null
  }
  return {
    schemaVersion: 1,
    status: 'present',
    source,
    application: { name: 'DeepShell Agent', version: applicationVersion },
    platform: runtime.platform,
    sourceInputSha256: runtime.sourceInputSha256,
    artifactSourceCommit: runtime.artifactSourceCommit,
    seaRuntime: {
      sha256: runtime.executable.sha256,
      bytes: runtime.executable.bytes,
      provisional: runtime.provisional,
    },
  }
}

function identityFromPackageReport(report) {
  if (report?.schemaVersion !== 3) return null
  return identityFromRuntime(report.runtime, report.application?.version, 'package-report')
}

function identityFromPackageManifest(manifest) {
  if (manifest?.schemaVersion !== 6) return null
  return identityFromRuntime(manifest.runtime, manifest.applicationVersion, 'package-manifest')
}

export async function collectReleaseEvidenceIdentity({
  root,
  packageReportPath = resolve(root, 'runtime/staging/package-report.json'),
  packageManifestPath = resolve(root, 'runtime/staging/package-release.json'),
  expectedVersion,
} = {}) {
  const report = await optionalJson(packageReportPath)
  const reportIdentity = identityFromPackageReport(report)
  if (reportIdentity !== null) {
    return finalizeIdentity(reportIdentity, { root, expectedVersion })
  }

  const manifest = await optionalJson(packageManifestPath)
  const manifestIdentity = identityFromPackageManifest(manifest)
  if (manifestIdentity !== null) {
    return finalizeIdentity(manifestIdentity, { root, expectedVersion })
  }

  return {
    schemaVersion: 1,
    status: 'missing',
    reason: await exists(packageReportPath) || await exists(packageManifestPath)
      ? 'release evidence exists but does not contain finalized SEA identity'
      : 'release package report or package manifest is not available yet',
  }
}

async function finalizeIdentity(identity, { root, expectedVersion }) {
  if (expectedVersion !== undefined && identity.application.version !== expectedVersion) {
    return {
      ...identity,
      status: 'stale-version',
      expectedVersion,
      foundVersion: identity.application.version,
    }
  }
  if (root !== undefined) {
    const currentSourceInputSha256 = await platformInputDigest(root, identity.platform)
    if (identity.sourceInputSha256 !== currentSourceInputSha256) {
      return {
        ...identity,
        status: 'stale-source-input',
        currentSourceInputSha256,
      }
    }
  }
  return identity
}

export function assertReleaseEvidenceIdentityMatchesReport(evidence, report, label) {
  const expected = identityFromPackageReport(report)
  if (expected === null) {
    throw new Error('combined release staging 的 package report 缺少可绑定的 SEA 身份')
  }
  assertReleaseEvidenceIdentityMatchesExpected(evidence, expected, label)
}

export function assertReleaseEvidenceIdentityMatchesExpected(evidence, expected, label) {
  const identity = evidence?.releaseEvidenceIdentity
  if (identity?.status !== 'present') {
    throw new Error(`combined release staging 要求 ${label} 绑定完整 SEA 身份`)
  }
  if (identity.schemaVersion !== 1 || identity.application?.name !== 'DeepShell Agent' ||
      !allowedIdentitySources.has(identity.source)) {
    throw new Error(`combined release staging 的 ${label} releaseEvidenceIdentity schema/application/source 无效`)
  }
  const mismatches = []
  if (expected.status !== 'present') mismatches.push('expected identity')
  if (identity.application?.version !== expected.application.version) mismatches.push('version')
  if (identity.platform !== expected.platform) mismatches.push('platform')
  if (identity.sourceInputSha256 !== expected.sourceInputSha256) mismatches.push('source input digest')
  if (identity.artifactSourceCommit !== expected.artifactSourceCommit) mismatches.push('artifact source commit')
  if (identity.seaRuntime?.sha256 !== expected.seaRuntime.sha256) mismatches.push('SEA sha256')
  if (identity.seaRuntime?.bytes !== expected.seaRuntime.bytes) mismatches.push('SEA bytes')
  if (identity.seaRuntime?.provisional !== expected.seaRuntime.provisional) mismatches.push('SEA provisional')
  if (expected.seaRuntime.provisional !== false) mismatches.push('finalized SEA')
  if (mismatches.length > 0) {
    throw new Error(`combined release staging 的 ${label} SEA 身份与 package report 不一致：${mismatches.join(', ')}`)
  }
}
