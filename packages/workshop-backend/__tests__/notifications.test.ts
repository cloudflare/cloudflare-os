import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NotificationSubscriber, UserNotification, WebPushSubscription } from "@gadgets/workshop-shared/api";
import {
  authorizeDevice, deliver, registerAuthorizedDevice, registerDevice,
} from "../src/notification-service.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const encoder = new TextEncoder();
const SUBSCRIPTION_ID = "b".repeat(64);
const SUBJECT = "a".repeat(64);
const AUTHORIZATION = "c".repeat(64);
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
// device whose key repeats the registration id's first character, or a browser endpoint's last;
// deliveries are accepted, except that `refuse` answers those to one subscription with the
// service's error.
function stubService(refuse?: { subscriptionId: string; status: string; code: number }) {
  let minted = 0;
  let fetcher = vi.fn<Fetch>(async (input, init) => {
    let body = JSON.parse(String(init?.body));
    const path = new URL(String(input)).pathname;
    if (path === "/v2/device-authorizations") {
      return Response.json({ authorization: AUTHORIZATION }, { status: 201 });
    }
    if (path === "/v1/subscriptions" || path === "/v2/subscriptions") {
      return Response.json({
        deviceKey: (body.deviceRegistrationId ?? body.webPush.endpoint.at(-1))[0].repeat(64),
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
  const registration = (kind: "legacy" | "authorized" | "authorization") =>
    kind === "legacy" ? registerDevice(installEnv, "d".repeat(64), SUBJECT) :
    kind === "authorized" ? registerAuthorizedDevice(installEnv, "d".repeat(64), SUBJECT) :
    authorizeDevice(installEnv, SUBJECT);
  const registered = { deviceKey: "d".repeat(64), subscriptionId: ONE, authorization: AUTHORIZATION };

  it.each(["legacy", "authorized", "authorization"] as const)(
      "keeps the %s deadline through body parsing and releases it after success", async kind => {
    vi.useFakeTimers();
    const body = Promise.withResolvers<typeof registered>();
    const parsing = Promise.withResolvers<void>();
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(() => {
      parsing.resolve();
      return body.promise;
    });
    const fetcher = stubService().mockResolvedValue(response);
    const result = registration(kind);
    await parsing.promise;
    try {
      expect(vi.getTimerCount()).toBe(1);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    } finally {
      body.resolve(registered);
      await result;
    }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  it.each(["legacy", "authorized", "authorization"] as const)(
      "releases the %s deadline after a malformed response", async kind => {
    vi.useFakeTimers();
    stubService().mockResolvedValue(Response.json({}));
    await expect(registration(kind)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["legacy", "authorized", "authorization"] as const)(
      "aborts a stalled %s registration after fifteen seconds", async kind => {
    vi.useFakeTimers();
    const sending = Promise.withResolvers<void>();
    stubService().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("registration deadline")));
      sending.resolve();
    }));
    const failure = expect(registration(kind)).rejects.toThrow("registration deadline");
    await sending.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("signs the installation's vouch for an opaque CFOS user without a Dashboard credential", async () => {
    const fetcher = stubService();
    const subject = SUBJECT;
    await expect(authorizeDevice(installEnv, subject)).resolves.toBe(AUTHORIZATION);
    expect(bodies(fetcher, "/v2/device-authorizations")).toEqual([{ subject }]);
    await registerAuthorizedDevice(installEnv, "d".repeat(64), subject);
    expect(bodies(fetcher, "/v2/subscriptions"))
        .toEqual([{ subject, deviceRegistrationId: "d".repeat(64) }]);
  });

  it("refuses malformed central enrollment grants", async () => {
    stubService().mockResolvedValue(Response.json({ authorization: "not-a-grant" }));
    await expect(authorizeDevice(installEnv, "a".repeat(64))).rejects.toThrow();
  });

  it.each([
    ["taskCompleted", "task_completed"],
    ["permissionRequested", "permission_requested"],
  ] as const)("signs a %s delivery the service accepts", async (kind, type) => {
    let fetcher = stubService();
    await deliver(installEnv, SUBJECT, SUBSCRIPTION_ID, { ...NOTIFICATION, kind });

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
      subject: SUBJECT,
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
    await deliver(installEnv, SUBJECT, SUBSCRIPTION_ID, { ...NOTIFICATION, chatTitle });
    expect(bodies(fetcher, "/v1/deliveries")[0].threadTitle).toBe(title);
  });

  it("exchanges a device registration for its device's subscription", async () => {
    let fetcher = stubService();
    await expect(registerDevice(installEnv, "d".repeat(64), SUBJECT))
        .resolves.toEqual({ deviceKey: "d".repeat(64), subscriptionId: ONE });
    expect(bodies(fetcher, "/v1/subscriptions"))
        .toEqual([{ deviceRegistrationId: "d".repeat(64), subject: SUBJECT }]);
  });

  it("registers a browser's Web Push subscription with only the fields the service accepts", async () => {
    let fetcher = stubService();
    let endpoint = "https://fcm.googleapis.com/wp/abc/f";
    // PushSubscription.toJSON() also carries expirationTime, which RPC validation lets through.
    let subscription = { endpoint, keys: { p256dh: "BP", auth: "AA" }, expirationTime: null };
    await expect(registerDevice(installEnv, subscription as WebPushSubscription, SUBJECT))
        .resolves.toEqual({ deviceKey: "f".repeat(64), subscriptionId: ONE });
    expect(bodies(fetcher, "/v1/subscriptions"))
        .toEqual([{ webPush: { endpoint, keys: { p256dh: "BP", auth: "AA" } }, subject: SUBJECT }]);
  });

  it("sends nothing to a plaintext service URL", async () => {
    let fetcher = stubService();
    let plaintext = { ...installEnv, NOTIFICATION_SERVICE_URL: "http://notifications.example.test" };
    await expect(deliver(plaintext, SUBJECT, SUBSCRIPTION_ID, NOTIFICATION)).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// RPC exposes prototype methods only, as the browser's NotificationSubscriberImpl defines them.
class Subscriber extends RpcTarget {
  constructor(private readonly answer: (notification: UserNotification) => Promise<void>) {
    super();
  }

  notify(notification: UserNotification): Promise<void> {
    return this.answer(notification);
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
  it("derives one central subject for every registration and delivery", async () => {
    const fetcher = stubService();
    await inUser(async user => {
      await user.authorizeNotificationDevice();
      await user.registerAuthorizedNotificationDevice("a".repeat(64));
      await user.registerNotificationDevice("b".repeat(64));
      await user.publishNotification(NOTIFICATION);
    });
    await inUser(async user => { await user.authorizeNotificationDevice(); });
    const subjects = bodies(fetcher, "/v2/device-authorizations").map(body => body.subject);
    expect(subjects[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(subjects[1]).not.toBe(subjects[0]);
    expect(bodies(fetcher, "/v2/subscriptions")[0].subject).toBe(subjects[0]);
    expect(bodies(fetcher, "/v1/subscriptions")[0].subject).toBe(subjects[0]);
    expect(bodies(fetcher, "/v1/deliveries").map(body => body.subject))
        .toEqual([subjects[0], subjects[0]]);
  });

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

  // A muted workspace stays quiet about finished tasks, but a task stuck on the user still asks.
  it("sends a muted workspace's permission requests to tabs and devices, and its finished tasks once the mute ends",
      async () => {
    let fetcher = stubService();
    let offered: string[] = [];
    let { workspaceId } = NOTIFICATION;
    await inUser(async user => {
      await user.newWorkspace(workspaceId, NOTIFICATION.chatTitle);
      await user.registerNotificationDevice("a".repeat(64));
      // A hidden tab: offered everything, shows nothing, so each offer also falls back to push.
      await user.subscribeToNotifications(new RpcStub(new Subscriber(async notification => {
        offered.push(notification.kind);
        throw new Error("hidden");
      })) as unknown as RpcStub<NotificationSubscriber>);
      await user.setWorkspaceNotificationMute(workspaceId, { indefinite: true });
      await user.publishNotification(NOTIFICATION);
      await user.publishNotification({ ...NOTIFICATION, kind: "permissionRequested" });
      await user.setWorkspaceNotificationMute(workspaceId, { until: new Date(Date.now() + 60_000) });
      await user.publishNotification(NOTIFICATION);
      await user.setWorkspaceNotificationMute(workspaceId, { until: new Date(Date.now() - 1) });
      await user.publishNotification(NOTIFICATION);
    });
    expect(offered).toEqual(["permissionRequested", "taskCompleted"]);
    expect(bodies(fetcher, "/v1/deliveries").map(({ type }) => type))
        .toEqual(["permission_requested", "task_completed"]);
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
