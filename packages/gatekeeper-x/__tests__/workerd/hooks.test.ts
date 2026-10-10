// Push notifications, end to end: a hook binds nothing at X until enabled; enabling registers the
// deployment's webhook and the subscription its events need, with the right token; a signed
// delivery reaches each hook watching for it, once, after the binding re-checks it; and disabling,
// or disconnecting the account, gives up the subscriptions nothing else watches. X is faked at
// `fetch`, and its deliveries reach the worker through SELF.

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/x";
import type { Env } from "../../src/x-env";
import { watches } from "../../src/x-hooks";
import type { XPostInfo } from "../../src/types";
import { ALICE, BOB, FakeX, failure, hmacBase64, json, hooks as sharedHooks, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps, Step } from "./worker";

// The registry is one per deployment and a router one per X user, so each test starts from a
// deployment that has registered nothing at X, as its fake X has not.
beforeEach(async () => {
  for (const stub of [
    env.X_WEBHOOK_REGISTRY.getByName("deployment"),
    env.X_ACTIVITY_ROUTER.getByName(ALICE.id),
    env.X_ACTIVITY_ROUTER.getByName(BOB.id),
  ]) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const WEBHOOK = "https://gadgets.test/gatekeeper/x/webhook";

/** A binding with a TestHooks object of its own, standing in for one workspace's overseer. */
function binding(props: GatekeeperProps) {
  const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.newUniqueId());
  const name = crypto.randomUUID();
  return {
    subscribe: async (steps: Step[]) => unwrap(await hooks.subscribeHook(name, props, steps)),
    trySubscribe: async (steps: Step[]) => await hooks.subscribeHook(name, props, steps),
    enable: async () => unwrap(await hooks.enableHook()),
    tryEnable: async () => await hooks.enableHook(),
    disable: async () => unwrap(await hooks.disableHook()),
    /** Admits an observer connected through `observerAccount`, as "observer". */
    observe: async (observerAccount: string) => unwrap(await hooks.addObserver(name, props, "observer", observerAccount)),
    behave: (behavior: { failures?: number; reply?: string }) => hooks.setHookBehavior(behavior),
    read: async () => await hooks.readHook() as {
      received: { id: string; reason: string; info: XPostInfo }[];
      capabilities: boolean[];
      observations: { title: string; description: string; excludeObservers?: string[] }[];
      submissions: { actionId: number; title: string }[];
    },
  };
}

const driver = (account: string) => env.X_HOOK_DRIVER.getByName(account);

/** Waits until the account's driver has no delivery due: its own alarm runs them. */
const settled = (account: string) => vi.waitFor(() => runInDurableObject(driver(account), (_instance, state) => {
  const due = [...state.storage.kv.list<{ at?: number }>({ prefix: "msg:" })]
    .filter(([, row]) => row.at !== undefined && row.at <= Date.now());
  if (due.length > 0) throw new Error(`${due.length} deliveries due`);
}));

const subscriptionsOf = (x: FakeX) =>
  [...x.subscriptions.values()].map(subscription => [subscription.event_type, subscription.filter.user_id ?? null, subscription.by]);

/** An account binding for Alice with an enabled mentions hook. */
async function watchingMentions(x = new FakeX().install()) {
  const account = await seedAccount(x);
  const hook = binding({ userObjectId: account, resourceKind: "account" });
  await hook.subscribe([["subscribeMentions"]]);
  await hook.enable();
  return { x, account, hook };
}

describe("the webhook route", () => {
  it("answers X's challenge with the client secret's signature", async () => {
    const response = await SELF.fetch(`${WEBHOOK}?crc_token=challenge-123`);
    expect(await response.json()).toEqual({ response_token: `sha256=${await hmacBase64("test-client-secret", "challenge-123")}` });
  });

  it("refuses a delivery that isn't X's", async () => {
    const body = JSON.stringify({ data: {} });
    expect((await SELF.fetch(WEBHOOK, { method: "POST", body })).status).toBe(400);
    const forged = await SELF.fetch(WEBHOOK, {
      method: "POST", body, headers: { "X-Twitter-Webhooks-Signature-OAuth2": `sha256=${await hmacBase64("not-the-secret", body)}` },
    });
    expect(forged.status).toBe(401);
    const huge = "x".repeat(5 * 1024 * 1024 + 1);
    const tooLarge = await SELF.fetch(WEBHOOK, {
      method: "POST", body: huge, headers: { "X-Twitter-Webhooks-Signature-OAuth2": `sha256=${await hmacBase64("test-client-secret", huge)}` },
    });
    expect(tooLarge.status).toBe(413);
  });

  it("is inert where push notifications aren't configured", async () => {
    const unconfigured = { ...env, X_APP_BEARER_TOKEN: undefined } as Env;
    const ctx = { exports: {} } as unknown as ExecutionContext;
    expect((await worker.fetch(new Request(`http://localhost:8787/gatekeeper/x/webhook?crc_token=a`), unconfigured, ctx)).status).toBe(404);
  });
});

describe("subscribing", () => {
  it("binds nothing at X until the hook is enabled", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const hook = binding({ userObjectId: account, resourceKind: "account" });
    expect(await hook.subscribe([["subscribeMentions"]])).toEqual({
      title: "Hear of posts mentioning @alice on X",
      description: "Call this hook with each post that mentions @alice, letting it read the post and queue a reply " +
        "or other actions for approval. X bills each delivered post as a post read.",
    });
    expect(x.webhooks.size + x.subscriptions.size).toBe(0);

    await hook.enable();
    expect([...x.webhooks.values()].map(webhook => webhook.url)).toEqual([WEBHOOK]);
    // A mention is private, so Alice's own token subscribes; revocations are the app's.
    expect(subscriptionsOf(x)).toEqual([["oauth.revoke", null, "app"], ["post.mention.create", ALICE.id, ALICE.id]]);
  });

  it("subscribes to a watched user's posts with the app's token", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const hook = binding({ userObjectId: account, resourceKind: "profile", username: "bob" });
    expect((await hook.subscribe([["subscribePosts"]])).title).toBe("Hear of new posts by @bob on X");
    await hook.enable();
    expect(subscriptionsOf(x)).toContainEqual(["post.create", BOB.id, "app"]);
  });

  it("won't watch the connected account's own posts, which a hook could answer itself", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const viaAccount = binding({ userObjectId: account, resourceKind: "account" });
    expect(failure(await viaAccount.trySubscribe([["getUser", "alice"], ["subscribePosts"]])))
      .toMatch(/own posts can't be watched/);
    const viaProfile = binding({ userObjectId: account, resourceKind: "profile", username: "alice" });
    expect(failure(await viaProfile.trySubscribe([["subscribePosts"]]))).toMatch(/own posts can't be watched/);
    // Nor would a driver queue them for a post hook, should one exist.
    const event = { id: "evt", kind: "post" as const, userId: ALICE.id, post: { id: "1", author_id: ALICE.id } };
    expect(watches({ kind: "post", userId: ALICE.id, viewerId: ALICE.id }, event)).toBe(false);
    expect(watches({ kind: "post", userId: ALICE.id, viewerId: BOB.id }, event)).toBe(true);
  });

  it("watches replies only to the account's own posts", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const theirs = x.post(BOB, "not Alice's");
    const hook = binding({ userObjectId: account, resourceKind: "account" });
    expect(failure(await hook.trySubscribe([["getPost", theirs.id], ["subscribeReplies"]])))
      .toMatch(/Only replies to the connected account's own posts/);
  });

  it("shares one subscription among hooks, and ends it with the last", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const first = binding({ userObjectId: account, resourceKind: "account" });
    const second = binding({ userObjectId: account, resourceKind: "account" });
    for (const hook of [first, second]) {
      await hook.subscribe([["subscribeMentions"]]);
      await hook.enable();
    }
    const mentions = () => subscriptionsOf(x).filter(([type]) => type === "post.mention.create");
    expect(mentions()).toHaveLength(1);
    await first.disable();
    expect(mentions()).toHaveLength(1);
    await second.disable();
    expect(mentions()).toHaveLength(0);
  });

  it("keeps a subscription X failed to delete, and deletes it again from the alarm", async () => {
    const { x, hook } = await watchingMentions();
    let outage = true;
    x.on("DELETE", /^\/2\/activity\/subscriptions\//, () => outage ? json({ title: "Service Unavailable" }, { status: 503 }) : undefined);
    await hook.disable();
    const mentions = () => subscriptionsOf(x).filter(([type]) => type === "post.mention.create");
    expect(mentions()).toHaveLength(1);
    outage = false;
    expect(await runDurableObjectAlarm(env.X_ACTIVITY_ROUTER.getByName(ALICE.id))).toBe(true);
    expect(mentions()).toHaveLength(0);
  });

  it("subscribes afresh when a hook needs a subscription X may have deleted", async () => {
    const { x, account, hook } = await watchingMentions();
    // X deletes it, but the answer is lost.
    x.loseAnswer("DELETE", /^\/2\/activity\/subscriptions\//);
    await hook.disable();
    const again = binding({ userObjectId: account, resourceKind: "account" });
    await again.subscribe([["subscribeMentions"]]);
    await again.enable();
    expect(subscriptionsOf(x).filter(([type]) => type === "post.mention.create")).toHaveLength(1);
  });
});

describe("delivering", () => {
  it("delivers a mention with a capability to answer it", async () => {
    const { x, account, hook } = await watchingMentions();
    await hook.behave({ reply: "Thanks for asking!" });
    const mention = x.post(BOB, "hey @alice, a question");
    expect(await x.deliver("post.mention.create", ALICE.id, mention, { id: "evt-1", includes: { users: [BOB] } })).toBe(200);
    await settled(account);

    const { received, capabilities, observations, submissions } = await hook.read();
    expect(received).toEqual([{
      id: "evt-1", reason: "mention",
      info: expect.objectContaining({ id: mention.id, text: "hey @alice, a question", author: expect.objectContaining({ username: "bob" }) }),
    }]);
    expect(capabilities).toEqual([true]);
    expect(observations.map(observation => observation.description))
      .toEqual(["Received a post by @bob mentioning the connected account."]);
    // The reply the hook queued waits for approval like any other.
    expect(submissions.map(submission => submission.title)).toEqual(["Reply on X to @bob as @alice"]);
    expect([...x.posts.values()].filter(post => post.author_id === ALICE.id)).toHaveLength(0);
  });

  it("names an author X left out of the delivery", async () => {
    const { x, account, hook } = await watchingMentions();
    const mention = x.post(BOB, "hi @alice");
    await x.deliver("post.mention.create", ALICE.id, mention);
    await settled(account);
    expect((await hook.read()).received[0].info.author).toMatchObject({ id: BOB.id, username: "bob" });
  });

  it("keeps a post whose author can't be looked up from observers connected as other X users", async () => {
    const { x, account, hook } = await watchingMentions();
    await hook.observe(await seedAccount(x, BOB));
    x.on("GET", new RegExp(`^/2/users/${BOB.id}\\b`), () => json({ title: "Service Unavailable" }, { status: 503 }));
    await x.deliver("post.mention.create", ALICE.id, x.post(BOB, "hi @alice"));
    await settled(account);
    const { received, observations } = await hook.read();
    expect(received).toHaveLength(1);
    expect(observations.map(observation => observation.excludeObservers)).toEqual([["observer"]]);
  });

  it("delivers each event once, never the account's own posts, and nothing too old to tell from a replay", async () => {
    const { x, account, hook } = await watchingMentions();
    const mention = x.post(BOB, "hi @alice");
    await x.deliver("post.mention.create", ALICE.id, mention, { id: "evt-1", includes: { users: [BOB] } });
    await x.deliver("post.mention.create", ALICE.id, mention, { id: "evt-1", includes: { users: [BOB] } });
    await x.deliver("post.mention.create", ALICE.id, x.post(ALICE, "note to self @alice"), { id: "evt-2" });
    await x.deliver("post.mention.create", ALICE.id, x.post(BOB, "old @alice"), {
      id: "evt-3", createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await settled(account);
    expect((await hook.read()).received.map(event => event.id)).toEqual(["evt-1"]);
  });

  it("delivers replies to a Post binding's post only, confined to its conversation", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const root = x.post(ALICE, "Announcing something");
    const elsewhere = x.post(ALICE, "Something else");
    const hook = binding({ userObjectId: account, resourceKind: "post", postId: root.id });
    expect((await hook.subscribe([["subscribeReplies"]])).title).toBe("Hear of replies to a post on X");
    await hook.enable();
    const replyTo = (parent: typeof root, text: string) => x.post(BOB, text, {
      conversation_id: parent.conversation_id, in_reply_to_user_id: ALICE.id,
      referenced_tweets: [{ type: "replied_to", id: parent.id }],
    });
    const wanted = replyTo(root, "Congratulations");
    await x.deliver("post.reply.create", ALICE.id, wanted, { includes: { users: [BOB] } });
    await x.deliver("post.reply.create", ALICE.id, replyTo(elsewhere, "Unrelated"), { includes: { users: [BOB] } });
    await settled(account);
    const { received, capabilities } = await hook.read();
    expect(received.map(event => [event.reason, event.info.id])).toEqual([["reply", wanted.id]]);
    expect(capabilities).toEqual([true]);
  });

  it("delivers a Profile binding's posts with nothing to act with", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const hook = binding({ userObjectId: account, resourceKind: "profile", username: "bob" });
    await hook.subscribe([["subscribePosts"]]);
    await hook.enable();
    const post = x.post(BOB, "Fresh post");
    await x.deliver("post.create", BOB.id, post, { includes: { users: [BOB] } });
    // Another user's post, though X should never send one under Bob's subscription.
    await x.deliver("post.create", BOB.id, x.post(ALICE, "Not Bob's"), { includes: { users: [ALICE] } });
    await settled(account);
    const { received, capabilities } = await hook.read();
    expect(received.map(event => [event.reason, event.info.id])).toEqual([["post", post.id]]);
    expect(capabilities).toEqual([false]);
  });

  it("retries a delivery the hook failed", async () => {
    const { x, account, hook } = await watchingMentions();
    await hook.behave({ failures: 1 });
    await x.deliver("post.mention.create", ALICE.id, x.post(BOB, "hi @alice"), { id: "evt-1", includes: { users: [BOB] } });
    await settled(account);
    expect((await hook.read()).received).toEqual([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await runDurableObjectAlarm(driver(account));
    vi.useRealTimers();
    expect((await hook.read()).received.map(event => event.id)).toEqual(["evt-1"]);
  });

  it("delivers nothing once the hook is disabled", async () => {
    const { x, account, hook } = await watchingMentions();
    await hook.disable();
    expect(subscriptionsOf(x).map(([type]) => type)).toEqual(["oauth.revoke"]);
    expect(await x.deliver("post.mention.create", ALICE.id, x.post(BOB, "hi @alice"))).toBe(200);
    await settled(account);
    expect((await hook.read()).received).toEqual([]);
  });
});

describe("accounts going away", () => {
  it("gives up a disconnected account's subscriptions, and refuses its hooks", async () => {
    const { x, account } = await watchingMentions();
    unwrap(await sharedHooks().user(account, "revoke"));
    expect(subscriptionsOf(x).map(([type]) => type)).toEqual(["oauth.revoke"]);
    const late = binding({ userObjectId: account, resourceKind: "account" });
    expect(failure(await late.trySubscribe([["subscribeMentions"]]))).toMatch(/Reconnect the X account/);
  });

  it("refuses a hook bound before the account was disconnected and enabled after", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const hook = binding({ userObjectId: account, resourceKind: "profile", username: "bob" });
    await hook.subscribe([["subscribePosts"]]);
    unwrap(await sharedHooks().user(account, "revoke"));
    expect(failure(await hook.tryEnable())).toBe("This X account has been disconnected.");
    expect(x.subscriptions.size).toBe(0);
  });

  it("undoes the subscription of a hook enabled as the account is disconnected", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const hook = binding({ userObjectId: account, resourceKind: "profile", username: "bob" });
    await hook.subscribe([["subscribePosts"]]);
    // X holds the subscription request until the disconnect has begun.
    let subscribing = false;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    x.on("POST", /^\/2\/activity\/subscriptions$/, async request => {
      if (JSON.parse(request.body!).event_type !== "post.create") return undefined;
      subscribing = true;
      await released;
      return undefined;
    });
    const enabling = hook.tryEnable();
    await vi.waitFor(() => expect(subscribing).toBe(true));
    const revoking = sharedHooks().user(account, "revoke");
    await vi.waitFor(() => runInDurableObject(driver(account), (_instance, state) =>
      expect(state.storage.kv.get("revoked")).toBe(true)));
    release();
    expect(failure(await enabling)).toBe("This X account has been disconnected.");
    unwrap(await revoking);
    expect(subscriptionsOf(x).map(([type]) => type)).toEqual(["oauth.revoke"]);
  });

  it("ends a disabled hook's subscription though a disconnect overtook the disabling", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const watchingBob = binding({ userObjectId: account, resourceKind: "profile", username: "bob" });
    await watchingBob.subscribe([["subscribePosts"]]);
    await watchingBob.enable();
    // Another hook's enable holds the driver's changes while X makes its subscription.
    const mentions = binding({ userObjectId: account, resourceKind: "account" });
    await mentions.subscribe([["subscribeMentions"]]);
    let subscribing = false;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    x.on("POST", /^\/2\/activity\/subscriptions$/, async request => {
      if (JSON.parse(request.body!).event_type !== "post.mention.create") return undefined;
      subscribing = true;
      await released;
      return undefined;
    });
    const enabling = mentions.tryEnable();
    await vi.waitFor(() => expect(subscribing).toBe(true));
    // Disabled, so its registration is gone, but its cleanup waits behind the enable...
    const disabling = watchingBob.disable();
    await vi.waitFor(() => runInDurableObject(driver(account), (_instance, state) =>
      expect([...state.storage.kv.list({ prefix: "reg:" })]).toEqual([])));
    // ...when the disconnect, finding no registration, clears the driver.
    const revoking = sharedHooks().user(account, "revoke");
    await vi.waitFor(() => runInDurableObject(driver(account), (_instance, state) =>
      expect(state.storage.kv.get("revoked")).toBe(true)));
    release();
    failure(await enabling);
    await disabling;
    unwrap(await revoking);
    expect(subscriptionsOf(x).map(([type]) => type)).toEqual(["oauth.revoke"]);
  });

  it("subscribes again after the user revoked the app, adopting what X kept", async () => {
    const { x, account } = await watchingMentions();
    await x.deliver("oauth.revoke", undefined, { user_id: ALICE.id, app_id: "1", date_time: new Date().toISOString() });
    const again = binding({ userObjectId: account, resourceKind: "account" });
    await again.subscribe([["subscribeMentions"]]);
    await again.enable();
    expect(subscriptionsOf(x).filter(([type]) => type === "post.mention.create")).toHaveLength(1);
  });
});

describe("the deployment's webhook", () => {
  it("finishes its setup on the next enable, and schedules its check, when the first failed part-way", async () => {
    const x = new FakeX().install();
    const account = await seedAccount(x);
    const hook = binding({ userObjectId: account, resourceKind: "account" });
    await hook.subscribe([["subscribeMentions"]]);
    let outage = true;
    x.on("POST", /^\/2\/activity\/subscriptions$/, request =>
      outage && JSON.parse(request.body!).event_type === "oauth.revoke" ? json({ title: "Service Unavailable" }, { status: 503 }) : undefined);
    failure(await hook.tryEnable());
    expect([...x.webhooks.values()].map(webhook => webhook.url)).toEqual([WEBHOOK]);
    expect(await runInDurableObject(env.X_WEBHOOK_REGISTRY.getByName("deployment"), (_instance, state) =>
      state.storage.getAlarm())).not.toBeNull();
    outage = false;
    await hook.enable();
    expect(subscriptionsOf(x)).toEqual([["oauth.revoke", null, "app"], ["post.mention.create", ALICE.id, ALICE.id]]);
  });

  it("is revalidated, or registered again, by the hourly check", async () => {
    const { x } = await watchingMentions();
    const registry = env.X_WEBHOOK_REGISTRY.getByName("deployment");
    const [webhook] = x.webhooks.values();
    webhook.valid = false;
    await runDurableObjectAlarm(registry);
    expect(x.webhooks.get(webhook.id)?.valid).toBe(true);
    expect(x.count("PUT", new RegExp(`^/2/webhooks/${webhook.id}$`))).toBe(1);

    x.webhooks.clear();
    await runDurableObjectAlarm(registry);
    expect([...x.webhooks.values()].map(registered => registered.url)).toEqual([WEBHOOK]);
  });
});
