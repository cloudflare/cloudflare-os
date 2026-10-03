import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { NotificationDeliveryService } from
  "@gadgets/workshop-shared/notification-delivery";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

describe("UserDurableObject notifications", () => {
  it("keeps central subscription details behind the install-local delivery service", async () => {
    let registerDevice = vi.fn().mockResolvedValue(undefined);
    let deliverTaskCompleted = vi.fn().mockResolvedValue(undefined);
    let deliveryService = {
      registerDevice,
      deliverTaskCompleted,
      deliverPermissionRequested: vi.fn().mockResolvedValue(undefined),
    } as unknown as Service<NotificationDeliveryService>;
    let stub = env.TEST_USER.getByName("notification-push-fallback");

    await runInDurableObject(stub, async user => {
      let implementation = user as unknown as { env: Cloudflare.Env };
      implementation.env = { ...implementation.env, NOTIFICATION_DELIVERY: deliveryService };
      await user.registerNotificationDevice("a".repeat(64));
      await user.publishTaskCompletedNotification({
        id: "11111111-1111-4111-8111-111111111111",
        workspaceId: "workspace-1",
        chatId: 7,
        workspaceTitle: "Demo",
        chatTitle: "Build the demo",
        completedAt: new Date("2026-10-02T12:00:00.000Z"),
      });
    });

    let accountId = registerDevice.mock.calls[0]?.[0];
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(registerDevice).toHaveBeenCalledWith(accountId, "a".repeat(64));
    expect(deliverTaskCompleted).toHaveBeenCalledWith(accountId, expect.objectContaining({
      id: "11111111-1111-4111-8111-111111111111",
      chatTitle: "Build the demo",
    }));
  });
});
