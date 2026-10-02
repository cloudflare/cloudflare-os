import { describe, expect, it, vi } from "vitest";
import {
  permissionRequestedRequest,
  registerDevice,
  sendPermissionRequested,
  sendTaskCompleted,
  taskCompletedRequest,
} from "./delegate.js";

const delivery = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: "abc123",
  chatId: 7,
  workspaceTitle: "Demo workspace",
  chatTitle: "Build the demo",
  completedAt: new Date("2026-09-29T20:00:00.000Z"),
};

const signingIdentity = async () => {
  let pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  ) as CryptoKeyPair;
  return {
    installId: `${"a".repeat(32)}:router`,
    keyId: "11111111-1111-4111-8111-111111111111",
    privateKey: btoa(String.fromCharCode(...new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer,
    ))),
  };
};

describe("notification service delegate", () => {
  it("serializes the typed task-completion contract", () => {
    expect(taskCompletedRequest(delivery, "a".repeat(64))).toEqual({
      type: "task_completed",
      eventId: delivery.id,
      taskId: "abc123:7",
      threadTitle: "Build the demo",
      path: "/workspace/abc123?chat=7",
      subscriptionId: "a".repeat(64),
    });
  });

  it("bounds the user-controlled title sent to the central renderer", () => {
    expect(taskCompletedRequest({
      ...delivery,
      chatTitle: `  Build\n\tthe demo ${"🚂".repeat(100)}  `,
    }, "a".repeat(64)).threadTitle).toBe(`Build the demo ${"🚂".repeat(81)}`);
    expect(taskCompletedRequest({
      ...delivery,
      chatTitle: " \n\t ",
    }, "a".repeat(64)).threadTitle).toBe("Task");
  });

  it("serializes permission prompts without permission contents", () => {
    let { completedAt, ...task } = delivery;
    expect(permissionRequestedRequest({
      ...task, requestedAt: completedAt,
    }, "a".repeat(64))).toEqual({
      type: "permission_requested",
      eventId: delivery.id,
      taskId: "abc123:7",
      threadTitle: "Build the demo",
      path: "/workspace/abc123?chat=7",
      subscriptionId: "a".repeat(64),
    });
  });

  it.each(["task_completed", "permission_requested"] as const)(
    "signs the complete %s request with the install identity", async type => {
      let identity = await signingIdentity();
      let fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
      if (type === "task_completed") {
        await sendTaskCompleted(
          "https://notifications.example.test", identity, "b".repeat(64), delivery, fetcher,
        );
      } else {
        let { completedAt, ...task } = delivery;
        await sendPermissionRequested(
          "https://notifications.example.test", identity, "b".repeat(64),
          { ...task, requestedAt: completedAt }, fetcher,
        );
      }

      let [url, init] = fetcher.mock.calls[0];
      let headers = new Headers(init?.headers);
      expect(String(url)).toBe("https://notifications.example.test/v1/deliveries");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-cfos-install-id")).toBe(identity.installId);
      expect(headers.get("x-cfos-key-id")).toBe(identity.keyId);
      expect(headers.get("x-cfos-signature")).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(JSON.parse(String(init?.body)).type).toBe(type);
    },
  );

  it("registers a one-time native device capability through the install identity", async () => {
    let identity = await signingIdentity();
    let fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { subscriptionId: "c".repeat(64) }, { status: 201 },
    ));
    await expect(registerDevice(
      "https://notifications.example.test", identity, "b".repeat(64), fetcher,
    )).resolves.toBe("c".repeat(64));

    let [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://notifications.example.test/v1/subscriptions");
    expect(JSON.parse(String(init?.body))).toEqual({ deviceRegistrationId: "b".repeat(64) });
  });

  it("rejects non-HTTPS service configuration before fetching", async () => {
    let fetcher = vi.fn<typeof fetch>();
    await expect(sendTaskCompleted("http://notifications.example.test", {
      installId: "install", keyId: "key", privateKey: "key",
    }, "a".repeat(64), delivery, fetcher)).rejects.toThrow("HTTPS origin");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
