import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTreeEscalating } from '../../scripts/kill-process-tree'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
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

it.each(['127.0.0.1', '::1'])('keeps attachment tickets out of actual Vite error and debug traces: %s', backendAddress => {
  const pluginUrl = new URL('./vite-gatekeeper-proxy.ts', import.meta.url).href
  const program = `
    import http, {createServer as createUpstream, request} from 'node:http';
    import {createConnection} from 'node:net';
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
    const address = ${JSON.stringify(backendAddress)};
    const backendHost = address.includes(':') ? '[' + address + ']' : address;
    await new Promise(resolve => upstream.listen(0, address, resolve));
    let proxyRequests = 0;
    const proxy = createUpstream((req, res) => { ++proxyRequests; res.writeHead(502).end(); });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const originalAgent = http.globalAgent;
    http.globalAgent = new http.Agent({proxyEnv: {HTTP_PROXY: 'http://127.0.0.1:' + proxy.address().port, NO_PROXY: ''}});
    // Exercise Node's actual environment proxy path before testing the direct backend route.
    await new Promise((resolve, reject) => {
      const req = request('http://' + backendHost + ':' + upstream.address().port + '/control', res => {
        res.resume(); res.on('end', resolve);
      });
      req.on('error', reject); req.end();
    });
    if (proxyRequests !== 1 || totalRequests !== 0) throw Error('Proxy fixture is inactive');
    proxyRequests = 0;
    const vite = await createViteServer({configFile: false, clearScreen: false,
      optimizeDeps: {noDiscovery: true, include: []},
      plugins: [gatekeeperDevProxy(backendHost + ':' + upstream.address().port)],
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
          const req = request({createConnection: () => createConnection({host: '127.0.0.1', port: vite.httpServer.address().port}), hostname: '127.0.0.1', port: vite.httpServer.address().port, path}, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject); req.end();
        });
        if (rejected !== 400 || totalRequests !== 2) throw Error('Traversal reached upstream');
      }
      if (proxyRequests !== 0) throw Error('Download reached environment proxy');
      console.log('FIXTURE_PASSED');
    } finally {
      http.globalAgent.destroy();
      http.globalAgent = originalAgent;
      await vite.close();
      await new Promise(resolve => upstream.close(resolve));
      await new Promise(resolve => proxy.close(resolve));
    }
  `
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: {...process.env, DEBUG: '*', NODE_DEBUG: 'net'}, encoding: 'utf8', timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = stripVTControlCharacters(child.stdout + child.stderr)
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(output).toContain('FIXTURE_PASSED')
  expect(output).toContain('Gatekeeper development proxy failed.')
  expect(output).toContain('vite:time')
  expect(output).toContain('connect:dispatcher')
  expect(output).toContain('/gatekeeper/[redacted]')
  expect(output).not.toContain('one-use-ticket-fixture')
  expect(output).not.toContain('session=fixture')
  expect(output).toMatch(/NET \d+:/)
}, 20_000)

it.each(['http', 'stream', '*'])('refuses real Vite startup before raw Node traces can receive credentials: %s', trace => {
  const plugin = new URL('./vite-gatekeeper-proxy.ts', import.meta.url).href
  const program = `
    import {createServer} from 'vite';
    import {gatekeeperDevProxy} from ${JSON.stringify(plugin)};
    try {
      const server = await createServer({configFile: false, plugins: [gatekeeperDevProxy('127.0.0.1:1')],
        server: {host: '127.0.0.1', port: 0, hmr: false}});
      await server.close();
      throw Error('Unsafe proxy startup succeeded');
    } catch (error) {
      if (!error.message.includes('Disable NODE_DEBUG HTTP and stream traces')) throw error;
      console.log('UNSAFE_TRACE_STARTUP_REJECTED');
    }
  `
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), env: {...process.env, NODE_DEBUG: trace},
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(child.stdout).toContain('UNSAFE_TRACE_STARTUP_REJECTED')
}, 15_000)

async function runWranglerFixture(level: 'log' | 'debug', forceTimeout = false) {
  // Parent-owned, including when the fixture times out before its finally can run.
  // A space also exercises how the fault preload is passed through Wrangler's Node wrapper.
  const dir = await mkdtemp(join(tmpdir(), 'gatekeeper log fixture-'))
  const plugin = new URL('./vite-gatekeeper-proxy.ts', import.meta.url).href
  const configuration = new URL('../../scripts/dev-server-config.ts', import.meta.url).href
  const binEntry = new URL('../../scripts/bin-entry.ts', import.meta.url).href
  const teardown = new URL('../../scripts/kill-process-tree.ts', import.meta.url).href
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
  // Fault only the runtime connection, leaving the real ProxyWorker, retries and logger intact.
  // Once requested, direct its next reload event to a TCP listener that resets every connection.
  const transportFault = `
    const {EventEmitter} = require('node:events');
    const {existsSync, writeFileSync} = require('node:fs');
    const emit = EventEmitter.prototype.emit;
    let watching = false;
    EventEmitter.prototype.emit = function(type, event, ...args) {
      if (!watching && type === 'reloadComplete' && event?.proxyData?.userWorkerUrl && this.proxy?.sendMessageToProxyWorker) {
        watching = true;
        const timer = setInterval(async () => {
          if (!existsSync('break-transport')) return;
          clearInterval(timer);
          await this.proxy.sendMessageToProxyWorker({type: 'play', proxyData: {...event.proxyData,
            userWorkerUrl: {...event.proxyData.userWorkerUrl, port: process.env.CFOS_TEST_RESET_PORT}}});
          writeFileSync('transport-broken', 'ready');
        }, 20);
        timer.unref();
      }
      return emit.call(this, type, event, ...args);
    };
  `
  const program = `
    import {createServer} from 'node:net';
    import {spawn, spawnSync} from 'node:child_process';
    import {writeFile, readFile, access} from 'node:fs/promises';
    import {join} from 'node:path';
    import {createServer as createViteServer} from 'vite';
    import {gatekeeperDevProxy} from ${JSON.stringify(plugin)};
    import {getDevServerEnv} from ${JSON.stringify(configuration)};
    import {resolveBinEntry} from ${JSON.stringify(binEntry)};
    import {killProcessTree} from ${JSON.stringify(teardown)};
    const dir = ${JSON.stringify(dir)};
    const reset = createServer(socket => socket.destroy());
    let resetConnections = 0;
    reset.on('connection', () => ++resetConnections);
    await new Promise(resolve => reset.listen(0, '127.0.0.1', resolve));
    const faultPath = join(dir, 'transport-fault.cjs');
    await writeFile(faultPath, ${JSON.stringify(transportFault)});
    const diskLog = join(dir, 'wrangler.log');
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
    const childEnv = getDevServerEnv({...process.env, WRANGLER_LOG: ${JSON.stringify(level)},
      WRANGLER_LOG_PATH: diskLog, WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false',
      X_LOCAL_OBSERVABILITY: 'true', NODE_DEBUG: '*', CFOS_TEST_RESET_PORT: String(reset.address().port)});
    if (childEnv.NODE_DEBUG !== '') throw Error('Raw backend trace remained enabled');
    const child = spawn(process.execPath, ['--require', faultPath, resolveBinEntry(${JSON.stringify(projectRoot)}, 'wrangler'), 'dev',
      '--local', '--port', String(port), '--inspector-port', '0', '--show-interactive-dev-session=false'], {
      cwd: dir, env: childEnv,
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
      if (${JSON.stringify(forceTimeout)}) {
        console.log('WRANGLER_READY_FOR_TIMEOUT ' + port);
        await new Promise(() => {});
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
      const traces = await fetch(backend + '/cdn-cgi/local/explorer/api/local/observability/query', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({sql: 'SELECT * FROM spans'}),
      });
      const traceResponse = await traces.text();
      if (traces.status !== 404 || !traceResponse.includes('Local observability is not enabled')) {
        throw Error('Local Explorer can still capture credential-bearing requests: ' + traces.status);
      }
      console.log('LOCAL_OBSERVABILITY_DISABLED');
      await writeFile(join(dir, 'break-transport'), 'go');
      const failureDeadline = Date.now() + 5000;
      while (true) {
        try {await access(join(dir, 'transport-broken')); break;} catch {}
        if (Date.now() > failureDeadline) throw Error('Transport fault was not installed');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const failed = await fetch(origin + path + '/transport-fail');
      await failed.text();
      if (failed.status !== 500 || resetConnections === 0) throw Error('Did not exercise a proxy transport error');
      while (true) {
        const log = await readFile(diskLog, 'utf8');
        if (log.includes('upstream-ticket-fixture')) throw Error('Ticket persisted in the Wrangler disk log');
        if (log.includes('Error inside ProxyWorker') && log.includes('/gatekeeper/[redacted]')) break;
        if (Date.now() > failureDeadline) throw Error('Transport error not recorded in the disk log');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      console.log('TRANSPORT_FAILURE_AND_DISK_LOG_REDACTED');
      console.log('UPSTREAM_FIXTURE_PASSED');
    } finally {
      await vite?.close();
      if (child.exitCode === null) await killProcessTree(child.pid);
      await new Promise(resolve => reset.close(resolve));
    }
  `
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), env: {...process.env, DEBUG: '*'},
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const timeoutError = new Error('Wrangler fixture timed out')
  const {promise: interrupted, reject: interrupt} = Promise.withResolvers<never>()
  const timer = setTimeout(() => interrupt(timeoutError), 30_000)
  let captured = '', status: number | null | undefined, failure: unknown
  const capture = (chunk: string) => {
    captured += chunk
    if (captured.length > 4 * 1024 * 1024) interrupt(new Error('Wrangler fixture output exceeded its limit'))
    if (forceTimeout && /WRANGLER_READY_FOR_TIMEOUT \d+/.test(captured)) interrupt(timeoutError)
  }
  child.stdout.setEncoding('utf8').on('data', capture)
  child.stderr.setEncoding('utf8').on('data', capture)
  try {
    status = await Promise.race([finished, interrupted])
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(timer)
    try {
      // Do not kill just the wrapper first: collect its descendants while they still belong to it.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await killProcessTreeEscalating(child.pid, {graceMs: 1_000})
      }
      await finished.catch(() => {})
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  }
  const output = stripVTControlCharacters(captured)
  expect(existsSync(dir)).toBe(false)
  return {output, status, failure, timeoutError}
}

it('cleans up a real Wrangler tree and scratch directory after fixture timeout', async () => {
  const {output, failure, timeoutError} = await runWranglerFixture('log', true)
  expect(failure).toBe(timeoutError)
  const port = output.match(/WRANGLER_READY_FOR_TIMEOUT (\d+)/)?.[1]
  expect(port).toBeDefined()
  await expect(fetch('http://127.0.0.1:' + port + '/health', {signal: AbortSignal.timeout(1_000)}))
    .rejects.toBeInstanceOf(TypeError)
}, 35_000)

it.each(['log', 'debug'] as const)('keeps tickets out of the real Wrangler upstream at %s level', async level => {
  const {output, status, failure} = await runWranglerFixture(level)
  expect(failure).toBeUndefined()
  if (status !== 0) throw new Error(`Wrangler fixture exited with ${status}:\n${output}`)
  expect(output).toContain('UPSTREAM_FIXTURE_PASSED')
  expect(output).toContain('LOCAL_OBSERVABILITY_DISABLED')
  expect(output).toContain('TRANSPORT_FAILURE_AND_DISK_LOG_REDACTED')
  expect(output).toContain('Error inside ProxyWorker')
  expect(output).toContain('/gatekeeper/[redacted] 200')
  expect(output).toContain('/gatekeeper/[redacted] 503')
  expect(output).toContain('/health')
  expect(output).toContain('WORKER_DIAGNOSTIC_VISIBLE')
  expect(output).not.toContain('upstream-ticket-fixture')
  expect(output).not.toMatch(/(?:STREAM|HTTP) \d+:/)
}, 35_000)
