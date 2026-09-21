export const inject = ['webServer']

export function apply(ctx) {
  const disposeProbe = ctx.webServer.register({
    kind: 'exact',
    path: '/__deepshell/external-plugin-probe',
    handler(_req, res) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ plugin: 'external-fixture', loaded: true }))
    }
  })
  const disposeError = ctx.webServer.register({
    kind: 'exact',
    path: '/__deepshell/external-plugin-error',
    handler() {
      throw new Error('intentional external plugin request failure')
    }
  })
  return () => {
    disposeError()
    disposeProbe()
  }
}
