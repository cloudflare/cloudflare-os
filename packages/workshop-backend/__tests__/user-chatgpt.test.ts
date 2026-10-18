import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { serializeAdminConfig } from "../src/admin-config.js";
import { CHATGPT_REDIRECT_URI, type ChatGptCredential } from "../src/chatgpt-oauth.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import type { UserStorage } from "../src/storage-schema/user-storage.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PROFILE = { type: "agent" as const, id: "chatgpt/gpt-5.5", name: "GPT-5.5 (ChatGPT)" };
const CHATGPT: AiModelConfig = {
  provider: "openai", model: "gpt-5.5", apiToken: "", credential: "chatgpt",
};
const SIGNED_IN: ChatGptCredential = {
  accessToken: "stored-access", refreshToken: "stored-refresh",
  expiresAt: new Date(Date.now() + 3600_000), clientId: "issued", email: "me@example.com",
};

function jwt(claims: object): string {
  let encode = (value: object) => new TextEncoder().encode(JSON.stringify(value))
      .toBase64({alphabet: "base64url", omitPadding: true});
  return `${encode({alg: "none"})}.${encode(claims)}.signature`;
}

type Deployment = { admin?: Partial<AdminConfig>; gateway?: boolean };

let userCounter = 0;

// Runs `f` in a fresh user's object, on a deployment whose admin config (and AI Gateway mode) is
// `deployment`, which only this invocation sees.
function inUser<T>(f: (user: UserDurableObject, storage: UserStorage) => Promise<T>,
                   deployment: Deployment = {}) {
  const stub = env.TEST_USER.getByName(`user-chatgpt-${++userCounter}`);
  return runInDurableObject(stub, async user => {
    const impl = user as unknown as { env: Cloudflare.Env; storage: UserStorage };
    const original = impl.env;
    impl.env = {
      ...original,
      ...(deployment.gateway && {
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
        CF_AI_GATEWAY_API_TOKEN: "gateway-token",
        CF_AI_GATEWAY_PROVIDERS: "anthropic",
      }),
      BLUEPRINTS: {
        get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...deployment.admin }),
      } as unknown as KVNamespace,
    };
    try {
      return await f(user, impl.storage);
    } finally {
      impl.env = original;
    }
  });
}

// Stands in for OpenAI's token endpoint. Each request takes the next answer.
function tokenEndpoint(...answers: (object | Promise<object>)[]) {
  const requests: URLSearchParams[] = [];
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new URLSearchParams(init!.body as URLSearchParams));
    const answer = await answers.shift()!;
    return "error" in answer
        ? Response.json(answer, { status: 400 }) : Response.json(answer);
  });
  vi.stubGlobal("fetch", fetchFn);
  return { fetchFn, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Starts a sign-in and returns the address OpenAI would send the browser to, and the nonce the
// ID token must carry.
async function begin(user: UserDurableObject) {
  const start = await user.beginChatGptSignIn();
  expect(start.redirectUri).toBe(CHATGPT_REDIRECT_URI);
  const params = new URL(start.authorizeUrl).searchParams;
  const callback = new URL(CHATGPT_REDIRECT_URI);
  callback.search = new URLSearchParams(
      { code: "the-code", state: params.get("state")!, client_id: "issued" }).toString();
  return { callbackUrl: callback.toString(), nonce: params.get("nonce")! };
}

const tokens = (nonce: string, overrides: object = {}) => ({
  access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: SCOPE,
  id_token: jwt({ nonce, email: "me@example.com" }), ...overrides,
});

describe("Sign in with ChatGPT", () => {
  it("signs in from the pasted address, and reports no secrets", () => inUser(async user => {
    expect(await user.getChatGptSignIn()).toEqual({ state: "signedOut" });
    const { callbackUrl, nonce } = await begin(user);
    tokenEndpoint(tokens(nonce));
    const status = await user.completeChatGptSignIn(callbackUrl);
    expect(status).toEqual({ state: "signedIn", email: "me@example.com" });
    expect(await user.getChatGptSignIn()).toEqual(status);
    expect(JSON.stringify(status)).not.toMatch(/access|refresh|issued/);
    expect((await user.getChatGptAccessToken()).token).toBe("new-access");
  }));

  it("completes a sign-in once", () => inUser(async user => {
    const { callbackUrl, nonce } = await begin(user);
    tokenEndpoint(tokens(nonce));
    await user.completeChatGptSignIn(callbackUrl);
    await expect(user.completeChatGptSignIn(callbackUrl)).rejects.toThrow("expired");
  }));

  it("keeps the pending sign-in when given another sign-in's address", () => inUser(async user => {
    const first = await begin(user);
    const second = await begin(user);
    await expect(user.completeChatGptSignIn(first.callbackUrl)).rejects.toThrow("different sign-in");
    tokenEndpoint(tokens(second.nonce));
    expect((await user.completeChatGptSignIn(second.callbackUrl)).state).toBe("signedIn");
  }));

  it("refuses a sign-in that has expired", () => inUser(async (user, storage) => {
    const { callbackUrl } = await begin(user);
    storage.pendingChatGptSignIn.put(
        { ...storage.pendingChatGptSignIn.get()!, expiresAt: new Date(Date.now() - 1) });
    await expect(user.completeChatGptSignIn(callbackUrl)).rejects.toThrow("expired");
  }));

  it("keeps one agent host ID per user", () => inUser(async user => {
    const host = async () => new URL((await user.beginChatGptSignIn()).authorizeUrl)
        .searchParams.get("ext_agent_host_id");
    const first = await host();
    expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(await host()).toBe(first);
  }));

  it("signs out", () => inUser(async (user, storage) => {
    storage.chatGptCredential.put(SIGNED_IN);
    await user.signOutChatGpt();
    expect(await user.getChatGptSignIn()).toEqual({ state: "signedOut" });
    await expect(user.getChatGptAccessToken()).rejects.toThrow("Sign in with ChatGPT");
  }));

  describe("while unavailable", () => {
    it.each([
      ["turned off", { admin: { chatGptSignInEnabled: false } }],
      ["users may not add models on an AI Gateway deployment",
        { gateway: true, admin: { userModelsEnabled: false } }],
    ] as const)("refuses everything when %s", (_, deployment) => inUser(async (user, storage) => {
      storage.chatGptCredential.put(SIGNED_IN);
      expect(await user.getChatGptSignIn()).toEqual({ state: "unavailable" });
      await expect(user.beginChatGptSignIn()).rejects.toThrow();
      await expect(user.completeChatGptSignIn(CHATGPT_REDIRECT_URI)).rejects.toThrow();
      await expect(user.getChatGptAccessToken()).rejects.toThrow();
      await expect(user.addModel(PROFILE, CHATGPT)).rejects.toThrow();
    }, deployment));

    it("refuses on a deployment whose admin turned it off, whatever the gateway", () =>
        inUser(async user => {
      await expect(user.addModel(PROFILE, CHATGPT)).rejects.toThrow("turned off");
    }, { gateway: true, admin: { chatGptSignInEnabled: false } }));
  });

  describe("access tokens", () => {
    const expired = { ...SIGNED_IN, expiresAt: new Date(Date.now() - 1) };

    it("hands out the stored token while it is fresh", () => inUser(async (user, storage) => {
      storage.chatGptCredential.put(SIGNED_IN);
      const { fetchFn } = tokenEndpoint();
      expect(await user.getChatGptAccessToken())
          .toEqual({ token: "stored-access", expiresAt: SIGNED_IN.expiresAt });
      expect(fetchFn).not.toHaveBeenCalled();
    }));

    it("refreshes a token that is due, once for concurrent requests", () => inUser(async (user, storage) => {
      storage.chatGptCredential.put(expired);
      const { fetchFn, requests } = tokenEndpoint(
          { access_token: "refreshed", refresh_token: "rotated", expires_in: 3600, scope: SCOPE });
      const results = await Promise.all([user.getChatGptAccessToken(), user.getChatGptAccessToken()]);
      expect(results.map(result => result.token)).toEqual(["refreshed", "refreshed"]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(requests[0].get("refresh_token")).toBe("stored-refresh");
      expect(storage.chatGptCredential.get()).toMatchObject(
          { accessToken: "refreshed", refreshToken: "rotated", email: "me@example.com" });
    }));

    it("forgets a sign-in that OpenAI revoked", () => inUser(async (user, storage) => {
      storage.chatGptCredential.put(expired);
      tokenEndpoint({ error: "invalid_grant" });
      await expect(user.getChatGptAccessToken()).rejects.toThrow("Sign in with ChatGPT again");
      expect(await user.getChatGptSignIn()).toEqual({ state: "signedOut" });
    }));

    it("keeps a sign-in made while a refresh was in flight", () => inUser(async (user, storage) => {
      storage.chatGptCredential.put(expired);
      let answer!: (body: object) => void;
      const { fetchFn } = tokenEndpoint(new Promise<object>(resolve => answer = resolve));
      const token = user.getChatGptAccessToken();
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
      const fresh = { ...SIGNED_IN, refreshToken: "from-new-sign-in" };
      storage.chatGptCredential.put(fresh);
      answer({ access_token: "late", refresh_token: "late-refresh", expires_in: 3600, scope: SCOPE });
      await token;
      expect(storage.chatGptCredential.get()).toEqual(fresh);
    }));

    it("keeps a sign-in made while a refresh that was revoked was in flight", () =>
        inUser(async (user, storage) => {
      storage.chatGptCredential.put(expired);
      let answer!: (body: object) => void;
      const { fetchFn } = tokenEndpoint(new Promise<object>(resolve => answer = resolve));
      const token = user.getChatGptAccessToken();
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
      const fresh = { ...SIGNED_IN, refreshToken: "from-new-sign-in" };
      storage.chatGptCredential.put(fresh);
      answer({ error: "invalid_grant" });
      await expect(token).rejects.toThrow("again");
      expect(storage.chatGptCredential.get()).toEqual(fresh);
    }));
  });
});

describe("ChatGPT subscription models", () => {
  it("are stored with no secrets, and shown so", () => inUser(async (user, storage) => {
    await user.addModel(PROFILE, CHATGPT);
    expect(storage.aiModels.get(PROFILE.id)).toEqual(
        { profile: PROFILE, config: CHATGPT });
    expect(await user.getModelConfig(PROFILE.id)).toEqual({ profile: PROFILE, config: CHATGPT });
  }));

  it.each([
    ["another provider", { provider: "anthropic" }, "Only OpenAI"],
    ["an API token", { apiToken: "sk-secret" }, "takes no API token"],
    ["an API URL", { apiUrl: "https://proxy.example/v1" }, "takes no API token"],
    ["extra headers", { extraHeaders: { "X-Key": "v" } }, "takes no API token"],
  ] as const)("refuse %s", (_, change, message) => inUser(async user => {
    await expect(user.addModel(PROFILE, { ...CHATGPT, ...change })).rejects.toThrow(message);
  }));

  it("run on a gateway deployment whose gateway doesn't serve OpenAI", () => inUser(async user => {
    await user.addModel(PROFILE, CHATGPT);
    expect((await user.getChatContext(PROFILE.id)).aiModel?.config).toEqual(CHATGPT);
  }, { gateway: true }));

  it("can't switch to or from an API key", () => inUser(async user => {
    await user.addModel(PROFILE, CHATGPT);
    const { credential, ...withKey } = CHATGPT;
    await expect(user.updateModel(PROFILE, { ...withKey, apiToken: "sk-key" }))
        .rejects.toThrow("can't be changed");
    const keyed = { ...PROFILE, id: "keyed" };
    await user.addModel(keyed, { ...withKey, apiToken: "sk-key" });
    await expect(user.updateModel(keyed, { ...CHATGPT })).rejects.toThrow("can't be changed");
  }));

  // The quick model also titles chats in workspaces other people own.
  it("can't be the quick model", () => inUser(async (user, storage) => {
    await user.addModel(PROFILE, CHATGPT);
    await expect(user.setQuickModel(PROFILE.id)).rejects.toThrow("quick model");
    // One stored as the quick model before it was refused is never used as one.
    storage.quickModel.put(PROFILE.id);
    expect(await user.getQuickModel()).toBeNull();
    expect((await user.getChatContext(null)).quickModel).toBeUndefined();
  }));
});
