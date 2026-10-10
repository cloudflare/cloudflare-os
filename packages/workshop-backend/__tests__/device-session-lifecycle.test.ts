import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  DeviceSessionHandoff,
  DeviceSessionTransfer,
} from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type UserInternals = UserDurableObject & {
  storage: {
    pendingDeviceHandoffs: {
      list(): Iterable<{ stateHash: string; handoff: DeviceSessionHandoff; expiresAt: Date }>;
      put(record: unknown): void;
    };
    sessions: {
      list(): Iterable<{ tokenId: string; expiresAt?: Date; pendingUntil?: Date }>;
      get(tokenId: string): { tokenId: string; expiresAt?: Date; pendingUntil?: Date } | undefined;
      put(record: unknown): void;
    };
  };
};

const state = "ABCDEFab-0000-0000-0000-000000000001";
const context = new TextEncoder().encode("cloudflare-os-device-session-v1");
let counter = 0;

async function appKey() {
  const key = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", key.publicKey) as ArrayBuffer)
      .toBase64({ alphabet: "base64url" });
  return { key, publicKey };
}

async function decrypt(
    handoff: DeviceSessionHandoff,
    keyPair: CryptoKeyPair,
    handoffState = state,
): Promise<DeviceSessionTransfer> {
  const peer = await crypto.subtle.importKey(
      "raw", Uint8Array.fromBase64(handoff.publicKey, { alphabet: "base64url" }),
      { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peer } as
        SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey },
      keyPair.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: Uint8Array.fromBase64(handoff.salt, { alphabet: "base64url" }),
    info: context,
  }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: Uint8Array.fromBase64(handoff.iv, { alphabet: "base64url" }),
    additionalData: new TextEncoder().encode(handoffState),
  }, key, Uint8Array.fromBase64(handoff.ciphertext, { alphabet: "base64url" }));
  return JSON.parse(new TextDecoder().decode(plaintext)) as DeviceSessionTransfer;
}

async function authResult(user: DurableObjectStub<UserDurableObject>, token: string) {
  return runInDurableObject(user, async (instance: UserDurableObject) => {
    try {
      await instance.authenticate(token);
      return "ok";
    } catch {
      return "invalid";
    }
  });
}

describe("device session lifecycle", () => {
  it("stages idempotently, activates once, and enforces the device-session expiry", async () => {
    const user = env.TEST_USER.getByName(`device-session-${++counter}`);
    await user.authenticateFromCfAccess("alice@example.com", true);
    const { key, publicKey } = await appKey();

    const first = await user.stageDeviceSessionHandoff(publicKey, state);
    const second = await user.stageDeviceSessionHandoff(publicKey, state);
    expect(second).toEqual(first);
    const staged = await runInDurableObject(user, (instance: UserDurableObject) => {
      const internals = instance as UserInternals;
      expect([...internals.storage.pendingDeviceHandoffs.list()]).toHaveLength(1);
      expect([...internals.storage.sessions.list()]).toHaveLength(1);
      return [...internals.storage.pendingDeviceHandoffs.list()][0].handoff;
    });
    const transfer = await decrypt(staged, key);
    expect(transfer.credential.kind).toBe("workshop");
    if (transfer.credential.kind !== "workshop") throw new Error("wrong credential kind");
    const [, token] = transfer.credential.token.split(":");
    expect(await authResult(user, token)).toBe("invalid");

    expect(await user.consumeDeviceSessionHandoff(state)).toEqual(staged);
    expect(await user.consumeDeviceSessionHandoff(state)).toBeNull();
    expect(await authResult(user, token)).toBe("ok");

    await runInDurableObject(user, (instance: UserDurableObject) => {
      const internals = instance as UserInternals;
      const [session] = [...internals.storage.sessions.list()];
      internals.storage.sessions.put({ ...session, expiresAt: new Date(Date.now() - 1) });
    });
    expect(await authResult(user, token)).toBe("invalid");
  });

  it("drops an unconsumed session when its server-side handoff expires", async () => {
    const user = env.TEST_USER.getByName(`device-session-${++counter}`);
    await user.authenticateFromCfAccess("bob@example.com", true);
    const { publicKey } = await appKey();
    await user.stageDeviceSessionHandoff(publicKey, state);
    await runInDurableObject(user, (instance: UserDurableObject) => {
      const internals = instance as UserInternals;
      const [pending] = [...internals.storage.pendingDeviceHandoffs.list()];
      internals.storage.pendingDeviceHandoffs.put({
        ...pending,
        expiresAt: new Date(Date.now() - 1),
      });
    });
    expect(await user.consumeDeviceSessionHandoff(state)).toBeNull();
    await runInDurableObject(user, (instance: UserDurableObject) => {
      const internals = instance as UserInternals;
      expect([...internals.storage.sessions.list()]).toHaveLength(0);
      expect([...internals.storage.pendingDeviceHandoffs.list()]).toHaveLength(0);
    });
  });

  it("keeps an Access JWT server-side until the single-use native callback", async () => {
    const user = env.TEST_USER.getByName(`device-session-${++counter}`);
    await user.authenticateFromCfAccess("access-user@example.com", true);
    const { key, publicKey } = await appKey();
    const start = await user.stageDeviceSessionHandoff(publicKey, state, "access.jwt.value");
    expect(start.handoffId).toMatch(/^[0-9a-f]{64}$/);

    const staged = await runInDurableObject(user, (instance: UserDurableObject) => {
      const internals = instance as UserInternals;
      expect([...internals.storage.sessions.list()]).toHaveLength(0);
      return [...internals.storage.pendingDeviceHandoffs.list()][0].handoff;
    });
    expect((await decrypt(staged, key)).credential).toEqual({
      kind: "cloudflare-access",
      token: "access.jwt.value",
    });
    expect(await user.consumeDeviceSessionHandoff(state)).toEqual(staged);
    expect(await user.consumeDeviceSessionHandoff(state)).toBeNull();
  });
});
