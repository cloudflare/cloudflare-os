import { request, type IncomingMessage } from 'node:http'
import type { Connect, Plugin } from 'vite'

/** Proxy attachment requests without disclosing bearer tickets in Vite's errors or debug traces. */
export function gatekeeperDevProxy(backendHost: string): Plugin {
  return {
    name: 'gatekeeper-download-proxy',
    configureServer(server) {
      // Vitest's transform-only middleware server has no public HTTP listener or download route.
      const httpServer = server.httpServer
      if (!httpServer) return
      const targets = new WeakMap<IncomingMessage, URL | null>()
      const capture = (req: Connect.IncomingMessage) => {
        if (!req.url?.startsWith('/gatekeeper/')) return
        const original = req.url
        req.url = '/gatekeeper/[redacted]'
        req.originalUrl = req.url
        const target = new URL(original, `http://${backendHost}`)
        targets.set(req, target.pathname.startsWith('/gatekeeper/') ? target : null)
      }
      // Connect logs originalUrl before invoking middleware. Capture at the HTTP boundary,
      // keeping the real target in a private map rather than any framework-visible URL field.
      httpServer.prependListener('request', capture)
      httpServer.once('close', () => httpServer.off('request', capture))
      server.middlewares.use((req, res, next) => {
        const target = targets.get(req)
        targets.delete(req)
        if (target === undefined) return next()
        if (target === null) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid gatekeeper path.')
          return
        }
        const fail = () => {
          if (res.destroyed || res.writableEnded) return
          server.config.logger.error('Gatekeeper development proxy failed.')
          if (res.headersSent) res.destroy()
          else res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Gatekeeper download failed.')
        }
        const upstream = request(target, {
          // The configured local backend is the credential recipient. Environment forward
          // proxies must not receive attachment tickets or the browser's session cookie.
          agent: false,
          method: req.method,
          headers: { ...req.headers, host: backendHost, connection: 'close' },
        }, response => {
          response.once('error', fail)
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
        })
        upstream.once('error', fail)
        res.once('close', () => upstream.destroy())
        req.pipe(upstream)
      })
    },
  }
}
