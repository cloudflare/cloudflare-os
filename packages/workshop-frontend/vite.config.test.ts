import { createServer as createViteServer, type ConfigEnv, type UserConfig, type UserConfigExport } from 'vite'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>()
  return {
    ...actual,
    loadEnv: () => ({
      VITE_BACKEND_HOST: 'backend.from-env.test:9999',
      VITE_FRONTEND_ERROR_REPORTING: 'true',
    }),
  }
})

import config from './vite.config'

async function resolveConfig(value: UserConfigExport): Promise<UserConfig> {
  if (typeof value !== 'function') return value
  const env: ConfigEnv = { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false }
  return await value(env)
}

describe('Vite development proxy', () => {
  it('uses loaded environment values for the proxy and source maps', async () => {
    const resolved = await resolveConfig(config)
    expect(resolved.server?.proxy).toMatchObject({
      '/api/client-errors': 'http://backend.from-env.test:9999',
      '/api/device-session/callback': 'http://backend.from-env.test:9999',
      '/api/site-logo': 'http://backend.from-env.test:9999',
      '/gatekeeper/': 'http://backend.from-env.test:9999',
    })
    expect(resolved.build?.sourcemap).toBe('hidden')
  })
})


it('keeps attachment tickets out of actual Vite proxy error logs', async () => {
  const upstream = createServer((request, response) => {
    if (request.url?.endsWith('/ok')) {
      response.writeHead(200, {'Content-Disposition': 'attachment; filename=setup.cfosoperator'})
      response.end(request.headers.cookie)
    } else {
      request.socket.destroy()
    }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Expected HTTP fixture')
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const resolved = await resolveConfig(config)
  const vite = await createViteServer({
    configFile: false,
    customLogger: resolved.customLogger,
    clearScreen: false,
    optimizeDeps: {noDiscovery: true, include: []},
    server: {host: '127.0.0.1', port: 0, hmr: false, preTransformRequests: false,
      proxy: {'/gatekeeper/': `http://127.0.0.1:${address.port}`}},
  })
  try {
    await vite.listen()
    const frontend = vite.httpServer?.address()
    if (!frontend || typeof frontend === 'string') throw new Error('Expected Vite fixture')
    const origin = `http://127.0.0.1:${frontend.port}`
    const success = await fetch(`${origin}/gatekeeper/scheduler/ok`, {headers: {cookie: 'session=fixture'}})
    expect(success.headers.get('Content-Disposition')).toBe('attachment; filename=setup.cfosoperator')
    expect(await success.text()).toBe('session=fixture')
    const failed = await fetch(`${origin}/gatekeeper/scheduler/exports/one-use-ticket-fixture`)
    expect(failed.status).toBe(500)
    await failed.text()
    const output = logged.mock.calls.flat().join('\n')
    expect(output).toContain('Gatekeeper development proxy failed.')
    expect(output).not.toContain('one-use-ticket-fixture')
    expect(output).not.toContain('/gatekeeper/')
  } finally {
    await vite.close()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    logged.mockRestore()
  }
})
