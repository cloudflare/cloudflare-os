import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NotificationSubscriber, UserNotification } from "@gadgets/workshop-shared/api";
import { deliver, registerDevice } from "../src/notification-service.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const encoder = new TextEncoder();
const SUBSCRIPTION_ID = "b".repeat(64);
// Ids the stub service mints, in order.
const [ONE, TWO, THREE] = ["1", "2", "3"].map(digit => digit.repeat(64));
const NOTIFICATION: UserNotification = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "taskCompleted",
  workspaceId: "abc123",
  chatId: 7,
  chatTitle: "Build the demo",
};

const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer);
const INSTALL = {
  NOTIFICATION_SERVICE_URL: "https://notifications.example.test",
  CFOS_INSTALL_ID: "install-1",
  CFOS_INSTALL_KEY_ID: "22222222-2222-4222-8222-222222222222",
  CFOS_INSTALL_PRIVATE_KEY: btoa(String.fromCharCode(...pkcs8)),
};
const installEnv = { ...env, ...INSTALL } as Cloudflare.Env;

const base64urlBytes = (value: string) => Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Stands in for the central service. Each registration mints the next subscription id for the
// device whose key repeats the registration's first character; deliveries are accepted, except
// that `refuse` answers those to one subscription with the service's error.
function stubService(refuse?: { subscriptionId: string; status: string; code: number }) {
  let minted = 0;
  let fetcher = vi.fn<Fetch>(async (input, init) => {
    let body = JSON.parse(String(init?.body));
    if (new URL(String(input)).pathname === "/v1/subscriptions") {
      return Response.json({
        deviceKey: body.deviceRegistrationId[0].repeat(64),
        subscriptionId: String(++minted).repeat(64),
      }, { status: 201 });
    }
    return body.subscriptionId === refuse?.subscriptionId
      ? Response.json({ status: refuse.status }, { status: refuse.code })
      : new Response(null, { status: 202 });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const bodies = (fetcher: Mock<Fetch>, pathname: string) => fetcher.mock.calls
    .filter(([url]) => new URL(String(url)).pathname === pathname)
    .map(([, init]) => JSON.parse(String(init?.body)));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("notification service", () => {
  it.each([
    ["taskCompleted", "task_completed"],
    ["permissionRequested", "permission_requested"],
  ] as const)("signs a %s delivery the service accepts", async (kind, type) => {
    let fetcher = stubService();
    await deliver(installEnv, SUBSCRIPTION_ID, { ...NOTIFICATION, kind });

    let [url, init] = fetcher.mock.calls[0];
    let headers = new Headers(init?.headers);
    let body = String(init?.body);
    expect(String(url)).toBe("https://notifications.example.test/v1/deliveries");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(body)).toEqual({
      type,
      eventId: NOTIFICATION.id,
      taskId: "abc123:7",
      threadTitle: "Build the demo",
      path: "/workspace/abc123?chat=7&showChat=true",
      subscriptionId: SUBSCRIPTION_ID,
    });
    expect(headers.get("x-cfos-install-id")).toBe(INSTALL.CFOS_INSTALL_ID);
    expect(headers.get("x-cfos-key-id")).toBe(INSTALL.CFOS_INSTALL_KEY_ID);
    expect(base64urlBytes(headers.get("x-cfos-content-digest")!))
        .toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))));
    // The canonical request the service verifies.
    let canonical = [
      "CFOS1", "POST", "/v1/deliveries",
      ...["install-id", "key-id", "timestamp", "nonce", "content-digest"]
          .map(name => headers.get(`x-cfos-${name}`)),
    ].join("\n");
    expect(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey,
        base64urlBytes(headers.get("x-cfos-signature")!), encoder.encode(canonical))).toBe(true);
  });

  it.each([
    ["  Build\n\tthe demo  ", "Build the demo"],
    [`${"a".repeat(95)} tail`, "a".repeat(95)],
    ["🚂".repeat(60), "🚂".repeat(48)],
    [" \n ", undefined],
  ])("fits the title %j to the service's 96 trimmed UTF-16 units", async (chatTitle, title) => {
    let fetcher = stubService();
    await deliver(installEnv, SUBSCRIPTION_ID, { ...NOTIFICATION, chatTitle });
    expect(bodies(fetcher, "/v1/deliveries")[0].threadTitle).toBe(title);
  });

  it("exchanges a device registration for its device's subscription", async () => {
    let fetcher = stubService();
    await expect(registerDevice(installEnv, "d".repeat(64)))
        .resolves.toEqual({ deviceKey: "d".repeat(64), subscriptionId: ONE });
    expect(bodies(fetcher, "/v1/subscriptions")).toEqual([{ deviceRegistrationId: "d".repeat(64) }]);
  });

  it("sends nothing to a plaintext service URL", async () => {
    let fetcher = stubService();
    let plaintext = { ...installEnv, NOTIFICATION_SERVICE_URL: "http://notifications.example.test" };
    await expect(deliver(plaintext, SUBSCRIPTION_ID, NOTIFICATION)).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// RPC exposes prototype methods only, as the browser's NotificationSubscriberImpl defines them.
class Subscriber extends RpcTarget {
  constructor(private readonly answer: () => Promise<void>) {
    super();
  }

  notify(): Promise<void> {
    return this.answer();
  }
}

// Runs `fn` on a fresh User DO whose installation has the notification service configured.
async function inUser(fn: (user: UserDurableObject) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_USER.getByName(`notifications-${crypto.randomUUID()}`),
      async user => {
        let implementation = user as unknown as { env: Cloudflare.Env };
        implementation.env = { ...implementation.env, ...INSTALL };
        await fn(user);
      });
}

// The subscriptions pushed to, sorted.
const pushed = (fetcher: Mock<Fetch>) =>
  bodies(fetcher, "/v1/deliveries").map(({ subscriptionId }) => subscriptionId).toSorted();

// Registers a phone, then publishes NOTIFICATION while `notify` is the only open tab's answer
// (none when undefined), and returns the subscriptions pushed to.
async function publish(notify?: () => Promise<void>): Promise<string[]> {
  let fetcher = stubService();
  await inUser(async user => {
    await user.registerNotificationDevice("a".repeat(64));
    if (notify) {
      await user.subscribeToNotifications(
          new RpcStub(new Subscriber(notify)) as unknown as RpcStub<NotificationSubscriber>);
    }
    let published = user.publishNotification(NOTIFICATION);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(3_000);
    await published;
  });
  return pushed(fetcher);
}

describe("UserDurableObject notifications", () => {
  it("leaves a notification an open tab shows to that tab", async () => {
    expect(await publish(async () => {})).toEqual([]);
  });

  it.each([
    ["no tab is open", undefined],
    ["the tab fails to show it", () => Promise.reject(new Error("hidden"))],
  ])("pushes to the registered phone when %s", async (_, notify) => {
    expect(await publish(notify)).toEqual([ONE]);
  });

  it("pushes to the registered phone when the tab does not answer within 3s", async () => {
    vi.useFakeTimers();
    expect(await publish(() => new Promise<void>(() => {}))).toEqual([ONE]);
  });

  it("pushes to each device's latest subscription", async () => {
    let fetcher = stubService();
    await inUser(async user => {
      await user.registerNotificationDevice("a".repeat(64)); // phone: ONE
      await user.registerNotificationDevice("b".repeat(64)); // tablet: TWO
      await user.registerNotificationDevice("a".repeat(64)); // phone reopens the app: THREE
      await user.publishNotification(NOTIFICATION);
    });
    expect(pushed(fetcher)).toEqual([TWO, THREE]);
  });

  // The phone's push fails; the tablet still gets it. A dead subscription is dropped quietly, but a
  // bad signature says nothing about the subscription: it stays, and the failure is reported.
  it.each([
    { status: "device_gone", code: 410, fails: false, next: [TWO] },
    { status: "invalid_subscription", code: 401, fails: false, next: [TWO] },
    { status: "invalid_signature", code: 401, fails: true, next: [ONE, TWO] },
  ])("keeps the other device through a $status push", async ({ status, code, fails, next }) => {
    let fetcher = stubService({ subscriptionId: ONE, status, code });
    let failed: boolean | undefined;
    let first: string[] = [];
    await inUser(async user => {
      await user.registerNotificationDevice("a".repeat(64));
      await user.registerNotificationDevice("b".repeat(64));
      failed = await user.publishNotification(NOTIFICATION).then(() => false, () => true);
      first = pushed(fetcher);
      fetcher.mockClear();
      await user.publishNotification(NOTIFICATION).catch(() => {});
    });
    expect({ failed, first, next: pushed(fetcher) })
        .toEqual({ failed: fails, first: [ONE, TWO], next });
  });
});
