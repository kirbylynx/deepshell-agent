import { homedir } from 'node:os'

const SECRET_VALUE = '[REDACTED_SECRET]'
const PATH_VALUE = '[REDACTED_PATH]'
const CONTENT_VALUE = '[REDACTED_CONTENT]'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function uniquePathPrefixes(options) {
  return [
    options.home,
    process.env.HOME,
    homedir(),
    process.env.USERPROFILE,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
  ]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => value.replace(/[\\/]$/, ''))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => b.length - a.length)
}

export function redactText(input, options = {}) {
  let text = String(input ?? '')
  for (const pathPrefix of uniquePathPrefixes(options)) {
    text = text.replace(new RegExp(escapeRegExp(pathPrefix), 'g'), PATH_VALUE)
  }
  return text
    .replace(/\b[A-Za-z]:\\+Users\\+[^\\\r\n"'{}[\],]+(?:\\+[^\\\r\n"'{}[\],]+)*/g, PATH_VALUE)
    .replace(/\/Users\/[^/\r\n"'{}[\],]+(?:\/[^/\r\n"'{}[\],]+)*/g, PATH_VALUE)
    .replace(/\/home\/[^/\r\n"'{}[\],]+(?:\/[^/\r\n"'{}[\],]+)*/g, PATH_VALUE)
    .replace(/(authorization\s*[:=]\s*)bearer\s+[A-Za-z0-9._~+/=-]+/gi, `$1Bearer ${SECRET_VALUE}`)
    .replace(/(cookie\s*[:=]\s*)[^\n\r;]+(?:;[^\n\r]+)?/gi, `$1${SECRET_VALUE}`)
    .replace(/("(?:cookie|authorization|api[_-]?key|startup[_-]?token)"\s*:\s*)"[^"]+"/gi, `$1"${SECRET_VALUE}"`)
    .replace(/(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${SECRET_VALUE}`)
    .replace(/(startup[_-]?token\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${SECRET_VALUE}`)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, SECRET_VALUE)
    .replace(/\b(dsk-[A-Za-z0-9_-]{16,})\b/g, SECRET_VALUE)
    .replace(/\b[A-Za-z0-9_=-]{24,}\.[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}\b/g, SECRET_VALUE)
    .replace(/("(?:prompt|toolOutput|tool_output|content|message)"\s*:\s*)"[^"]{80,}"/gi, `$1"${CONTENT_VALUE}"`)
}

export function assertRedactedText(text) {
  const value = String(text ?? '')
  const leaks = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/i,
    /\bdsk-[A-Za-z0-9_-]{16,}\b/i,
    /authorization\s*[:=]\s*bearer\s+(?!\[REDACTED_SECRET\])/i,
    /"authorization"\s*:\s*"(?!\[REDACTED_SECRET\])/i,
    /cookie\s*[:=]\s*(?!\[REDACTED_SECRET\])/i,
    /"cookie"\s*:\s*"(?!\[REDACTED_SECRET\])/i,
    /api[_-]?key\s*[:=]\s*(?!\[REDACTED_SECRET\])/i,
    /"api[_-]?key"\s*:\s*"(?!\[REDACTED_SECRET\])/i,
    /startup[_-]?token\s*[:=]\s*(?!\[REDACTED_SECRET\])/i,
    /"startup[_-]?token"\s*:\s*"(?!\[REDACTED_SECRET\])/i,
  ]
  const matched = leaks.find(pattern => pattern.test(value))
  if (matched) throw new Error(`脱敏检查失败：${matched}`)
}

export function redactedJson(value) {
  const text = JSON.stringify(value, null, 2)
  const redacted = redactText(text)
  assertRedactedText(redacted)
  return `${redacted}\n`
}
