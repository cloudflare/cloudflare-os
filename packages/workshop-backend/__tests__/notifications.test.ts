import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NotificationSubscriber, UserNotification, WebPushSubscription } from "@gadgets/workshop-shared/api";
import {
  authorizeDevice, deliver, deliverBadge, registerAuthorizedDevice, registerDevice,
} from "../src/notification-service.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
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
// The id the stub service mints for its `n`th registration.
const mintedId = (n: number) => n.toString(16).padStart(64, "0");
const [ONE, TWO, THREE] = [1, 2, 3].map(mintedId);
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
// device whose key is the registration id, or a browser endpoint's last character repeated;
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
        deviceKey: body.deviceRegistrationId ?? body.webPush.endpoint.at(-1).repeat(64),
        subscriptionId: mintedId(++minted),
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

// Expose the native timeout's otherwise uncancellable timer to the fake clock.
const trackNativeTimeouts = () => vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
  return controller.signal;
});

// Retire each fixture's alarms before another test replaces the global notification service.
afterEach(async () => {
  await reset();
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

  it("signs an absolute badge replacement including zero, without alert fields", async () => {
    const fetcher = stubService();
    await deliverBadge(installEnv, SUBSCRIPTION_ID, 9, 0);
    expect(bodies(fetcher, "/v1/badges")).toEqual([{subscriptionId: SUBSCRIPTION_ID, version: 9, count: 0}]);
  });

  it.each([202, 503])("releases the badge deadline after a %i response", async status => {
    vi.useFakeTimers();
    using _timeout = trackNativeTimeouts();
    stubService().mockResolvedValueOnce(new Response(null, {status}));
    const pending = deliverBadge(installEnv, SUBSCRIPTION_ID, 9, 0);
    if (status === 202) await expect(pending).resolves.toBe(true);
    else await expect(pending).rejects.toThrow("Badge delivery failed");
    expect(vi.getTimerCount()).toBe(0);
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

// A browser subscription whose device key, in stubService(), repeats `n`'s last hex digit.
const browser = (n: number): WebPushSubscription => ({
  endpoint: `https://fcm.googleapis.com/wp/${n.toString(16)}`,
  keys: { p256dh: "BP", auth: "AA" },
});

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
  it("retries only failed devices after eviction while later notifications complete", async () => {
    const fetcher = stubService();
    const stub = env.TEST_USER.getByName(crypto.randomUUID());
    const nextId = crypto.randomUUID();
    await runInDurableObject(stub, async (user, ctx) => {
      user["env"] = {...user["env"], ...INSTALL};
      await user.newWorkspace(NOTIFICATION.workspaceId, "Workspace");
      await user.registerNotificationDevice("a".repeat(64));
      await user.registerNotificationDevice("b".repeat(64));
      fetcher.mockClear();
      fetcher.mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return body.subscriptionId === mintedId(2) && body.eventId === NOTIFICATION.id
          ? new Response(null, {status: 503}) : new Response(null, {status: 202});
      });
      const packet = (sequence: number, id: string) => ({
        head: {chatTitle: NOTIFICATION.chatTitle!, latestSequence: sequence},
        headUpdatedAt: new Date(), hasParticipated: true as const, firstMessageSequence: sequence,
        firstVisibleSequence: sequence, latestVisibleSequence: sequence,
        notifications: [{id, kind: NOTIFICATION.kind, chatTitle: NOTIFICATION.chatTitle, sequence}],
      });
      await user.messageArrived(NOTIFICATION.workspaceId, NOTIFICATION.chatId, packet(1, NOTIFICATION.id));
      const storage = makeUserStorage(ctx.storage);
      await vi.waitFor(() => expect([...storage.notificationOutbox.list()][0]?.failedSubscriptions)
        .toEqual([mintedId(2)]));
      await user.messageArrived(NOTIFICATION.workspaceId, NOTIFICATION.chatId, packet(2, nextId));
      await vi.waitFor(() => expect(storage.chatReadCursors.get(`${NOTIFICATION.workspaceId}:${NOTIFICATION.chatId}`))
        .toMatchObject({notifiedThroughSequence: 2, unreadCount: 2}));
      expect(bodies(fetcher, "/v1/deliveries").map(({eventId, subscriptionId}) => [eventId, subscriptionId]))
        .toEqual([[NOTIFICATION.id, mintedId(1)], [NOTIFICATION.id, mintedId(2)],
          [nextId, mintedId(1)], [nextId, mintedId(2)]]);
      expect([...storage.notificationOutbox.list()]).toHaveLength(1);
    });
    await evictDurableObject(stub);
    fetcher.mockClear();
    fetcher.mockResolvedValue(new Response(null, {status: 202}));
    await runInDurableObject(stub, async (user, ctx) => {
      user["env"] = {...user["env"], ...INSTALL};
      await user.alarm();
      expect([...makeUserStorage(ctx.storage).notificationOutbox.list()]).toEqual([]);
      expect(makeUserStorage(ctx.storage).chatReadCursors.get(`${NOTIFICATION.workspaceId}:${NOTIFICATION.chatId}`))
        .toMatchObject({notifiedThroughSequence: 2, unreadCount: 2});
    });
    expect(bodies(fetcher, "/v1/deliveries").map(({eventId, subscriptionId}) => [eventId, subscriptionId]))
      .toEqual([[NOTIFICATION.id, mintedId(2)]]);
  });

  it.each(["browser", "push", "failure"] as const)("releases the attempt deadline after %s delivery", async outcome => {
    vi.useFakeTimers();
    using _timeout = trackNativeTimeouts();
    const fetcher = stubService();
    await inUser(async user => {
      await user.registerNotificationDevice("a".repeat(64));
      if (outcome === "browser") {
        await user.subscribeToNotifications(new RpcStub(new Subscriber(async () => {})));
      } else if (outcome === "failure") {
        fetcher.mockRejectedValueOnce(new Error("Provider unavailable"));
      }
      const pending = user.publishNotification(NOTIFICATION);
      if (outcome === "failure") await expect(pending).rejects.toThrow("Provider unavailable");
      else await pending;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

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

  it("cancels an in-flight push when workspace access is removed", async () => {
    const fetcher = stubService(), started = Promise.withResolvers<void>();
    await inUser(async user => {
      await user.newWorkspace(NOTIFICATION.workspaceId, "Workspace");
      await user.registerNotificationDevice("a".repeat(64));
      fetcher.mockClear();
      fetcher.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        started.resolve();
      }));
      const result = user.publishNotification(NOTIFICATION).then(() => false, () => true);
      await started.promise;
      await user.workspaceRemoved(NOTIFICATION.workspaceId);
      expect(await result).toBe(true);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });
  });

  it("does not fall back to push after access is removed while awaiting a browser", async () => {
    vi.useFakeTimers();
    const fetcher = stubService(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    await inUser(async user => {
      await user.newWorkspace(NOTIFICATION.workspaceId, "Workspace");
      await user.registerNotificationDevice("a".repeat(64));
      using callback = new RpcStub(new Subscriber(async () => { started.resolve(); await release.promise; }));
      using _subscription = await user.subscribeToNotifications(callback);
      try {
        const result = user.publishNotification(NOTIFICATION).then(() => false, () => true);
        await started.promise;
        await user.workspaceRemoved(NOTIFICATION.workspaceId);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await result).toBe(true);
        expect(pushed(fetcher)).toEqual([]);
      } finally { release.resolve(); }
    });
  });

  it("aborts a stalled push attempt at its remaining retry deadline without dropping the subscription", async () => {
    const fetcher = stubService();
    await inUser(async user => {
      await user.registerNotificationDevice("a".repeat(64));
      fetcher.mockClear();
      fetcher.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), {once: true});
      }));
      await expect(user.publishNotification(NOTIFICATION, Date.now() + 100)).rejects.toThrow();
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      await user.publishNotification(NOTIFICATION);
      expect(pushed(fetcher)).toEqual([ONE, ONE]);
    });
  });

  it("sends phone badges in parallel without sending to browser subscriptions", async () => {
    const fetcher = stubService();
    const release = Promise.withResolvers<Response>();
    await runInDurableObject(env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`), async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      storage.phoneNotificationSubscriptions.put({phone: ONE, tablet: TWO});
      storage.browserNotificationSubscriptions.put({browser: THREE});
      storage.notificationBadge.put({version: 1, count: 0, retryAt: 0});
      fetcher.mockImplementation(() => release.promise);
      const alarm = user.alarm();
      try {
        await vi.waitFor(() => expect(bodies(fetcher, "/v1/badges")
          .map(({subscriptionId}) => subscriptionId).toSorted()).toEqual([ONE, TWO]));
      } finally {
        release.resolve(new Response(null, {status: 202}));
        await alarm;
      }
      expect(storage.notificationBadge.get()).toEqual({version: 1, count: 0});
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("does not queue badge requests for browser-only users", async () => {
    const fetcher = stubService();
    await runInDurableObject(env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`), async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      storage.browserNotificationSubscriptions.put({browser: ONE});
      const workspaceId = env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString();
      await user.newWorkspace(workspaceId, "Workspace");
      await user.messageArrived(workspaceId, 1, {hasParticipated: true, firstMessageSequence: 0,
        firstVisibleSequence: 1, latestVisibleSequence: 1, notifications: []});
      expect(storage.notificationBadge.get()).toEqual({version: 0, count: null});
    });
    expect(bodies(fetcher, "/v1/badges")).toEqual([]);
  });

  it("resends an unchanged badge for phone enrollment but not browser registration", async () => {
    const fetcher = stubService();
    await runInDurableObject(env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`), async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      await user.registerNotificationDevice("a".repeat(64));
      storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
      await user.alarm();
      const delivered = storage.notificationBadge.get();
      expect(delivered).toEqual({version: 1, count: 0});

      for (let i = 0; i < 2; i++) {
        await user.registerNotificationDevice(browser(1));
        expect(storage.notificationBadge.get()).toEqual(delivered);
        expect(await ctx.storage.getAlarm()).toBeNull();
      }
      expect(bodies(fetcher, "/v1/badges")).toEqual([{subscriptionId: ONE, version: 1, count: 0}]);

      await user.registerNotificationDevice("b".repeat(64));
      expect(storage.notificationBadge.get()).toMatchObject({version: 2, count: 0, retryAt: expect.any(Number)});
      storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
      await user.alarm();
      expect(bodies(fetcher, "/v1/badges").slice(1)).toEqual([
        {subscriptionId: ONE, version: 2, count: 0},
        {subscriptionId: mintedId(4), version: 2, count: 0},
      ]);
    });
  });

  it("does not start phone badge work when a browser registers", async () => {
    const fetcher = stubService();
    await runInDurableObject(env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`), async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      storage.phoneNotificationSubscriptions.put({phone: ONE});
      await user.registerNotificationDevice(browser(1));
      expect(storage.notificationBadge.get()).toEqual({version: 0, count: null});
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
    expect(bodies(fetcher, "/v1/badges")).toEqual([]);
  });

  it.each(["count change", "phone enrollment"] as const)(
    "expires failed badge retries after eviction and starts a fresh window on %s", async trigger => {
      vi.useFakeTimers();
      const now = Date.parse("2030-01-01T00:00:00Z"), lifetime = 10 * 60_000;
      vi.setSystemTime(now);
      const fetcher = stubService();
      const service = fetcher.getMockImplementation()!;
      const stub = env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (user, ctx) => {
        Object.defineProperty(user, "env", {value: installEnv});
        await user.registerNotificationDevice("a".repeat(64));
        const storage = makeUserStorage(ctx.storage);
        expect(storage.notificationBadge.get()).toMatchObject({expiresAt: now + lifetime});
        vi.setSystemTime(now + lifetime - 20_000);
        fetcher.mockResolvedValue(new Response(null, {status: 503}));
        await user.alarm();
        expect(storage.notificationBadge.get()).toEqual({version: 1, count: 0,
          retryAt: now + lifetime, expiresAt: now + lifetime});
        expect(await ctx.storage.getAlarm()).toBe(now + lifetime);
      });
      await evictDurableObject(stub);
      vi.setSystemTime(now + lifetime);
      fetcher.mockClear();
      await runInDurableObject(stub, async (user, ctx) => {
        Object.defineProperty(user, "env", {value: installEnv});
        const storage = makeUserStorage(ctx.storage);
        await user.alarm();
        expect(storage.notificationBadge.get()).toEqual({version: 1, count: 0});
        expect(await ctx.storage.getAlarm()).toBeNull();
        expect(bodies(fetcher, "/v1/badges")).toEqual([]);
        fetcher.mockImplementation(service);
        if (trigger === "phone enrollment") {
          await user.registerNotificationDevice("b".repeat(64));
        } else {
          const workspaceId = env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString();
          await user.newWorkspace(workspaceId, "Workspace");
          await user.messageArrived(workspaceId, 1, {hasParticipated: true, firstMessageSequence: 0,
            firstVisibleSequence: 1, latestVisibleSequence: 1, notifications: []});
        }
        expect(storage.notificationBadge.get()).toMatchObject({version: 2,
          count: trigger === "phone enrollment" ? 0 : 1,
          retryAt: now + lifetime + 1_000, expiresAt: now + 2 * lifetime});
      });
    });

  it("keeps the first badge deadline while more messages arrive", async () => {
    vi.useFakeTimers();
    stubService();
    await runInDurableObject(env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`), async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      storage.phoneNotificationSubscriptions.put({phone: ONE});
      const workspaceId = env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString();
      await user.newWorkspace(workspaceId, "Workspace");
      await user.messageArrived(workspaceId, 1, {hasParticipated: true, firstMessageSequence: 0,
        firstVisibleSequence: 1, latestVisibleSequence: 1, notifications: []});
      const deadline = storage.notificationBadge.get().retryAt;
      await vi.advanceTimersByTimeAsync(400);
      await user.messageArrived(workspaceId, 1, {hasParticipated: true, firstMessageSequence: 1,
        firstVisibleSequence: 2, latestVisibleSequence: 2, notifications: []});
      expect(storage.notificationBadge.get()).toMatchObject({count: 2, retryAt: deadline});
    });
  });

  it("rehydrates all durable counts locally before replacing a badge after a cold message wake", async () => {
    const fetcher = stubService();
    const stub = env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`);
    const workspaceId = env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString();
    await runInDurableObject(stub, async (user, ctx) => {
      await user.newWorkspace(workspaceId, "Existing workspace");
      const storage = makeUserStorage(ctx.storage);
      for (const [chatId, unreadCount] of [[1, 3], [2, 5]]) storage.chatReadCursors.put({
        workspaceId, chatId, hasParticipated: true, readThroughSequence: -1, readThroughVisibleSequence: 0,
        latestVisibleSequence: unreadCount, unreadCount, notifiedThroughSequence: -1});
      storage.phoneNotificationSubscriptions.put({phone: ONE});
      storage.notificationBadge.put({version: 1, count: 8});
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      await user.messageArrived(workspaceId, 1, {hasParticipated: true, firstMessageSequence: 4,
        firstVisibleSequence: 4, latestVisibleSequence: 4, notifications: []});
      const storage = makeUserStorage(ctx.storage);
      expect(storage.notificationBadge.get()).toMatchObject({count: 9});
      storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
      await user.alarm();
      expect(storage.notificationBadge.get()).toEqual({version: 2, count: 9});
    });
    expect(bodies(fetcher, "/v1/badges").map(({count}) => count)).toEqual([9]);
  });

  it.each(["workspaceRemoved", "deleteWorkspace"] as const)("clears a cold badge on %s from durable cursors", async removal => {
    const fetcher = stubService();
    const stub = env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`);
    const workspaceId = env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString();
    await runInDurableObject(stub, async (user, ctx) => {
      await user.newWorkspace(workspaceId, "Deleted workspace");
      const storage = makeUserStorage(ctx.storage);
      storage.chatReadCursors.put({workspaceId, chatId: 1, hasParticipated: true, readThroughSequence: -1,
        readThroughVisibleSequence: 0, latestVisibleSequence: 8, unreadCount: 8, notifiedThroughSequence: 7});
      storage.phoneNotificationSubscriptions.put({phone: ONE});
      storage.notificationBadge.put({version: 1, count: 8});
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      expect([...storage.chatReadCursors.list()]).toHaveLength(1);
      await user[removal](workspaceId);
      expect(storage.notificationBadge.get().retryAt).toBeDefined();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      for (let attempt = 0; attempt < 2 && storage.notificationBadge.get().retryAt !== undefined; attempt++) {
        storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
        await user.alarm();
      }
      expect(storage.notificationBadge.get()).toEqual({version: 2, count: 0});
    });
    expect(bodies(fetcher, "/v1/badges").map(({count}) => count)).toEqual([0]);
  });

  it("registers a device from clean local counts without source reads after eviction", async () => {
    const fetcher = stubService();
    const stub = env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`);
    const workspaceId = env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString();
    await runInDurableObject(stub, async (user, ctx) => {
      await user.newWorkspace(workspaceId, "Existing workspace");
      makeUserStorage(ctx.storage).chatReadCursors.put({workspaceId, chatId: 1, hasParticipated: true, readThroughSequence: -1,
        readThroughVisibleSequence: 0, latestVisibleSequence: 8, unreadCount: 8, notifiedThroughSequence: 7});
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      await user.registerNotificationDevice("a".repeat(64));
      const storage = makeUserStorage(ctx.storage);
      expect(storage.notificationBadge.get()).toMatchObject({count: 8});
      storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
      await user.alarm();
    });
    expect(bodies(fetcher, "/v1/badges").map(({count}) => count)).toEqual([8]);
  });

  it("recovers a pending badge after reset and retries a lost ACK without replaying an alert", async () => {
    const fetcher = stubService();
    let stub = env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`);
    let expiresAt: number | undefined;
    const reset = async () => {
      await expect(runInDurableObject(stub, async (_user, ctx) => {
        await ctx.storage.sync();
        ctx.abort("Badge recovery reset");
      })).rejects.toThrow("Badge recovery reset");
      stub = env.TEST_USER.get(stub.id);
    };
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      storage.phoneNotificationSubscriptions.put({phone: ONE});
      // Keep the real alarm from delivering before the lost-ACK fault is installed after reset.
      const retryAt = Date.now() + 60_000;
      storage.notificationBadge.put({version: 7, count: 8, retryAt});
      await ctx.storage.setAlarm(retryAt);
    });
    await reset();
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      fetcher.mockImplementationOnce(async () => { throw new Error("Lost ACK"); });
      storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
      await user.alarm();
      expect(storage.notificationBadge.get()).toMatchObject({version: 7, count: 8});
      expect(storage.notificationBadge.get().retryAt).toBeGreaterThan(Date.now());
      expiresAt = storage.notificationBadge.get().expiresAt;
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(await ctx.storage.getAlarm()).not.toBeNull();
    });
    await reset();
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      expect(storage.notificationBadge.get().expiresAt).toBe(expiresAt);
      storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
      await user.alarm();
      expect(storage.notificationBadge.get()).toEqual({version: 7, count: 8});
    });
    expect(bodies(fetcher, "/v1/badges")).toEqual([
      {subscriptionId: ONE, version: 7, count: 8}, {subscriptionId: ONE, version: 7, count: 8},
    ]);
    expect(pushed(fetcher)).toEqual([]);
  });

  it.each(["thread", "workspace", "all"] as const)("persists a %s read badge during alert delivery and recovers it after reset", async action => {
    const fetcher = stubService();
    let stub = env.TEST_USER.getByName(`badge-${crypto.randomUUID()}`);
    const workspaceId = env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString();
    const notifying = Promise.withResolvers<void>(), releaseAlert = Promise.withResolvers<void>();
    try {
      await expect(runInDurableObject(stub, async (user, ctx) => {
        Object.defineProperty(user, "env", {value: installEnv});
        await user.newWorkspace(workspaceId, "Workspace");
        await user.messageArrived(workspaceId, 7, {hasParticipated: true, firstMessageSequence: 0,
          firstVisibleSequence: 1, latestVisibleSequence: 1, notifications: []});
        const storage = makeUserStorage(ctx.storage);
        storage.phoneNotificationSubscriptions.put({phone: ONE});
        storage.notificationBadge.put({version: 1, count: 1, retryAt: 0});
        await user.subscribeToNotifications(new RpcStub(new Subscriber(async () => {
          notifying.resolve(); await releaseAlert.promise;
        })));
        await user.messageArrived(workspaceId, 7, {head: {chatTitle: "Read thread", latestSequence: 1}, headUpdatedAt: new Date(),
          firstMessageSequence: 1, firstVisibleSequence: 2, latestVisibleSequence: 2, hasParticipated: true,
          notifications: [{...NOTIFICATION, sequence: 1}]});
        await notifying.promise;
        if (action === "workspace") await user.markWorkspaceRead(workspaceId);
        else if (action === "all") await user.markAllRead();
        else {
          await user.applyReadHorizon(workspaceId, 7, {
            readThroughSequence: 1, readThroughVisibleSequence: 2, latestVisibleSequence: 2,
            head: {chatTitle: "Read thread", latestSequence: 1}, headUpdatedAt: new Date(), notificationBaseline: -1,
          }, false);
        }
        expect(storage.notificationBadge.get()).toMatchObject({version: 3, count: 0});
        expect(storage.chatReadCursors.get(`${workspaceId}:7`)).toMatchObject({unreadCount: 0});
        await ctx.storage.sync();
        ctx.abort("Reset during read notification");
      })).rejects.toThrow("Reset during read notification");
    } finally { releaseAlert.resolve(); }
    fetcher.mockImplementation(async input => new URL(String(input)).pathname === "/v1/deliveries"
      ? new Response(null, {status: 503}) : new Response(null, {status: 202}));
    stub = env.TEST_USER.get(stub.id);
    await runInDurableObject(stub, async (user, ctx) => {
      Object.defineProperty(user, "env", {value: installEnv});
      const storage = makeUserStorage(ctx.storage);
      storage.notificationBadge.put({...storage.notificationBadge.get(), retryAt: 0});
      await user.alarm();
      expect([...storage.notificationOutbox.list()]).toHaveLength(1);
      expect(storage.notificationBadge.get()).toEqual({version: 3, count: 0});
    });
    expect(bodies(fetcher, "/v1/badges").at(-1)?.count).toBe(0);
  });

  it("does not clear a newer local badge when an older delivery finishes", async () => {
    const fetcher = stubService();
    await inUser(async user => {
      await user.registerNotificationDevice("a".repeat(64));
      const storage = Reflect.get(user, "storage") as ReturnType<typeof makeUserStorage>;
      storage.notificationBadge.put({version: 7, count: 8, retryAt: 0});
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      });
      const delivery = user.alarm();
      try {
        await entered.promise;
        await user.newWorkspace(env.TEST_OVERSEER.idFromName(crypto.randomUUID()).toString(), "Not loaded");
        await user.registerNotificationDevice("b".repeat(64));
        expect(storage.notificationBadge.get().count).toBe(0);
      } finally { release.resolve(); }
      await delivery;
      expect(storage.notificationBadge.get()).toMatchObject({version: 8, count: 0});
      expect(storage.notificationBadge.get().retryAt).toBeDefined();
    });
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

  it("does not fall back to push for a queued alert muted and unmuted while its browser offer was pending", async () => {
    const fetcher = stubService();
    await inUser(async user => {
      const {workspaceId, chatId} = NOTIFICATION;
      await user.newWorkspace(workspaceId, "Workspace");
      await user.registerNotificationDevice("a".repeat(64));
      const offered = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>();
      using _subscription = await user.subscribeToNotifications(new RpcStub(new Subscriber(() => {
        offered.resolve();
        return answer.promise;
      })));
      using publishing = vi.spyOn(user, "publishNotification");
      const position = {head: {chatTitle: "Chat", latestSequence: 1}, headUpdatedAt: new Date(),
        latestVisibleSequence: 1, hasParticipated: true as const};
      await user.messageArrived(workspaceId, chatId, {...position,
        firstMessageSequence: 1, firstVisibleSequence: 1,
        notifications: [{id: NOTIFICATION.id, kind: NOTIFICATION.kind, chatTitle: "Chat", sequence: 1}]});
      await offered.promise;
      await user.setChatNotificationsEnabled(workspaceId, chatId, false, {notifiedThroughSequence: 1});
      await user.setChatNotificationsEnabled(workspaceId, chatId, true, {notifiedThroughSequence: 1});
      answer.reject(new Error("Browser hidden"));
      await publishing.mock.results[0].value;
      expect(bodies(fetcher, "/v1/deliveries")).toEqual([]);
      expect((await user.getUnreadSummary()).unreadMessageCount).toBe(1);
    });
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

  // A user's loop over any of these would otherwise heat the installation's shared central records.
  it("refuses every device method past 20 calls a minute between them, contacting nothing, while deliveries still go out",
      async () => {
    vi.useFakeTimers();
    let fetcher = stubService();
    await inUser(async user => {
      for (let i = 0; i < 19; i++) await user.registerNotificationDevice("a".repeat(64));
      await user.authorizeNotificationDevice();
      fetcher.mockClear();
      await expect(user.authorizeNotificationDevice()).rejects.toThrow("Too many");
      await expect(user.registerNotificationDevice("b".repeat(64))).rejects.toThrow("Too many");
      await expect(user.registerAuthorizedNotificationDevice("c".repeat(64)))
          .rejects.toThrow("Too many");
      expect(fetcher).not.toHaveBeenCalled();
      await user.publishNotification(NOTIFICATION);
    });
    expect(pushed(fetcher)).toEqual([mintedId(19)]);
  });

  it("accepts registrations again once the minute has passed", async () => {
    vi.useFakeTimers();
    let fetcher = stubService();
    await inUser(async user => {
      for (let i = 0; i < 20; i++) await user.registerNotificationDevice("a".repeat(64));
      // Refused halfway through the minute, which must not restart it.
      vi.advanceTimersByTime(30_000);
      await expect(user.registerNotificationDevice("a".repeat(64))).rejects.toThrow("Too many");
      vi.advanceTimersByTime(30_000);
      await user.registerNotificationDevice("b".repeat(64));
    });
    expect(bodies(fetcher, "/v1/subscriptions")).toHaveLength(21);
  });

  // The service keeps a user's 10 most recently registered phones and, separately, browsers, but
  // the User DO keeps an entry until a push to it is refused as dead, so a registration loop could
  // pile up entries for one notification to fan out to.
  it("pushes only to the 10 most recently registered phones and browsers", async () => {
    vi.useFakeTimers();
    let fetcher = stubService();
    await inUser(async user => {
      // Subscriptions 1-20: a phone, 10 browsers, then 9 more phones.
      await user.registerNotificationDevice(mintedId(1));
      for (let n = 1; n <= 10; n++) await user.registerNotificationDevice(browser(n));
      for (let n = 2; n <= 10; n++) await user.registerNotificationDevice(mintedId(n));
      vi.advanceTimersByTime(60_000);
      // The first browser registers again, leaving the second the stalest, which an 11th browser
      // displaces. The first phone stays: only another phone takes a phone's place.
      await user.registerNotificationDevice(browser(1));
      await user.registerNotificationDevice(browser(11));
      await user.publishNotification(NOTIFICATION);
    });
    expect(pushed(fetcher))
        .toEqual([1, ...Array.from({ length: 19 }, (_, i) => i + 4)].map(mintedId));
  });

  // The service evicts the browser it received longest ago, so the User DO must store browsers in
  // the order the service received them, even when one's response is slow to arrive.
  it("stores browsers in the order the service received them", async () => {
    let fetcher = stubService();
    let answer = fetcher.getMockImplementation()!;
    let released = Promise.withResolvers<void>();
    fetcher.mockImplementationOnce(async (input, init) => {
      let response = await answer(input, init);
      await released.promise;
      return response;
    });
    await inUser(async user => {
      let first = user.registerNotificationDevice(browser(1));
      let second = user.registerNotificationDevice(browser(2));
      // Holds the first response until the second registration is stored, were it sent alongside.
      // A correct User DO sends nothing meanwhile, so no event can end the hold and it is bounded
      // in real time instead; fake timers can't, as signing a request waits on real crypto.
      await Promise.race([second, scheduler.wait(100)]);
      released.resolve();
      await Promise.all([first, second]);
      for (let n = 3; n <= 11; n++) await user.registerNotificationDevice(browser(n));
      await user.publishNotification(NOTIFICATION);
    });
    // The 11th browser evicted the first, subscription 1, at the service.
    expect(pushed(fetcher)).toEqual(Array.from({ length: 10 }, (_, i) => mintedId(i + 2)));
  });

  it("registers again after a registration fails", async () => {
    let fetcher = stubService();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await inUser(async user => {
      await expect(user.registerNotificationDevice(browser(1))).rejects.toThrow("503");
      await user.registerNotificationDevice(browser(2));
      await user.publishNotification(NOTIFICATION);
    });
    expect(pushed(fetcher)).toEqual([ONE]);
  });
});
