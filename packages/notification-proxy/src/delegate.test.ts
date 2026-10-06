import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserNotification } from "@gadgets/workshop-shared/api";
import { deliver, registerDevice } from "./delegate.js";

const encoder = new TextEncoder();

const notification: UserNotification = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "taskCompleted",
  workspaceId: "abc123",
  chatId: 7,
  chatTitle: "Build the demo",
};

const base64urlBytes = (value: string) => Uint8Array.from(
  atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0),
);

const install = async () => {
  let { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  ) as CryptoKeyPair;
  let pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer);
  return {
    publicKey,
    env: {
      NOTIFICATION_SERVICE_URL: "https://notifications.example.test",
      CFOS_INSTALL_ID: "install-1",
      CFOS_INSTALL_KEY_ID: "11111111-1111-4111-8111-111111111111",
      CFOS_INSTALL_PRIVATE_KEY: btoa(String.fromCharCode(...pkcs8)),
    },
  };
};

const stubService = (response: Response) => {
  let fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

describe("notification service delegate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["taskCompleted", "task_completed"],
    ["permissionRequested", "permission_requested"],
  ] as const)("signs a %s delivery the central verifier accepts", async (kind, type) => {
    let { env, publicKey } = await install();
    let fetcher = stubService(new Response(null, { status: 202 }));
    await deliver(env, "b".repeat(64), { ...notification, kind });

    let [url, init] = fetcher.mock.calls[0];
    let headers = new Headers(init?.headers);
    let body = String(init?.body);
    expect(String(url)).toBe("https://notifications.example.test/v1/deliveries");
    expect(JSON.parse(body)).toEqual({
      type,
      eventId: notification.id,
      taskId: "abc123:7",
      threadTitle: "Build the demo",
      path: "/workspace/abc123?chat=7",
      subscriptionId: "b".repeat(64),
    });
    expect(headers.get("x-cfos-install-id")).toBe(env.CFOS_INSTALL_ID);
    expect(headers.get("x-cfos-key-id")).toBe(env.CFOS_INSTALL_KEY_ID);
    expect(base64urlBytes(headers.get("x-cfos-content-digest")!))
      .toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))));
    // The canonical request the central service verifies.
    let canonical = [
      "CFOS1", "POST", "/v1/deliveries",
      ...["install-id", "key-id", "timestamp", "nonce", "content-digest"]
        .map(name => headers.get(`x-cfos-${name}`)),
    ].join("\n");
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey,
      base64urlBytes(headers.get("x-cfos-signature")!), encoder.encode(canonical),
    )).toBe(true);
  });

  it.each([
    ["  Build\n\tthe demo  ", "Build the demo"],
    [`${"a".repeat(95)} tail`, "a".repeat(95)],
    ["🚂".repeat(60), "🚂".repeat(48)],
    [" \n ", undefined],
  ])("fits the title %j to the central template's 96 trimmed UTF-16 units", async (
    chatTitle, threadTitle,
  ) => {
    let fetcher = stubService(new Response(null, { status: 202 }));
    await deliver((await install()).env, "b".repeat(64), { ...notification, chatTitle });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).threadTitle).toBe(threadTitle);
  });

  it("exchanges a device registration for its subscription id", async () => {
    let fetcher = stubService(Response.json({ subscriptionId: "c".repeat(64) }, { status: 201 }));
    await expect(registerDevice((await install()).env, "d".repeat(64)))
      .resolves.toBe("c".repeat(64));

    let [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://notifications.example.test/v1/subscriptions");
    expect(JSON.parse(String(init?.body))).toEqual({ deviceRegistrationId: "d".repeat(64) });
  });
});
