import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { RpcPromise, RpcStub } from 'capnweb'
import { PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'
import { ServerConfigContext, ServerConfigErrorContext, ServerConfigUpdateContext } from './ServerConfigContext'
import { ThemeProvider } from './ThemeContext'
import { createRouter } from './router'
import AnnouncementBanner from './components/AnnouncementBanner'
import { applyAccentColor, applyStoredThemeMode } from './theme'
import './styles.css'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { installWorkshopErrorReporting, reportIssue } from './errorReporting'
import { applySiteFavicon, cacheBustSiteLogoUrl } from './siteLogoUtils'
import { getWorkshopRuntime, installNativeLoginCoordinator } from './runtime'
import { installProductFeedbackDiagnostics } from './productFeedbackDiagnostics'
import { newWorkshopWebSocketRpcSession } from './workshopWebSocketRpc'
import { classifyRpcError } from './rpcErrors'

installProductFeedbackDiagnostics()

// ---------------------------------------------------------------------------
// Dev auto-login: if VITE_DEV_AUTO_LOGIN=true, automatically create/login
// with the dev account before React renders, so you never see the login page.
// ---------------------------------------------------------------------------
async function devAutoLogin(stub: RpcStub<PublicApi>): Promise<void> {
  if (import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return
  const runtime = getWorkshopRuntime()
  if (await runtime.readSessionSecret()) return  // already logged in

  const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
  const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'

  // Derive the passwordHash the same way the app does (argon2id via hashPassword),
  // but here we use the same SERVICE_SALT + SHA-256 shortcut that wrangler dev accepts
  // in local mode. We import hashPassword from the existing util.
  const { hashPassword } = await import('./passwordHash')
  const passwordHash = await hashPassword(username, password)

  // Try createAccount first — works on a fresh backend. Returns null if already exists.
  let token = await stub.createAccount(username, username, passwordHash)

  // If null, account already exists — just log in.
  if (!token) {
    token = await stub.login(username, passwordHash)
  }

  if (token) {
    await runtime.writeSessionSecret(token)
  }
}

// WebSocket RPC connection management.
//
// React's useEffect / useState machinery is kind of obnoxious in that, in dev mode, it runs
// everything twice (runs once, immediately cleans up, then runs again). This isn't so good for
// our WebSocket as it means we are creating redundant connections to the server and throwing
// them away instantly. It gets even worse when we start trying to handle disconnects gracefully:
// we can end up with two connections that are fighting to replace each other.
//
// Or maybe I (Kenton) was just holding it wrong, idk.
//
// Anyway, I pulled the connection management out into these globals instead.
let connectionEstablishedAt = performance.now();

const nativeRuntime = getWorkshopRuntime().kind === 'tauri';
const INITIAL_BACKOFF_MS = nativeRuntime ? 500 : 1000;
const MAX_BACKOFF_MS = nativeRuntime ? 5000 : 10000;
// A single successful ping isn't stability: flapping sockets otherwise reset the retry budget
// and repeatedly restart authentication. Keep the budget across outages until a connection lasts.
const STABLE_CONNECTION_MS = 30000;
let reconnectBackoff = INITIAL_BACKOFF_MS;
// WebKit sometimes leaves a failed TLS WebSocket's pipelined ping unresolved rather than rejecting
// it. A 20-second browser-safe probe made two transient native failures look like a minute-long
// OAuth stall, so native retries use a bounded deadline while the web app retains its generous one.
const RECONNECT_PROBE_TIMEOUT_MS = nativeRuntime ? 4000 : 20000;
const WAKE_PROBE_TIMEOUT_MS = nativeRuntime ? 4000 : 10000;
const WAKE_PROBE_MIN_IDLE_MS = nativeRuntime ? 0 : 15000;

// Callbacks to call whenever `currentStub` or connection state is updated.
const subscribers = new Set<() => void>();
const notifySubscribers = () => subscribers.forEach(cb => cb());
let isConnectionLost = nativeRuntime;
let probing = false;
let lastProvenAt = Date.now();
let activeConnection: RpcStub<PublicApi> | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

function startConnection(onBroken?: (error: unknown) => void): RpcStub<PublicApi> {
  const apiOrigin = getWorkshopRuntime().apiOrigin;
  const wsUrl = `${apiOrigin.protocol === 'https:' ? 'wss:' : 'ws:'}//${apiOrigin.host}/api`;
  const stub = newWorkshopWebSocketRpcSession<PublicApi>(wsUrl);
  stub.onRpcBroken(error => onBroken ? onBroken(error) : handleBroken(stub, error));
  return stub;
}

const disposeQuietly = (stub: RpcStub<PublicApi>) => {
  try { stub[Symbol.dispose](); } catch { /* already broken */ }
};

// Connects with jittered backoff until a candidate answers a probe, and resolves only to that
// proven connection: capnweb queues sends while a socket is still CONNECTING, so an unproven stub
// looks fine right up until everything pipelined onto it fails at once.
async function reconnect(connectionAgeMs = 0): Promise<RpcStub<PublicApi>> {
  // Fast recovery from one-off blips: skip the first backoff if the dying connection was up a while.
  let skipSleep = connectionAgeMs >= STABLE_CONNECTION_MS;
  if (skipSleep) reconnectBackoff = INITIAL_BACKOFF_MS;
  const startedAt = performance.now();
  let attempts = 0;
  for (;;) {
    if (!skipSleep) {
      await sleep(reconnectBackoff * (0.85 + 0.3 * Math.random()));  // jittered against stampedes
      reconnectBackoff = Math.min(reconnectBackoff * 2, MAX_BACKOFF_MS);
    }
    skipSleep = false;
    attempts = Math.min(attempts + 1, 1000000);

    let candidateBroken = false;
    let candidate!: RpcStub<PublicApi>;
    candidate = startConnection(error => {
      candidateBroken = true;
      if (activeConnection === candidate) handleBroken(candidate, error);
    });
    try {
      await withTimeout(candidate.ping(), RECONNECT_PROBE_TIMEOUT_MS);
    } catch (error) {
      console.debug('Reconnect attempt failed.', {
        event: 'rpc.connection.probe.failed', attempts, errorClass: classifyRpcError(error),
      });
      disposeQuietly(candidate);
      continue;
    }
    if (candidateBroken) {
      disposeQuietly(candidate);
      continue;
    }

    activeConnection = candidate;
    connectionEstablishedAt = performance.now();
    lastProvenAt = Date.now();
    isConnectionLost = false;
    console.info('RPC connection restored.', {
      event: 'rpc.connection.restored', attempts, elapsedMs: boundedElapsed(startedAt),
      runtime: nativeRuntime ? 'native' : 'web',
    });
    notifySubscribers();
    return candidate;
  }
}

// Subscribers hear exactly twice per outage — lost here, restored in `reconnect` — because
// `currentStub` is replaced once, by a promise, rather than once per attempt.
function handleBroken(stub: RpcStub<PublicApi>, error: unknown) {
  if (isConnectionLost || activeConnection !== stub) return;
  isConnectionLost = true;
  activeConnection = null;

  const connectionAgeMs = boundedElapsed(connectionEstablishedAt);
  console.warn('RPC connection lost.', {
    event: 'rpc.connection.lost', connectionAgeMs, runtime: nativeRuntime ? 'native' : 'web',
    errorClass: classifyRpcError(error),
  });

  // Publish a stub for the connection we have not made yet, so the dead one stops being reachable
  // immediately. capnweb queues calls pipelined onto an unresolved `RpcPromise` and delivers them,
  // in order, once it resolves — so work issued during the outage waits for the replacement
  // instead of failing against a socket known to be gone. The `RpcPromise` takes ownership of its
  // resolution, keeping the proven stub on a single disposal path.
  const previous = currentStub;
  currentStub = new RpcPromise<PublicApi>(reconnect(connectionAgeMs));
  disposeQuietly(previous);
  notifySubscribers();
}

// Diagnostics contain only local timing/counts, never remote exception messages or credentials.
function boundedElapsed(startedAt: number): number {
  return Math.min(86400000, Math.max(0, Math.round(performance.now() - startedAt)));
}

// Passive close detection misses sockets killed during laptop sleep or tab throttling, so on
// tab-visible / network-online signals probe the connection instead of letting the user's next
// action hang on a zombie socket.
async function probeOnWake() {
  if (isConnectionLost || probing || Date.now() - lastProvenAt < WAKE_PROBE_MIN_IDLE_MS) return;
  probing = true;
  const suspect = currentStub;
  try {
    await withTimeout(suspect.ping(), WAKE_PROBE_TIMEOUT_MS);
    lastProvenAt = Date.now();
  } catch (error) {
    if (currentStub !== suspect || isConnectionLost) return;  // a real broken event won the race
    console.warn('Connection unresponsive after wake.', {
      event: 'rpc.connection.wake.failed', errorClass: classifyRpcError(error),
    });
    // Disposal fires onRpcBroken → handleBroken recovers. A previously stable connection retries
    // immediately; a recently restored one retains its backoff against repeated wake failures.
    disposeQuietly(suspect);
  } finally {
    probing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void probeOnWake();
});
window.addEventListener('online', () => void probeOnWake());

// Current stub. handleBroken() will replace this on disconnect.
installWorkshopErrorReporting()
let currentStub: RpcStub<PublicApi>;
if (nativeRuntime) {
  currentStub = new RpcPromise<PublicApi>(reconnect());
} else {
  currentStub = startConnection();
  activeConnection = currentStub;
}
void installNativeLoginCoordinator(getWorkshopRuntime(), () => currentStub).catch(() => {})

const router = createRouter()
applyStoredThemeMode()

function AppWithConnection() {
  const [rpcState, setRpcState] = useState<{stub: RpcStub<PublicApi>; connectionLost: boolean}>({
    stub: currentStub,
    connectionLost: isConnectionLost,
  });
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [serverConfigError, setServerConfigError] = useState(false);
  const updateServerConfig = useCallback((update: Partial<ServerConfig>) => {
    setServerConfig((current) => current ? { ...current, ...update } : current);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateHeight = () => {
      const height = viewport?.height ?? window.innerHeight;
      const top = viewport?.offsetTop ?? 0;
      document.documentElement.style.setProperty('--app-height', `${height}px`);
      document.documentElement.style.setProperty('--app-top', `${top}px`);
      document.documentElement.style.setProperty(
        '--app-bottom',
        `${Math.max(0, window.innerHeight - top - height)}px`,
      );
    };
    updateHeight();
    viewport?.addEventListener('resize', updateHeight);
    viewport?.addEventListener('scroll', updateHeight);
    window.addEventListener('resize', updateHeight);
    return () => {
      viewport?.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('scroll', updateHeight);
      window.removeEventListener('resize', updateHeight);
    };
  }, []);

  useEffect(() => {
    const cb = () => setRpcState({ stub: currentStub, connectionLost: isConnectionLost });
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }, []);

  // Fetch deployment config once the (re)connected stub is available. Re-fetch on reconnect so a
  // server restart with changed config is picked up.
  useEffect(() => {
    let cancelled = false;
    setServerConfigError(false);
    rpcState.stub.getServerConfig()
      .then((cfg) => {
        if (!cancelled) {
          setServerConfig(cfg.siteLogo ? {
            ...cfg,
            siteLogo: {
              url: cacheBustSiteLogoUrl(
                new URL(cfg.siteLogo.url, getWorkshopRuntime().apiOrigin).toString(),
              ),
            },
          } : cfg);
        }
      })
      .catch(() => { if (!cancelled) setServerConfigError(true); });
    return () => { cancelled = true; };
  }, [rpcState.stub]);

  // Apply the deployment's admin-chosen accent color (overrides brand CSS vars at runtime).
  useEffect(() => {
    applyAccentColor(serverConfig?.accentColor ?? '');
  }, [serverConfig?.accentColor]);

  useEffect(() => {
    return applySiteFavicon(serverConfig?.siteLogo?.url);
  }, [serverConfig?.siteLogo?.url]);

  return (
    <ThemeProvider>
      <RpcContext.Provider value={rpcState}>
        <ServerConfigErrorContext.Provider value={serverConfigError}>
          <ServerConfigUpdateContext.Provider value={updateServerConfig}>
            <ServerConfigContext.Provider value={serverConfig}>
              <div className="app-viewport flex min-w-0 flex-col overflow-hidden">
                <AnnouncementBanner />
                <div className="h-full min-h-0 flex-1">
                  <RouterProvider router={router} />
                </div>
              </div>
            </ServerConfigContext.Provider>
          </ServerConfigUpdateContext.Provider>
        </ServerConfigErrorContext.Provider>
      </RpcContext.Provider>
    </ThemeProvider>
  );
}

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportIssue('workshop.react-root', error, {
    handled: false, severity: 'fatal', captureMechanism: 'react',
  }),
})

// Kick off dev auto-login in the background. If it completes before
// useAuth checks the token, the user skips the login page. If the backend
// is unreachable, the app still renders immediately (showing a connection
// banner or login page) instead of hanging on a blank screen.
devAutoLogin(currentStub).catch(() => {})

root.render(
  <StrictMode>
    <FrontendErrorBoundary>
      <AppWithConnection />
    </FrontendErrorBoundary>
  </StrictMode>
)
