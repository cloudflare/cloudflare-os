import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
    })
    expect(resolved.build?.sourcemap).toBe('hidden')
    expect(resolved.plugins).toContainEqual(expect.objectContaining({name: 'gatekeeper-download-proxy'}))
  })
})

it('keeps attachment tickets out of actual Vite error and debug traces', () => {
  const pluginUrl = new URL('./vite-gatekeeper-proxy.ts', import.meta.url).href
  const program = `
    import {createServer as createUpstream} from 'node:http';
    import {createServer as createViteServer} from 'vite';
    import {gatekeeperDevProxy} from ${JSON.stringify(pluginUrl)};
    const ticket = 'one-use-ticket-fixture';
    let forwarded = 0;
    const upstream = createUpstream((req, res) => {
      if (req.url.includes(ticket)) ++forwarded;
      if (req.url.endsWith('/fail')) return req.socket.destroy();
      res.writeHead(200, {'Content-Disposition': 'attachment; filename=setup.cfosoperator'});
      res.end(req.headers.cookie);
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const vite = await createViteServer({configFile: false, clearScreen: false,
      optimizeDeps: {noDiscovery: true, include: []},
      plugins: [gatekeeperDevProxy('127.0.0.1:' + upstream.address().port)],
      server: {host: '127.0.0.1', port: 0, hmr: false, preTransformRequests: false}});
    try {
      await vite.listen();
      const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
      const ok = await fetch(origin + '/gatekeeper/scheduler/' + ticket, {headers: {cookie: 'session=fixture'}});
      if (ok.status !== 200 || await ok.text() !== 'session=fixture' ||
          ok.headers.get('Content-Disposition') !== 'attachment; filename=setup.cfosoperator') throw Error('Forwarding failed');
      const failed = await fetch(origin + '/gatekeeper/scheduler/' + ticket + '/fail');
      await failed.text();
      if (failed.status !== 502 || forwarded !== 2) throw Error('Failure handling failed');
      console.log('FIXTURE_PASSED');
    } finally {
      await vite.close();
      await new Promise(resolve => upstream.close(resolve));
    }
  `
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: {...process.env, DEBUG: 'vite:*'}, encoding: 'utf8', timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = child.stdout + child.stderr
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(output).toContain('FIXTURE_PASSED')
  expect(output).toContain('Gatekeeper development proxy failed.')
  expect(output).toContain('vite:time')
  expect(output).toContain('/gatekeeper/[redacted]')
  expect(output).not.toContain('one-use-ticket-fixture')
})
