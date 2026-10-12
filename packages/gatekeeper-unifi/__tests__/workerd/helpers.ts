/** Shared setup for the workerd suites: a fake UniFi, connected accounts, and binding props. */

import { env } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../../src/unifi.js";
import type { UnifiGatekeeperProps } from "../../src/gatekeeper.js";
import type { UnifiResource } from "../../src/resources.js";
import { FakeUnifi, HOME, homeConsole, type FakeConsole } from "../fake-unifi.js";
import type { Outcome, Step } from "../worker.js";

/** The public URL the connect pages live under in these tests (see vitest.worker.config.ts). */
export const BASE = "https://gadgets.example/gatekeeper/unifi";
export const ORIGIN = "https://gadgets.example";
export const CLOUD_KEY = "cloud-key-0123456789abcdefABCDEF";
export const LOCAL_KEY = "local-key-0123456789abcdefABCDEF";
export const CONSOLE_URL = "https://unifi.home.example";

/** The test hook object. */
export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

/** A fake UniFi with the home console, reachable both through the cloud and directly. */
export function installFake(): { unifi: FakeUnifi; console: FakeConsole } {
  const unifi = new FakeUnifi();
  const console = homeConsole();
  unifi.addCloudKey(CLOUD_KEY, { email: "dan@example.com", fullName: "Dan Carter", owned: [console] });
  unifi.addDirectConsole(CONSOLE_URL, console, LOCAL_KEY);
  vi.stubGlobal("fetch", unifi.fetch);
  return { unifi, console };
}

/** The `ctx` a request to the Worker gets: what the connect handler reaches through `exports`. */
export function workerCtx() {
  return { exports: { UnifiAccount: env.UNIFI_ACCOUNT }, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

/** Sends a request to the Worker's connect pages. */
export function request(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${BASE}${path}`, init), env as never, workerCtx());
}

/** A form post as a browser on the connect page sends it. */
export function postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

let nonceCounter = 0;

/** A fresh account at the start of a connect flow, as `connectAccount` leaves it. */
export async function startConnect(): Promise<{ accountId: string; nonce: string; path: string }> {
  const accountId = env.UNIFI_ACCOUNT.newUniqueId().toString();
  const nonce = (++nonceCounter).toString(16).padStart(64, "0");
  await hooks().installCallback(accountId, nonce);
  return { accountId, nonce, path: `/${accountId}/${nonce}` };
}

/** A connected cloud account. */
export async function connectCloud(key = CLOUD_KEY): Promise<string> {
  const { accountId, path } = await startConnect();
  const response = await postForm(path, { mode: "cloud", cloudApiKey: key });
  if (response.status !== 200) throw new Error(`connect failed: ${response.status} ${await response.text()}`);
  return accountId;
}

/** A connected direct account. */
export async function connectDirect(fields: Record<string, string> = {}): Promise<string> {
  const { accountId, path } = await startConnect();
  const response = await postForm(path, { mode: "direct", consoleUrl: CONSOLE_URL, localApiKey: LOCAL_KEY, ...fields });
  if (response.status !== 200) throw new Error(`connect failed: ${response.status} ${await response.text()}`);
  return accountId;
}

/** The account Durable Object. */
export function account(accountId: string) {
  return env.UNIFI_ACCOUNT.get(env.UNIFI_ACCOUNT.idFromString(accountId));
}

/** Binding props for a resource on the home console reached by `accountId`. */
export function props(accountId: string, resource: UnifiResource): UnifiGatekeeperProps {
  return { accountId, resource };
}

/** The home console's resources, by kind, for a cloud connection. */
export const RESOURCES = {
  site: { kind: "site", consoleId: HOME.hostId, siteId: HOME.siteId },
  device: (deviceId: string, clients = false) =>
    ({ kind: "device", consoleId: HOME.hostId, siteId: HOME.siteId, deviceId, clients }) as UnifiResource,
  wifi: (wifiNetworkId: string) => ({ kind: "wifi", consoleId: HOME.hostId, siteId: HOME.siteId, wifiNetworkId }) as UnifiResource,
  hotspot: { kind: "hotspot", consoleId: HOME.hostId, siteId: HOME.siteId },
  protect: { kind: "protect", consoleId: HOME.hostId },
  camera: (cameraId: string) => ({ kind: "camera", consoleId: HOME.hostId, cameraId }) as UnifiResource,
  sensor: { kind: "sensor", consoleId: HOME.hostId, sensorId: HOME.sensorId },
  light: { kind: "light", consoleId: HOME.hostId, lightId: HOME.lightId },
} satisfies Record<string, UnifiResource | ((...args: never[]) => UnifiResource)>;

let facetCounter = 0;

/** A fresh binding: its own facet, session, and approval queue. */
export function binding(accountId: string, resource: UnifiResource) {
  const name = `facet-${++facetCounter}`;
  const p = props(accountId, resource);
  const h = hooks();
  return {
    name,
    props: p,
    /** Runs one call and returns its value, or throws its error. */
    async call<T = unknown>(call: string, ...args: unknown[]): Promise<T> {
      return unwrap((await h.run(name, p, [{ call, args }]))[0]!) as T;
    },
    /** Runs one call on a capability reached through `via`. */
    async callVia<T = unknown>(via: Step["via"], call: string, ...args: unknown[]): Promise<T> {
      return unwrap((await h.run(name, p, [{ via, call, args }]))[0]!) as T;
    },
    /** Runs one call and returns its error message. */
    async failure(call: string, ...args: unknown[]): Promise<string> {
      const result = (await h.run(name, p, [{ call, args }]))[0]!;
      if ("ok" in result) throw new Error(`${call} succeeded, but was expected to fail`);
      return result.error;
    },
    queue: () => h.queueState(name),
    apply: async (actionId: number) => unwrap(await h.apply(name, p, actionId)),
    applyOutcome: (actionId: number) => h.apply(name, p, actionId),
    reject: async (actionId: number) => unwrap(await h.reject(name, p, actionId)),
    describe: async () => unwrap(await h.describeBinding(name, p)),
    restart: () => h.restart(name),
  };
}

/** A call's value, or its error thrown. */
export function unwrap<T>(result: Outcome<T>): T {
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}
