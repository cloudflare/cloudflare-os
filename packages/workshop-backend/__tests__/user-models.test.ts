import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { serializeAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import type { UserAiModelRecord } from "../src/storage-schema/user-storage.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const PROFILE = { type: "agent" as const, id: "my-model", name: "My Model" };
const CONFIG: AiModelConfig = {
  provider: "openai",
  model: "my-model",
  apiToken: "sk-secret",
  apiUrl: "https://proxy.example/v1",
  extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-Empty": "" },
};

type ModelMethods = Pick<UserDurableObject, "addModel" | "getModelConfig" | "updateModel">;

let userCounter = 0;
async function userWithModel() {
  const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
  // Calls go through runInDurableObject rather than the stub's RPC, whose rejections workerd
  // reports as uncaught exceptions even once the test has handled them.
  const inDo = <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
  const user: ModelMethods = {
    addModel: (...args) => inDo(u => u.addModel(...args)),
    getModelConfig: (...args) => inDo(u => u.getModelConfig(...args)),
    updateModel: (...args) => inDo(u => u.updateModel(...args)),
  };
  const stored = (id: string) => inDo(async u =>
      (u as unknown as { storage: { aiModels: { get(id: string): unknown } } }).storage.aiModels.get(id));
  await user.addModel(PROFILE, CONFIG);
  return { user, stored, inDo };
}

describe("UserDurableObject model editing", () => {
  it("replaces secrets that are supplied, and drops headers that are omitted", async () => {
    const { user, stored } = await userWithModel();
    await user.updateModel(PROFILE, {
      ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": null, "X-New": "v" },
    });
    expect(await stored(PROFILE.id)).toEqual({
      profile: PROFILE,
      config: { ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-New": "v" } },
    });
  });

  it("refuses to keep a secret for a header that isn't stored", async () => {
    const { user } = await userWithModel();
    await expect(user.updateModel(PROFILE, { ...CONFIG, extraHeaders: { "x-proxy-key": null } }))
        .rejects.toThrow("no stored");
  });

  it("refuses to keep secrets when the API URL changes", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: "https://attacker.example" }))
        .rejects.toThrow("re-enter");
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: undefined }))
        .rejects.toThrow("re-enter");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });

    // Supplying every secret afresh is fine.
    const moved = { ...CONFIG, apiUrl: "https://other.example", apiToken: "sk-2", extraHeaders: {} };
    await user.updateModel(PROFILE, moved);
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: moved });
  });

  it("refuses to change the provider or model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, model: "other" })).rejects.toThrow("can't be changed");
    await expect(user.updateModel(PROFILE, { ...CONFIG, provider: "anthropic" })).rejects.toThrow("can't be changed");
  });

  it("refuses to edit a model that doesn't exist", async () => {
    const { user } = await userWithModel();
    await expect(user.getModelConfig("nope")).rejects.toThrow("No such");
    await expect(user.updateModel({ ...PROFILE, id: "nope" }, CONFIG)).rejects.toThrow("No such");
  });

  it("copies withheld secrets when cloning to the same endpoint", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await user.addModel(clone, { ...config, model: "clone" }, PROFILE.id);
    expect(await stored("clone")).toEqual({ profile: clone, config: { ...CONFIG, model: "clone" } });
  });

  it("refuses to clone secrets to another endpoint or over an existing model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...config, provider: "anthropic" }, PROFILE.id))
        .rejects.toThrow("re-enter");
    await expect(user.addModel(PROFILE, config, PROFILE.id)).rejects.toThrow("already exists");
    await expect(user.addModel(clone, config, "nope")).rejects.toThrow("No such");
  });

  it("refuses to add over an existing model", async () => {
    const { user, stored } = await userWithModel();
    await expect(user.addModel({ ...PROFILE, name: "Other" }, { ...CONFIG, apiToken: "sk-other" }))
        .rejects.toThrow("already exists");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });
  });

  it("requires every secret when adding without a source", async () => {
    const { user } = await userWithModel();
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...CONFIG, apiToken: null })).rejects.toThrow("required");
  });

  // Only AI Gateway mode consults the admin config for models. This pool binds no BLUEPRINTS
  // namespace, so a read of it here would throw.
  it("lists and resolves models without the admin config outside AI Gateway mode", async () => {
    const { inDo } = await userWithModel();
    await inDo(async user => {
      expect(await user.listModels()).toEqual([PROFILE]);
      await user.setPreferredModel(PROFILE.id);
      expect((await user.getChatContext(PROFILE.id)).aiModel?.config).toEqual(CONFIG);
      expect((await user.getExternalMessageChatContext(null)).aiModel?.profile).toEqual(PROFILE);
      await user.deleteModel(PROFILE.id);
      expect(await user.listModels()).toEqual([]);
    });
  });
});

const listedIds = async (user: UserDurableObject) =>
    (await user.listModels()).map(model => model.id);

describe("UserDurableObject gateway model modes", () => {
  const ENABLED_ID = "claude-opus-5-5";
  const HIDDEN_ID = "claude-opus-5";
  const DISABLED_MESSAGE =
      'The "Claude Opus 5.5" model is disabled on this deployment by an administrator.';
  const DISABLED: Partial<AdminConfig> = { modelModes: { [ENABLED_ID]: "disabled" } };

  // Every call runs in one invocation, since the gateway env is only overridden on this instance.
  // `config` is the deployment's admin config, which gateway models are read through.
  function inGatewayUser<T>(f: (user: UserDurableObject) => Promise<T>,
                            config: Partial<AdminConfig> = {}) {
    const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
    return runInDurableObject(stub, async user => {
      const impl = user as unknown as { env: Cloudflare.Env };
      const original = impl.env;
      impl.env = {
        ...original,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
        CF_AI_GATEWAY_API_TOKEN: "gateway-token",
        CF_AI_GATEWAY_PROVIDERS: "anthropic",
        BLUEPRINTS: {
          get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...config }),
        } as unknown as KVNamespace,
      };
      try {
        return await f(user);
      } finally {
        impl.env = original;
      }
    });
  }

  // A model stored under a gateway model's ID, as one added before the deployment provided that
  // model would be.
  function storeModel(user: UserDurableObject, id: string) {
    const record: UserAiModelRecord = {
      profile: { ...PROFILE, id, name: "Stale" },
      config: { ...CONFIG, provider: "anthropic", model: id },
    };
    (user as unknown as { storage: { aiModels: { put(record: UserAiModelRecord): void } } })
        .storage.aiModels.put(record);
  }

  it("refuses to add a model that a hidden gateway model would shadow", () => inGatewayUser(async user => {
    await expect(user.addModel({ ...PROFILE, id: HIDDEN_ID }, { ...CONFIG, model: HIDDEN_ID }))
        .rejects.toThrow("already exists");
  }));

  it("keeps an existing chat on a hidden model", () => inGatewayUser(async user => {
    const context = await user.getExternalMessageChatContext(HIDDEN_ID);
    expect(context.aiModel?.profile.id).toBe(HIDDEN_ID);
  }));

  it("starts a new conversation on the first offered model when the preference is hidden",
      () => inGatewayUser(async user => {
    await user.setPreferredModel(HIDDEN_ID);
    const [first] = await user.listModels();
    expect(first.id).not.toBe(HIDDEN_ID);
    const context = await user.getExternalMessageChatContext(null);
    expect(context.aiModel?.profile.id).toBe(first.id);
  }));

  it("stops listing a model the admin hid, which still resolves", () => inGatewayUser(async user => {
    expect(await listedIds(user)).not.toContain(ENABLED_ID);
    expect((await user.getChatContext(ENABLED_ID)).aiModel?.profile.id).toBe(ENABLED_ID);
    await user.setPreferredModel(ENABLED_ID);
    expect(await user.getPreferredModel()).toBe(ENABLED_ID);
  }, { modelModes: { [ENABLED_ID]: "hidden" } }));

  it("lists a superseded model the admin enabled", () => inGatewayUser(async user => {
    expect(await listedIds(user)).toContain(HIDDEN_ID);
    await user.setPreferredModel(HIDDEN_ID);
    const context = await user.getExternalMessageChatContext(null);
    expect(context.aiModel?.profile.id).toBe(HIDDEN_ID);
  }, { modelModes: { [HIDDEN_ID]: "enabled" } }));

  it("refuses a disabled model with the administrator's message", () => inGatewayUser(async user => {
    expect(await listedIds(user)).not.toContain(ENABLED_ID);
    await expect(user.getChatContext(ENABLED_ID)).rejects.toThrow(new Error(DISABLED_MESSAGE));
    await expect(user.setPreferredModel(ENABLED_ID)).rejects.toThrow(`No such model: ${ENABLED_ID}`);
    expect(await user.getPreferredModel()).toBeNull();
    await expect(user.addModel({ ...PROFILE, id: ENABLED_ID }, { ...CONFIG, model: ENABLED_ID }))
        .rejects.toThrow("already exists");
    // A model that is merely unknown is still reported as such.
    await expect(user.getChatContext("nope")).rejects.toThrow(new Error("No such model: nope"));
  }, DISABLED));

  // The ID stays reserved, or the stored model would take the disabled one's place in every
  // chat, spawner and preference that names it.
  it("keeps a stored model sharing a disabled model's ID out of reach", () => inGatewayUser(async user => {
    storeModel(user, ENABLED_ID);
    expect(await listedIds(user)).not.toContain(ENABLED_ID);
    await expect(user.getChatContext(ENABLED_ID)).rejects.toThrow(new Error(DISABLED_MESSAGE));
    await expect(user.setPreferredModel(ENABLED_ID)).rejects.toThrow("No such model");
    await expect(user.getModelConfig(ENABLED_ID)).rejects.toThrow("No such hand-added model");
    await expect(user.updateModel({ ...PROFILE, id: ENABLED_ID },
        { ...CONFIG, provider: "anthropic", model: ENABLED_ID }))
        .rejects.toThrow("No such hand-added model");
    await expect(user.addModel({ ...PROFILE, id: "clone" }, { ...CONFIG, apiToken: null }, ENABLED_ID))
        .rejects.toThrow("No such hand-added model");
  }, DISABLED));

  it("refuses to delete a gateway model in any mode, naming it", () => inGatewayUser(async user => {
    storeModel(user, "claude-test");
    await expect(user.deleteModel("claude-test"))
        .rejects.toThrow(new Error('Cannot delete built-in model "Claude Test".'));
    await expect(user.deleteModel(ENABLED_ID))
        .rejects.toThrow(new Error('Cannot delete built-in model "Claude Opus 5.5".'));
    const stored = (user as unknown as { storage: { aiModels: { get(id: string): unknown } } })
        .storage.aiModels.get("claude-test");
    expect(stored).toMatchObject({ profile: { name: "Stale" } });
  }, {
    addedModels: [
      { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 500000 },
    ],
    modelModes: { [ENABLED_ID]: "disabled", "claude-test": "hidden" },
  }));

  it("moves an existing chat off a disabled model", () => inGatewayUser(async user => {
    const [first] = await user.listModels();
    expect(first.id).not.toBe(ENABLED_ID);
    expect((await user.getExternalMessageChatContext(ENABLED_ID)).aiModel?.profile.id)
        .toBe(first.id);

    await user.setPreferredModel("claude-haiku-4-5");
    expect((await user.getExternalMessageChatContext(ENABLED_ID)).aiModel?.profile.id)
        .toBe("claude-haiku-4-5");
  }, DISABLED));
});
