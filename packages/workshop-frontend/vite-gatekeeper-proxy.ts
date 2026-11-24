import { request } from 'node:http'
import type { Plugin } from 'vite'

/** Proxy attachment requests without disclosing bearer tickets in Vite's errors or debug traces. */
export function gatekeeperDevProxy(backendHost: string): Plugin {
  return {
    name: 'gatekeeper-download-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/gatekeeper/')) return next()
        const target = new URL(req.url, `http://${backendHost}`)
        req.url = '/gatekeeper/[redacted]'
        req.originalUrl = req.url
        const fail = () => {
          if (res.destroyed || res.writableEnded) return
          server.config.logger.error('Gatekeeper development proxy failed.')
          if (res.headersSent) res.destroy()
          else res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Gatekeeper download failed.')
        }
        const upstream = request(target, {
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
