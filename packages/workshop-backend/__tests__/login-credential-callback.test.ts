import { expect, it, vi } from "vitest";
import { PendingLogin } from "../src/auth/login-flow.js";

function loginWithStorage(values: Map<string, unknown>) {
  const login = Object.create(PendingLogin.prototype) as PendingLogin;
  Object.assign(login, {
    ctx: {
      storage: {
        kv: {
          get: (key: string) => values.get(key),
          put: (key: string, value: unknown) => values.set(key, value),
        },
      },
    },
  });
  return login;
}

it("forwards persisted login-grant lifecycle updates after the login instance is replaced", async () => {
  const values = new Map<string, unknown>();
  const callback = { credentialsExpired: vi.fn(), credentialsRestored: vi.fn() };
  await loginWithStorage(values).setAccountCallback(
    callback as unknown as Parameters<PendingLogin["setAccountCallback"]>[0],
  );
  const restored = loginWithStorage(values);
  const expiry = new Date("2030-01-01");
  await restored.credentialsRestored(expiry);
  await restored.credentialsExpired();
  expect(callback.credentialsRestored).toHaveBeenCalledWith(expiry);
  expect(callback.credentialsExpired).toHaveBeenCalledOnce();
});

it("does not persist or forward lifecycle updates for transient login grants", async () => {
  const values = new Map<string, unknown>();
  const login = loginWithStorage(values);
  await login.credentialsRestored();
  await login.credentialsExpired();
  expect(values.size).toBe(0);
});
