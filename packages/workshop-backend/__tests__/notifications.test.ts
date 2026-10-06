import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationSubscriber, UserNotification } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const NOTIFICATION: UserNotification = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "taskCompleted",
  workspaceId: "workspace-1",
  chatId: 7,
  chatTitle: "Build the demo",
};

// RPC exposes prototype methods only, as the browser's NotificationSubscriberImpl defines them.
class Subscriber extends RpcTarget {
  constructor(private readonly answer: () => Promise<void>) {
    super();
  }

  notify(): Promise<void> {
    return this.answer();
  }
}

// Registers a phone, then publishes NOTIFICATION while `notify` is the only open tab's answer
// (none when undefined), and returns what was pushed to the phone.
async function publish(notify?: () => Promise<void>): Promise<unknown[][]> {
  let deliver = vi.fn(async () => {});
  let stub = env.TEST_USER.getByName(`notifications-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async user => {
    let implementation = user as unknown as { env: Cloudflare.Env };
    implementation.env = {
      ...implementation.env,
      NOTIFICATION_DELIVERY: {
        registerDevice: async () => "subscription-1",
        deliver,
      } as unknown as Cloudflare.Env["NOTIFICATION_DELIVERY"],
    };
    await user.registerNotificationDevice("registration-1");
    if (notify) {
      await user.subscribeToNotifications(
          new RpcStub(new Subscriber(notify)) as unknown as RpcStub<NotificationSubscriber>);
    }
    let published = user.publishNotification(NOTIFICATION);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(3_000);
    await published;
  });
  return deliver.mock.calls;
}

describe("UserDurableObject notifications", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves a notification an open tab shows to that tab", async () => {
    expect(await publish(async () => {})).toEqual([]);
  });

  it.each([
    ["no tab is open", undefined],
    ["the tab fails to show it", () => Promise.reject(new Error("hidden"))],
  ])("pushes to the registered phone when %s", async (_, notify) => {
    expect(await publish(notify)).toEqual([["subscription-1", NOTIFICATION]]);
  });

  it("pushes to the registered phone when the tab does not answer within 3s", async () => {
    vi.useFakeTimers();
    expect(await publish(() => new Promise<void>(() => {})))
        .toEqual([["subscription-1", NOTIFICATION]]);
  });
});
