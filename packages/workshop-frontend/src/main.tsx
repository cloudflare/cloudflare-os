import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { RpcPromise, RpcStub, newWebSocketRpcSession } from 'capnweb'
import { PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'
import { ServerConfigContext, ServerConfigErrorContext } from './ServerConfigContext'
import { ThemeProvider } from './ThemeContext'
import { createRouter } from './router'
import AnnouncementBanner from './components/AnnouncementBanner'
import { applyAccentColor, applyStoredThemeMode } from './theme'
import './styles.css'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { installWorkshopErrorReporting, reportIssue } from './errorReporting'
import { applySiteFavicon, cacheBustSiteLogoUrl } from './siteLogoUtils'

// ---------------------------------------------------------------------------
// Dev auto-login: if VITE_DEV_AUTO_LOGIN=true, automatically create/login
// with the dev account before React renders, so you never see the login page.
// ---------------------------------------------------------------------------
async function devAutoLogin(stub: RpcStub<PublicApi>): Promise<void> {
  if (import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return
  if (localStorage.getItem('authToken')) return  // already logged in

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
    localStorage.setItem('authToken', token)
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
let lastConnectTime: number = 0;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;
// Generous probe deadlines let a slow-but-alive backend settle instead of connect/dispose looping
// (or, on wake, tearing down a healthy socket under load).
const RECONNECT_PROBE_TIMEOUT_MS = 20000;
const WAKE_PROBE_TIMEOUT_MS = 10000;
const WAKE_PROBE_MIN_IDLE_MS = 15000;

// Callbacks to call whenever `currentStub` or connection state is updated.
const subscribers = new Set<() => void>();
const notifySubscribers = () => subscribers.forEach(cb => cb());
let isConnectionLost = false;
let probing = false;
let lastProvenAt = Date.now();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

function getBackendHost(): string {
  // Only the Vite dev server is hosted separately from the backend. Built assets are served from
  // the same origin in both production and run-local mode.
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_BACKEND_HOST?.trim() || 'localhost:8787';
  }
  return window.location.host;
}

function startConnection(): RpcStub<PublicApi> {
  lastConnectTime = Date.now();
  const apiHost = getBackendHost();
  const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + apiHost + '/api';
  const stub = newWebSocketRpcSession<PublicApi>(wsUrl);
  stub.onRpcBroken(handleBroken);
  return stub;
}

const disposeQuietly = (stub: RpcStub<PublicApi>) => {
  try { stub[Symbol.dispose](); } catch { /* already broken */ }
};

// Connects with jittered backoff until a candidate answers a probe, and resolves only to that
// proven connection: capnweb queues sends while a socket is still CONNECTING, so an unproven stub
// looks fine right up until everything pipelined onto it fails at once.
async function reconnect(): Promise<RpcStub<PublicApi>> {
  // Fast recovery from one-off blips: skip the first backoff if the dying connection was up a while.
  let skipSleep = Date.now() - lastConnectTime >= INITIAL_BACKOFF_MS;
  let backoff = INITIAL_BACKOFF_MS;
  for (;;) {
    if (!skipSleep) {
      await sleep(backoff * (0.85 + 0.3 * Math.random()));  // jittered against stampedes
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
    skipSleep = false;

    const candidate = startConnection();
    try {
      await withTimeout(candidate.ping(), RECONNECT_PROBE_TIMEOUT_MS);
    } catch (probeError) {
      console.debug('Reconnect attempt failed:', probeError);
      disposeQuietly(candidate);
      continue;
    }

    lastProvenAt = Date.now();
    isConnectionLost = false;
    console.warn('RPC connection restored.');
    notifySubscribers();
    return candidate;
  }
}

// Subscribers hear exactly twice per outage — lost here, restored in `reconnect` — because
// `currentStub` is replaced once, by a promise, rather than once per attempt.
function handleBroken(error: unknown) {
  if (isConnectionLost) return;  // stale/disposed stub, or recovery already underway
  isConnectionLost = true;

  console.warn('RPC connection lost:', error);

  // Publish a stub for the connection we have not made yet, so the dead one stops being reachable
  // immediately. capnweb queues calls pipelined onto an unresolved `RpcPromise` and delivers them,
  // in order, once it resolves — so work issued during the outage waits for the replacement
  // instead of failing against a socket known to be gone. The `RpcPromise` takes ownership of its
  // resolution, keeping the proven stub on a single disposal path.
  currentStub = new RpcPromise<PublicApi>(reconnect());
  notifySubscribers();
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
    console.warn('Connection unresponsive after wake:', error);
    // Disposal fires onRpcBroken → handleBroken recovers. Its skip-first-backoff path retries
    // immediately — right for "the network just came back".
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
let currentStub = startConnection();

const router = createRouter()
applyStoredThemeMode()

function AppWithConnection() {
  const [rpcState, setRpcState] = useState<{stub: RpcStub<PublicApi>; connectionLost: boolean}>({
    stub: currentStub,
    connectionLost: isConnectionLost,
  });
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [serverConfigError, setServerConfigError] = useState(false);

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
            siteLogo: { url: cacheBustSiteLogoUrl(cfg.siteLogo.url) },
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
  }, [serverConfig]);

  return (
    <ThemeProvider>
      <RpcContext.Provider value={rpcState}>
        <ServerConfigErrorContext.Provider value={serverConfigError}>
          <ServerConfigContext.Provider value={serverConfig}>
            <div className="app-viewport flex min-w-0 flex-col overflow-hidden">
              <AnnouncementBanner />
              <div className="h-full min-h-0 flex-1">
                <RouterProvider router={router} />
              </div>
            </div>
          </ServerConfigContext.Provider>
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
