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
    import {createServer as createUpstream, request} from 'node:http';
    import {createServer as createViteServer} from 'vite';
    import {gatekeeperDevProxy} from ${JSON.stringify(pluginUrl)};
    const ticket = 'one-use-ticket-fixture';
    let forwarded = 0, totalRequests = 0;
    const upstream = createUpstream((req, res) => {
      ++totalRequests;
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
      for (const path of ['/gatekeeper/' + ticket + '/../../api/private', '/gatekeeper/%2e%2e/api/private']) {
        const rejected = await new Promise((resolve, reject) => {
          const req = request({hostname: '127.0.0.1', port: vite.httpServer.address().port, path}, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject); req.end();
        });
        if (rejected !== 400 || totalRequests !== 2) throw Error('Traversal reached upstream');
      }
      console.log('FIXTURE_PASSED');
    } finally {
      await vite.close();
      await new Promise(resolve => upstream.close(resolve));
    }
  `
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: {...process.env, DEBUG: '*'}, encoding: 'utf8', timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = child.stdout + child.stderr
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(output).toContain('FIXTURE_PASSED')
  expect(output).toContain('Gatekeeper development proxy failed.')
  expect(output).toContain('vite:time')
  expect(output).toContain('connect:dispatcher')
  expect(output).toContain('/gatekeeper/[redacted]')
  expect(output).not.toContain('one-use-ticket-fixture')
})

it.each(['log', 'debug'])('keeps tickets out of the real Wrangler upstream at %s level', level => {
  const plugin = new URL('./vite-gatekeeper-proxy.ts', import.meta.url).href
  const configuration = new URL('../../scripts/dev-server-config.ts', import.meta.url).href
  const binEntry = new URL('../../scripts/bin-entry.ts', import.meta.url).href
  const teardown = new URL('../../scripts/kill-process-tree.ts', import.meta.url).href
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
  const program = `
    import {createServer} from 'node:net';
    import {spawn, spawnSync} from 'node:child_process';
    import {mkdtemp, writeFile, rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    import {createServer as createViteServer} from 'vite';
    import {gatekeeperDevProxy} from ${JSON.stringify(plugin)};
    import {getDevServerEnv} from ${JSON.stringify(configuration)};
    import {resolveBinEntry} from ${JSON.stringify(binEntry)};
    import {killProcessTree} from ${JSON.stringify(teardown)};
    const dir = await mkdtemp(join(tmpdir(), 'gatekeeper-log-fixture-'));
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    await writeFile(join(dir, 'wrangler.json'), JSON.stringify({
      name: 'gatekeeper-log-fixture', main: 'worker.js', compatibility_date: '2025-01-01', send_metrics: false,
    }));
    await writeFile(join(dir, 'worker.js'), 'export default {fetch(request) { console.info("WORKER_DIAGNOSTIC_VISIBLE"); return new Response(new URL(request.url).pathname, {status: request.url.endsWith("/fail") ? 503 : 200}); }}');
    const build = spawnSync(process.execPath, ['-e', 'console.log("BUILD_SUBPROCESS_OK")', 'fixture-argument'], {cwd: dir, env: getDevServerEnv(process.env), encoding: 'utf8'});
    if (build.status !== 0 || !build.stdout.includes('BUILD_SUBPROCESS_OK')) throw Error('Preload interfered with a build subprocess');
    const child = spawn(process.execPath, [resolveBinEntry(${JSON.stringify(projectRoot)}, 'wrangler'), 'dev',
      '--local', '--port', String(port), '--inspector-port', '0', '--show-interactive-dev-session=false'], {
      cwd: dir, env: getDevServerEnv({...process.env, WRANGLER_LOG: ${JSON.stringify(level)}, WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false'}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    let vite;
    try {
      const backend = 'http://127.0.0.1:' + port;
      const deadline = Date.now() + 15000;
      while (true) {
        try { await fetch(backend + '/health'); break; } catch {}
        if (Date.now() >= deadline || child.exitCode !== null) throw Error('Wrangler did not start');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      vite = await createViteServer({configFile: false, clearScreen: false,
        optimizeDeps: {noDiscovery: true, include: []}, plugins: [gatekeeperDevProxy('127.0.0.1:' + port)],
        server: {host: '127.0.0.1', port: 0, hmr: false, preTransformRequests: false}});
      await vite.listen();
      const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
      const path = '/gatekeeper/scheduler/upstream-ticket-fixture';
      for (const [suffix, status] of [['', 200], ['/fail', 503]]) {
        const response = await fetch(origin + path + suffix);
        if (response.status !== status || await response.text() !== path + suffix) throw Error('Original upstream route not preserved');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log('UPSTREAM_FIXTURE_PASSED');
    } finally {
      await vite?.close();
      if (child.exitCode === null) await killProcessTree(child.pid);
      await rm(dir, {recursive: true, force: true});
    }
  `
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), env: {...process.env, DEBUG: '*'},
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = child.stdout + child.stderr
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(output).toContain('UPSTREAM_FIXTURE_PASSED')
  expect(output).toContain('/gatekeeper/[redacted] 200')
  expect(output).toContain('/gatekeeper/[redacted] 503')
  expect(output).toContain('/health')
  expect(output).toContain('WORKER_DIAGNOSTIC_VISIBLE')
  expect(output).not.toContain('upstream-ticket-fixture')
}, 35_000)
