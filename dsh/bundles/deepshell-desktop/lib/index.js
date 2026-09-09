import { rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export const inject = ['webServer']

function hashInline(html, tag) {
  const hashes = []
  const expression = new RegExp(`<${tag}(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  for (const match of html.matchAll(expression)) {
    const digest = createHash('sha256').update(match[1]).digest('base64')
    hashes.push(`'sha256-${digest}'`)
  }
  return [...new Set(hashes)]
}

function injectCsp(html) {
  const scripts = hashInline(html, 'script')
  const policy = [
    "default-src 'self'", "base-uri 'self'", "object-src 'none'",
    "form-action 'self'", "img-src 'self' data: blob:", "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' blob: 'unsafe-eval' ${scripts.join(' ')}`, "worker-src 'self' blob:",
    "connect-src 'self' ws://127.0.0.1:*"
  ].join('; ')
  return html.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<meta http-equiv="Content-Security-Policy" content="${policy}">`)
}

function sameAuthority(req, port) {
  const expected = `127.0.0.1:${port}`
  return req.headers.host === expected && req.headers.origin === `http://${expected}`
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 4096) throw new Error('ready payload too large')
  }
  return JSON.parse(body)
}

export function apply(ctx) {
  const instanceId = process.env.DSH_DESKTOP_INSTANCE_ID
  const readyFile = process.env.DSH_DESKTOP_READY_FILE
  if (!instanceId || !readyFile) throw new Error('deepshell-desktop: desktop handshake environment missing')
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: '__DEEPSHELL_INSTANCE_ID__', value: instanceId })
  })
  ctx.effect(() => ctx.webServer.tapIndex(injectCsp), 'deepshell-desktop: strict CSP')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/__deepshell/client-ready',
    async handler(req, res) {
      if (req.method !== 'POST' || !sameAuthority(req, ctx.webServer.port)) {
        res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return
      }
      try {
        const payload = await readBody(req)
        if (payload?.instanceId !== instanceId || payload?.baseline !== 'ready') throw new Error('invalid ready payload')
        const temporary = join(dirname(readyFile), `.client-ready-${process.pid}.tmp`)
        await writeFile(temporary, JSON.stringify({
          instanceId,
          baseline: 'ready',
          pid: process.pid,
          host: '127.0.0.1',
          port: ctx.webServer.port
        }), { mode: 0o600 })
        await rename(temporary, readyFile)
        res.writeHead(204, { 'cache-control': 'no-store' }); res.end()
      } catch {
        res.writeHead(400, { 'cache-control': 'no-store' }); res.end()
      }
    }
  }), 'deepshell-desktop: client ready route')
}
