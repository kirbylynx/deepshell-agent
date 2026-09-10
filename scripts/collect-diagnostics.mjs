import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, homedir, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { readLock, root } from './lib/runtime.mjs'
import { assertRedactedText, redactText, redactedJson } from './lib/redaction.mjs'

function argValue(name, fallback) {
  const prefix = `${name}=`
  const inline = process.argv.find(value => value.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function defaultLogFile() {
  if (process.platform === 'darwin') return resolve(homedir(), 'Library/Application Support/com.deepshell.agent/logs/app.jsonl')
  if (process.platform === 'win32') return resolve(process.env.APPDATA ?? homedir(), 'com.deepshell.agent/logs/app.jsonl')
  return resolve(homedir(), '.local/share/com.deepshell.agent/logs/app.jsonl')
}

function lastLines(text, limit) {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - limit)).join('\n')
}

const lock = await readLock()
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const outputDirectory = resolve(argValue('--output', resolve(root, 'runtime/staging/diagnostics', new Date().toISOString().replace(/[:.]/g, '-'))))
const logFile = resolve(argValue('--log-file', defaultLogFile()))
const lineLimit = Number.parseInt(argValue('--line-limit', '500'), 10)
if (!Number.isSafeInteger(lineLimit) || lineLimit <= 0 || lineLimit > 5000) throw new Error('--line-limit 必须是 1 到 5000 之间的整数')

await mkdir(outputDirectory, { recursive: true })

let logIncluded = false
let logReadError = null
let redactedLog = ''
if (await exists(logFile)) {
  try {
    logIncluded = true
    redactedLog = redactText(lastLines(await readFile(logFile, 'utf8'), lineLimit))
    assertRedactedText(redactedLog)
    await writeFile(resolve(outputDirectory, 'app-log.redacted.jsonl'), redactedLog.endsWith('\n') ? redactedLog : `${redactedLog}\n`, { mode: 0o600 })
  } catch (error) {
    logReadError = error.message
  }
}

const runtimeManifest = await exists(resolve(root, 'runtime/manifest/runtime-lock.json'))
const profileManifestPath = resolve(root, 'runtime/profile-template/template-manifest.json')
let profileStatus = 'missing'
try {
  const profile = JSON.parse(await readFile(profileManifestPath, 'utf8'))
  profileStatus = profile.dshVersion === lock.dsh.version ? 'pass' : 'version-mismatch'
} catch (error) {
  if (error?.code !== 'ENOENT') profileStatus = 'error'
}

const diagnostics = {
  schemaVersion: 1,
  application: {
    name: 'DeepShell Agent',
    version: rootPackage.version
  },
  platform: {
    os: platform(),
    release: release(),
    arch: arch()
  },
  runtime: {
    node: lock.node.version,
    dsh: lock.dsh.version,
    permissionMode: 'workspace-write',
    telemetryMode: 'DISABLED'
  },
  checks: {
    runtimeManifest: runtimeManifest ? 'pass' : 'missing',
    profileTemplate: profileStatus
  },
  logs: {
    included: logIncluded,
    redacted: logIncluded && logReadError === null,
    lineLimit,
    readError: logReadError === null ? undefined : redactText(logReadError)
  },
  privacy: {
    excludes: ['api keys', 'cookies', 'startup tokens', 'authorization headers', 'prompts', 'tool outputs', 'workspace file contents'],
    pathPolicy: 'absolute user paths are redacted before export'
  }
}

await writeFile(resolve(outputDirectory, 'diagnostics.json'), redactedJson(diagnostics), { mode: 0o600 })
await writeFile(resolve(outputDirectory, 'README.txt'), [
  'DeepShell Agent diagnostics bundle',
  '',
  'This bundle is generated locally and is not uploaded automatically.',
  'Review diagnostics.json and app-log.redacted.jsonl before sharing.',
  'Prompts, tool outputs, API keys, cookies, startup tokens, and Authorization headers are excluded or redacted by policy.',
  ''
].join('\n'), { mode: 0o600 })

console.log(`diagnostics written: ${outputDirectory}`)
