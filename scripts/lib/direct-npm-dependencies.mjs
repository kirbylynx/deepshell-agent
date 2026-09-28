import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function stripYamlQuotes(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseRootImporterDirectDependencies(lockText) {
  const result = { dependencies: {}, devDependencies: {} }
  const lines = lockText.split(/\r?\n/)
  let inImporters = false
  let inRootImporter = false
  let section = null
  let currentPackage = null

  for (const line of lines) {
    if (line === 'importers:') {
      inImporters = true
      continue
    }
    if (!inImporters) continue
    if (/^\S/.test(line) && line !== 'importers:') break

    if (/^  \.:$/.test(line)) {
      inRootImporter = true
      section = null
      currentPackage = null
      continue
    }
    if (!inRootImporter) continue
    if (/^  [^\s].+:$/.test(line) && !/^  \.:$/.test(line)) break

    const sectionMatch = line.match(/^    (dependencies|devDependencies):$/)
    if (sectionMatch) {
      section = sectionMatch[1]
      currentPackage = null
      continue
    }
    const packageMatch = line.match(/^      (.+):$/)
    if (section && packageMatch) {
      currentPackage = stripYamlQuotes(packageMatch[1])
      result[section][currentPackage] = {}
      continue
    }
    const fieldMatch = line.match(/^        (specifier|version):\s*(.+)$/)
    if (section && currentPackage && fieldMatch) {
      result[section][currentPackage][fieldMatch[1]] = stripYamlQuotes(fieldMatch[2])
    }
  }

  return result
}

function versionFromNpmAlias(specifier) {
  const raw = specifier.slice('npm:'.length)
  const at = raw.lastIndexOf('@')
  return at > 0 ? raw.slice(at + 1) : null
}

function exactVersionFromSpecifier(name, specifier) {
  const version = specifier.startsWith('npm:')
    ? versionFromNpmAlias(specifier)
    : specifier
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error(`direct npm ${name} 必须使用 package.json 精确 registry 版本，当前 specifier=${specifier}`)
  }
  return version
}

function versionFromLockEntry(name, entry) {
  if (typeof entry?.version !== 'string' || entry.version === '') {
    throw new Error(`pnpm-lock root importer 缺少 direct npm ${name} 的 version`)
  }
  const withoutPeers = entry.version.split('(')[0]
  if (withoutPeers.startsWith('npm:')) {
    const version = versionFromNpmAlias(withoutPeers)
    if (!version) throw new Error(`pnpm-lock root importer 无法解析 direct npm ${name} 的 alias version：${entry.version}`)
    return version
  }
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(withoutPeers)) return withoutPeers
  const at = withoutPeers.lastIndexOf('@')
  if (at > 0) {
    const version = withoutPeers.slice(at + 1)
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return version
  }
  throw new Error(`pnpm-lock root importer 无法解析 direct npm ${name} 的 version：${entry.version}`)
}

export function expectedDirectDependencyVersions(rootPackage, lockText) {
  const importer = parseRootImporterDirectDependencies(lockText)
  const expected = new Map()
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, specifier] of Object.entries(rootPackage[section] ?? {})) {
      const lockEntry = importer[section]?.[name]
      if (!lockEntry) {
        throw new Error(`pnpm-lock root importer 缺少 direct npm ${name}`)
      }
      if (lockEntry.specifier !== specifier) {
        throw new Error(`direct npm ${name} 的 package.json specifier 与 pnpm-lock 不一致：${specifier} != ${lockEntry.specifier}`)
      }
      const packageVersion = exactVersionFromSpecifier(name, specifier)
      const lockVersion = versionFromLockEntry(name, lockEntry)
      if (packageVersion !== lockVersion) {
        throw new Error(`direct npm ${name} 的 package.json 精确版本与 pnpm-lock 不一致：${packageVersion} != ${lockVersion}`)
      }
      expected.set(name, {
        section,
        specifier,
        version: lockVersion,
        scope: name === '@yao-pkg/pkg'
          ? 'embedded-sea-bootstrap'
          : section === 'dependencies' ? 'build-and-runtime-client' : 'build-or-test-only',
      })
    }
  }
  return expected
}

export async function collectDirectBuildAndTestNpmPackages(repoRoot) {
  const rootPackage = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'))
  const lockText = await readFile(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const expected = expectedDirectDependencyVersions(rootPackage, lockText)
  const packages = []
  for (const [name, dependency] of [...expected.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const manifest = JSON.parse(await readFile(resolve(repoRoot, 'node_modules', name, 'package.json'), 'utf8'))
    if (manifest.version !== dependency.version) {
      throw new Error(`direct npm ${name} 版本漂移：node_modules=${manifest.version ?? 'unknown'}, expected=${dependency.version}`)
    }
    packages.push({
      name,
      version: dependency.version,
      license: manifest.license ?? 'UNDECLARED',
      scope: dependency.scope,
    })
  }
  return packages
}
