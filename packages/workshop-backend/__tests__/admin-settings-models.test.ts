import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { SUGGESTED_MODELS, type GatewayModel } from "@gadgets/workshop-shared/api";
import { parseAdminConfig } from "../src/admin-config.js";
import type { AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import { AdminSettings } from "../src/admin-settings.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const GATEWAY = {
  CF_AI_GATEWAY: "platform-gateway",
  CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
  CF_AI_GATEWAY_API_TOKEN: "gateway-token",
  CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
};
const NOT_GATEWAY = "This deployment does not provide models through AI Gateway.";
const ADDED: GatewayModel =
    { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 500000 };

let counter = 0;

/**
 * An AdminSettings over fresh storage, with `vars` as its environment. The pool binds no
 * AdminSettings namespace, so it is constructed on the state of an unrelated Durable Object: all
 * it needs from one is storage of its own. Its KV mirror is `mirror`, written through `put`.
 */
function adminSettings(vars: object = GATEWAY) {
  const stub = env.TEST_USER_DIRECTORY.getByName(`admin-settings-models-${++counter}`);
  const mirror = { current: null as string | null, fail: false };
  const put = vi.fn(async (_key: string, value: string) => {
    if (mirror.fail) throw new Error("KV unavailable");
    mirror.current = value;
  });
  const settingsEnv = { ...vars, BLUEPRINTS: { put, get: async () => null } };
  // Calls run inside the Durable Object, where its storage is reachable.
  const inDo = <T>(f: (admin: AdminSettings) => T | Promise<T>) => runInDurableObject(
      stub, (_host, state) => f(new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env)));
  const stored = (): Promise<Pick<AdminConfig, "modelModes" | "addedModels">> =>
      inDo(admin => {
        let { modelModes, addedModels } = admin.getAdminConfig();
        return { modelModes, addedModels };
      });
  const settings = (): Promise<AdminConfig["modelSettings"]> =>
      inDo(admin => admin.getAdminConfig().modelSettings);
  return { inDo, stored, settings, put, mirror };
}

describe("AdminSettings gateway model modes", () => {
  it("stores an override, and mirrors it to KV", async () => {
    const { inDo, stored, put, mirror } = adminSettings();
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "disabled"));
    expect(await stored()).toEqual(
        { modelModes: { "claude-fable-5-1": "disabled" }, addedModels: [] });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(".adminConfig");
    expect(parseAdminConfig(mirror.current).modelModes).toEqual({ "claude-fable-5-1": "disabled" });
  });

  it("forgets the override when a model is set to its default mode", async () => {
    const { inDo, stored } = adminSettings();
    // Enabled by default.
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "hidden"));
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "enabled"));
    expect((await stored()).modelModes).toEqual({});

    // Hidden by default: enabling it is the override, and hiding it again is not one.
    await inDo(admin => admin.setGatewayModelMode("claude-opus-5", "enabled"));
    expect((await stored()).modelModes).toEqual({ "claude-opus-5": "enabled" });
    await inDo(admin => admin.setGatewayModelMode("claude-opus-5", "hidden"));
    expect((await stored()).modelModes).toEqual({});
  });

  it("refuses an ID that is not a gateway model, leaving storage and the mirror alone", async () => {
    const { inDo, stored, put } = adminSettings();
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "hidden"));
    put.mockClear();

    // The second is a suggested model of a provider this gateway does not enable.
    for (let id of ["claude-fable-9", "gpt-6-luna", "constructor"]) {
      await expect(inDo(admin => admin.setGatewayModelMode(id, "disabled")))
          .rejects.toThrow(`No such model: ${id}`);
    }
    expect((await stored()).modelModes).toEqual({ "claude-fable-5-1": "hidden" });
    expect(put).not.toHaveBeenCalled();
  });

  it("gives a model whose ID is __proto__ a mode of its own", async () => {
    const { inDo, stored, mirror } = adminSettings();
    await inDo(admin => admin.addGatewayModel({ ...ADDED, id: "__proto__" }));
    await inDo(admin => admin.setGatewayModelMode("__proto__", "disabled"));

    const { modelModes } = await stored();
    expect(Object.entries(modelModes)).toEqual([["__proto__", "disabled"]]);
    expect(Object.entries(parseAdminConfig(mirror.current).modelModes))
        .toEqual([["__proto__", "disabled"]]);
    const view = await inDo(admin => admin.getSettings("admin"));
    expect(view.gatewayModels!.models.find(model => model.id === "__proto__")?.mode)
        .toBe("disabled");

    await inDo(admin => admin.setGatewayModelMode("__proto__", "enabled"));
    expect(Object.entries((await stored()).modelModes)).toEqual([]);
  });
});

describe("AdminSettings added gateway models", () => {
  it("stores a well-formed model from its own fields, trimmed", async () => {
    const { inDo, stored, mirror } = adminSettings();
    await inDo(admin => admin.addGatewayModel({
      provider: "cloudflare", id: " @cf/test/added ", name: " Added ", contextWindow: 100000,
      outputLimit: 8000, apiToken: "smuggled",
    } as GatewayModel));
    const clean = [{
      provider: "cloudflare", id: "@cf/test/added", name: "Added", contextWindow: 100000,
      outputLimit: 8000,
    }];
    expect((await stored()).addedModels).toStrictEqual(clean);
    // Reading the config back sanitizes it again, so only the raw write shows what was stored.
    expect(JSON.parse(mirror.current!).addedModels).toStrictEqual(clean);
  });

  // A mode outlives its model when the catalog drops a model an admin had changed.
  it("starts a model in its default mode whatever mode its ID was left in", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.updateAdminConfig(
        { modelModes: { "claude-test": "disabled", "claude-fable-5-1": "hidden" } }));
    await inDo(admin => admin.addGatewayModel(ADDED));
    expect(await stored()).toEqual(
        { modelModes: { "claude-fable-5-1": "hidden" }, addedModels: [ADDED] });
  });

  it.each([
    ["an empty ID", { ...ADDED, id: " " }],
    ["an over-long name", { ...ADDED, name: "x".repeat(201) }],
    ["a fractional context window", { ...ADDED, contextWindow: 1.5 }],
    ["a non-positive output limit", { ...ADDED, outputLimit: 0 }],
    ["an unknown provider", { ...ADDED, provider: "mistral" }],
  ])("refuses %s as malformed", async (_, model) => {
    const { inDo, stored, put } = adminSettings();
    await expect(inDo(admin => admin.addGatewayModel(model as GatewayModel)))
        .rejects.toThrow("Invalid model:");
    expect((await stored()).addedModels).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ["a provider AI Gateway does not serve", { ...ADDED, provider: "ollama" as const },
      'Provider "ollama" is not served through AI Gateway.'],
    ["a provider this gateway does not enable", { ...ADDED, provider: "openai" as const },
      'Provider "openai" is not enabled on this deployment.'],
    ["a suggested model's ID", { ...ADDED, id: "claude-opus-5-5" },
      '"claude-opus-5-5" is already a suggested model.'],
    ["the ID of a suggested model on a provider that is not enabled",
      { ...ADDED, id: "gpt-6-luna" }, '"gpt-6-luna" is already a suggested model.'],
  ])("refuses %s", async (_, model, message) => {
    const { inDo, stored, put } = adminSettings();
    await expect(inDo(admin => admin.addGatewayModel(model))).rejects.toThrow(message);
    expect((await stored()).addedModels).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  // A response is reserved out of the window: the model's output limit, or the 32,768 tokens of
  // Workers AI for a Cloudflare model that gives none.
  const TINY: GatewayModel =
      { provider: "cloudflare", id: "@cf/test/tiny", name: "Tiny", contextWindow: 32768 };

  it.each<[string, GatewayModel, number]>([
    ["an output limit that fills its window", { ...ADDED, contextWindow: 8000, outputLimit: 8000 },
      8000],
    ["an output limit over its window", { ...ADDED, contextWindow: 8000, outputLimit: 9000 }, 9000],
    ["a window that the Workers AI reservation fills", TINY, 32768],
  ])("refuses a model with %s, which leaves a prompt no room", async (_, model, reserved) => {
    const { inDo, stored, put } = adminSettings();
    await expect(inDo(admin => admin.addGatewayModel(model))).rejects.toThrow(
        `The "${model.name}" model's context window leaves no room for a prompt: ${reserved} ` +
        "tokens of it are reserved for the response. Give the model an output limit under its " +
        "context window.");
    expect((await stored()).addedModels).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it("adds a model whose reservation leaves a prompt a token", async () => {
    const { inDo, stored } = adminSettings();
    const models = [
      { ...ADDED, contextWindow: 8000, outputLimit: 7999 },
      { ...TINY, outputLimit: 32767 },
    ];
    for (let model of models) await inDo(admin => admin.addGatewayModel(model));
    expect((await stored()).addedModels).toEqual(models);
  });

  it("refuses an ID that an added model already has, under any provider", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.addGatewayModel(ADDED));
    for (let model of [ADDED, { ...ADDED, provider: "cloudflare" as const, id: " claude-test " }]) {
      await expect(inDo(admin => admin.addGatewayModel(model)))
          .rejects.toThrow('"claude-test" is already an added model.');
    }
    expect((await stored()).addedModels).toEqual([ADDED]);
  });

  // The stored model is out of the table while its provider is not enabled, and comes back with
  // the provider, so its ID is not free in the meantime.
  it("refuses the ID of an added model whose provider is not enabled", async () => {
    const { inDo, stored } = adminSettings();
    const parked = { ...ADDED, provider: "openai" as const };
    await inDo(admin => admin.updateAdminConfig({ addedModels: [parked] }));
    const view = await inDo(admin => admin.getSettings("admin"));
    expect(view.gatewayModels!.models.map(model => model.id)).not.toContain("claude-test");

    await expect(inDo(admin => admin.addGatewayModel(ADDED)))
        .rejects.toThrow('"claude-test" is already an added model.');
    expect((await stored()).addedModels).toEqual([parked]);
  });

  // Each mutation waits on the KV write of the one before it, so a check made ahead of the
  // mutation would pass for both.
  it("adds a model once when two calls race", async () => {
    const { inDo, stored } = adminSettings();
    const results = await inDo(admin => Promise.allSettled(
        [admin.addGatewayModel(ADDED), admin.addGatewayModel({ ...ADDED, name: "Second" })]));
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await stored()).addedModels).toEqual([ADDED]);
  });

  it("keeps the model out of storage when the mirror write fails", async () => {
    const { inDo, stored, mirror } = adminSettings();
    mirror.fail = true;
    await expect(inDo(admin => admin.addGatewayModel(ADDED))).rejects.toThrow("KV unavailable");
    expect((await stored()).addedModels).toEqual([]);
  });

  it("removes an added model along with its mode", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.addGatewayModel(ADDED));
    await inDo(admin => admin.addGatewayModel({ ...ADDED, id: "claude-test-2" }));
    await inDo(admin => admin.setGatewayModelMode("claude-test", "disabled"));
    await inDo(admin => admin.setGatewayModelMode("claude-test-2", "hidden"));
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "hidden"));

    await inDo(admin => admin.removeGatewayModel("claude-test"));
    expect(await stored()).toEqual({
      modelModes: { "claude-test-2": "hidden", "claude-fable-5-1": "hidden" },
      addedModels: [{ ...ADDED, id: "claude-test-2" }],
    });

    // Its ID is free again, in the default mode.
    await inDo(admin => admin.addGatewayModel(ADDED));
    const view = await inDo(admin => admin.getSettings("admin"));
    expect(view.gatewayModels!.models.find(model => model.id === "claude-test"))
        .toMatchObject({ mode: "enabled", added: true });
  });

  // A mode set for a model that a queued removal is about to drop would otherwise outlive it.
  it("refuses a mode for a model whose removal is ahead of it", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.addGatewayModel(ADDED));
    const results = await inDo(admin => Promise.allSettled([
      admin.removeGatewayModel("claude-test"), admin.setGatewayModelMode("claude-test", "disabled"),
    ]));
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await stored()).toEqual({ modelModes: {}, addedModels: [] });
  });

  it("refuses to remove a model that was not added", async () => {
    const { inDo, stored, put } = adminSettings();
    await inDo(admin => admin.addGatewayModel(ADDED));
    put.mockClear();
    for (let id of ["claude-test-2", "claude-fable-5-1"]) {
      await expect(inDo(admin => admin.removeGatewayModel(id)))
          .rejects.toThrow(`No such added model: ${id}`);
    }
    expect((await stored()).addedModels).toEqual([ADDED]);
    expect(put).not.toHaveBeenCalled();
  });

  // Reachable when the catalog gains an ID that was added earlier: the catalog's model takes the
  // ID over, and with it the stored mode.
  it("keeps a suggested model's mode when removing an added model it shadows", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.updateAdminConfig({
      addedModels: [{ ...ADDED, id: "claude-fable-5-1" }],
      modelModes: { "claude-fable-5-1": "disabled" },
    }));
    await inDo(admin => admin.removeGatewayModel("claude-fable-5-1"));
    expect(await stored()).toEqual(
        { modelModes: { "claude-fable-5-1": "disabled" }, addedModels: [] });
  });
});

// Whether users may add their own models, as stored and as the admin panel is shown it.
const userModels = (inDo: ReturnType<typeof adminSettings>["inDo"]) => inDo(async admin => ({
  stored: admin.getAdminConfig().userModelsEnabled,
  view: (await admin.getSettings("admin")).gatewayModels!.userModelsEnabled,
}));

describe("AdminSettings users' own models", () => {
  it("allows them until turned off, storing and mirroring each change", async () => {
    const { inDo, put, mirror } = adminSettings();
    expect(await userModels(inDo)).toEqual({ stored: true, view: true });

    await inDo(admin => admin.setUserModelsEnabled(false));
    expect(await userModels(inDo)).toEqual({ stored: false, view: false });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(".adminConfig");
    expect(JSON.parse(mirror.current!).userModelsEnabled).toBe(false);

    await inDo(admin => admin.setUserModelsEnabled(true));
    expect(await userModels(inDo)).toEqual({ stored: true, view: true });
    expect(JSON.parse(mirror.current!).userModelsEnabled).toBe(true);
  });

  it("leaves the gateway's models and their modes alone", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.addGatewayModel(ADDED));
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "disabled"));
    const before = await inDo(admin => admin.getSettings("admin"));

    await inDo(admin => admin.setUserModelsEnabled(false));
    expect(await stored()).toEqual(
        { modelModes: { "claude-fable-5-1": "disabled" }, addedModels: [ADDED] });
    const after = await inDo(admin => admin.getSettings("admin"));
    expect(after.gatewayModels).toEqual({ ...before.gatewayModels, userModelsEnabled: false });
  });
});

// Whether the admin UI may suggest models from models.dev, as stored and as the admin panel is
// shown it.
const suggestions = (inDo: ReturnType<typeof adminSettings>["inDo"]) => inDo(async admin => ({
  stored: admin.getAdminConfig().modelsDevSuggestions,
  view: (await admin.getSettings("admin")).gatewayModels!.modelsDevSuggestions,
}));

describe("AdminSettings models.dev suggestions", () => {
  it("are off until turned on, storing and mirroring each change", async () => {
    const { inDo, put, mirror } = adminSettings();
    expect(await suggestions(inDo)).toEqual({ stored: false, view: false });

    await inDo(admin => admin.setModelsDevSuggestions(true));
    expect(await suggestions(inDo)).toEqual({ stored: true, view: true });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(".adminConfig");
    expect(JSON.parse(mirror.current!).modelsDevSuggestions).toBe(true);

    await inDo(admin => admin.setModelsDevSuggestions(false));
    expect(await suggestions(inDo)).toEqual({ stored: false, view: false });
    expect(JSON.parse(mirror.current!).modelsDevSuggestions).toBe(false);
  });

  it("leave the gateway's models, their modes and users' own models alone", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.addGatewayModel(ADDED));
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "disabled"));
    await inDo(admin => admin.setUserModelsEnabled(false));
    const before = await inDo(admin => admin.getSettings("admin"));

    await inDo(admin => admin.setModelsDevSuggestions(true));
    expect(await stored()).toEqual(
        { modelModes: { "claude-fable-5-1": "disabled" }, addedModels: [ADDED] });
    const after = await inDo(admin => admin.getSettings("admin"));
    expect(after.gatewayModels).toEqual({ ...before.gatewayModels, modelsDevSuggestions: true });
  });
});

describe("AdminSettings.getSettings gateway models", () => {
  it("lists every gateway model in its mode, and the providers a model may be added under",
      async () => {
    // ollama is enabled here, but AI Gateway does not serve it.
    const { inDo } = adminSettings({ ...GATEWAY, CF_AI_GATEWAY_PROVIDERS: "anthropic,ollama" });
    await inDo(admin => admin.addGatewayModel(ADDED));
    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "disabled"));

    const { gatewayModels } = await inDo(admin => admin.getSettings("admin"));
    expect(gatewayModels!.providers).toEqual(["anthropic"]);
    const byId = new Map(gatewayModels!.models.map(model => [model.id, model]));
    expect(byId.get("claude-fable-5-1")).toMatchObject(
        { provider: "anthropic", mode: "disabled", defaultMode: "enabled", added: false });
    expect(byId.get("claude-opus-5")).toMatchObject({ mode: "hidden", defaultMode: "hidden" });
    expect(byId.get("claude-test")).toStrictEqual({
      ...ADDED, mode: "enabled", defaultMode: "enabled", added: true,
      reasoningLevels: ["off", "minimal", "low", "medium", "high"], builtInReasoning: null,
      builtInCompactionInputBudget: 500000, maxCompactionInputBudget: 500000,
      runtimeKnown: false,
    });
    expect(gatewayModels!.models.at(-1)!.id).toBe("claude-test");
    expect(gatewayModels!.defaultReasoning).toBeNull();
  });

  it("gives each model its reasoning levels, its compaction budgets and its settings",
      async () => {
    const { inDo } = adminSettings(
        { ...GATEWAY, CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare" });
    const workersAi: GatewayModel = {
      provider: "cloudflare", id: "@cf/test/added", name: "Added", contextWindow: 100000,
      outputLimit: 8000,
    };
    await inDo(admin => admin.addGatewayModel(workersAi));
    await inDo(admin => admin.setGatewayModelSettings(
        "gpt-6-sol", { reasoning: "xhigh", compactionInputBudget: 500000 }));
    await inDo(admin => admin.setDefaultReasoning("medium"));

    const { gatewayModels } = await inDo(admin => admin.getSettings("admin"));
    expect(gatewayModels!.defaultReasoning).toBe("medium");
    const view = (id: string) => {
      const { reasoningLevels, builtInCompactionInputBudget, maxCompactionInputBudget,
          runtimeKnown, settings } = gatewayModels!.models.find(model => model.id === id)!;
      return { reasoningLevels, builtInCompactionInputBudget, maxCompactionInputBudget,
          runtimeKnown, settings };
    };
    // The one built-in budget below what the window leaves: 1,050,000 less a 128,000 response.
    expect(view("gpt-6-sol")).toStrictEqual({
      reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      builtInCompactionInputBudget: 272000, maxCompactionInputBudget: 922000,
      runtimeKnown: true, settings: { reasoning: "xhigh", compactionInputBudget: 500000 },
    });
    // The deployment's default is no setting of a model's own.
    expect(view("claude-opus-5-5")).toStrictEqual({
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      builtInCompactionInputBudget: 1000000, maxCompactionInputBudget: 1000000,
      runtimeKnown: true, settings: undefined,
    });
    // Workers AI charges the response to the window: 262,144 less 32,768.
    expect(view("@cf/zai-org/glm-5.2")).toStrictEqual({
      reasoningLevels: ["off", "high", "max"],
      builtInCompactionInputBudget: 229376, maxCompactionInputBudget: 229376,
      runtimeKnown: true, settings: undefined,
    });
    // An added model's limits are its own, and the runtime takes it for one that does no
    // reasoning.
    expect(view("@cf/test/added")).toStrictEqual({
      reasoningLevels: [],
      builtInCompactionInputBudget: 92000, maxCompactionInputBudget: 92000,
      runtimeKnown: false, settings: undefined,
    });
    expect(gatewayModels!.models.find(model => model.id === "claude-opus-5-5"))
        .not.toHaveProperty("settings");
  });

  it("says what each model is asked for while no reasoning level is set", async () => {
    const { inDo } = adminSettings(
        { ...GATEWAY, CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare" });
    await inDo(admin => admin.addGatewayModel({ ...ADDED, behavesLike: "claude-opus-5-5" }));
    await inDo(admin => admin.addGatewayModel({ ...ADDED, id: "claude-plain" }));
    // Neither a level of the model's own nor the deployment's default is its built-in request.
    await inDo(admin => admin.setGatewayModelSettings("claude-opus-5-5", { reasoning: "low" }));
    await inDo(admin => admin.setDefaultReasoning("high"));

    const { models } = (await inDo(admin => admin.getSettings("admin"))).gatewayModels!;
    const builtIn = (id: string) => models.find(model => model.id === id)!.builtInReasoning;
    // The model decides.
    expect(builtIn("claude-opus-5-5")).toBe("adaptive");
    expect(builtIn("claude-sonnet-5")).toBe("adaptive");
    // An added model takes the answer of the model it behaves like, and has none without one.
    expect(builtIn("claude-test")).toBe("adaptive");
    expect(builtIn("claude-plain")).toBeNull();
    expect(builtIn("claude-haiku-4-5")).toBeNull();
    expect(builtIn("gpt-6-sol")).toBe("medium");
    expect(builtIn("@cf/zai-org/glm-5.2")).toBeNull();
  });

  it("lists the providers in catalog order", async () => {
    const { inDo } = adminSettings({ ...GATEWAY, CF_AI_GATEWAY_PROVIDERS: "openai,anthropic" });
    const { gatewayModels } = await inDo(admin => admin.getSettings("admin"));
    const providers = [...new Set(gatewayModels!.models.map(model => model.provider))];
    expect(providers).toHaveLength(2);
    expect(gatewayModels!.providers).toEqual(providers);
  });

  it("omits them when the gateway's environment is unusable, rather than failing", async () => {
    // No transport: the gateway config's constructor throws.
    const { inDo } = adminSettings({ ...GATEWAY, CF_AI_GATEWAY_API_TOKEN: undefined });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await inDo(admin => admin.getSettings("admin"));
    const events = logged.mock.calls.map(([entry]) => (entry as { event?: unknown })?.event);
    logged.mockRestore();
    expect(view.gatewayModels).toBeUndefined();
    expect(view.signupsEnabled).toBe(true);
    expect(events).toEqual(["gateway.models.read.failed"]);
    await expect(inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "hidden")))
        .rejects.toThrow("AI Gateway mode needs a transport");
  });
});

describe("AdminSettings gateway model settings", () => {
  const OPUS = "claude-opus-5-5";

  it("stores a model's settings, and mirrors them to KV", async () => {
    const { inDo, settings, put, mirror } = adminSettings();
    await inDo(admin => admin.setGatewayModelSettings(
        OPUS, { reasoning: "low", compactionInputBudget: 300000 }));
    const stored = { [OPUS]: { reasoning: "low", compactionInputBudget: 300000 } };
    expect(await settings()).toStrictEqual(stored);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(".adminConfig");
    expect(JSON.parse(mirror.current!).modelSettings).toStrictEqual(stored);
  });

  it("replaces a model's settings whole, and forgets them once empty", async () => {
    const { inDo, settings, mirror } = adminSettings();
    await inDo(admin => admin.setGatewayModelSettings(
        OPUS, { reasoning: "low", compactionInputBudget: 300000 }));
    await inDo(admin => admin.setGatewayModelSettings("claude-fable-5-1", { reasoning: "max" }));

    // The budget is not carried over.
    await inDo(admin => admin.setGatewayModelSettings(OPUS, { reasoning: "high" }));
    expect(await settings()).toStrictEqual(
        { "claude-fable-5-1": { reasoning: "max" }, [OPUS]: { reasoning: "high" } });

    await inDo(admin => admin.setGatewayModelSettings(OPUS, {}));
    expect(await settings()).toStrictEqual({ "claude-fable-5-1": { reasoning: "max" } });
    expect(JSON.parse(mirror.current!).modelSettings)
        .toStrictEqual({ "claude-fable-5-1": { reasoning: "max" } });
  });

  // A request clamps the level to one the model has: Opus 5.5 can't stop thinking.
  it("stores a level the model does not have", async () => {
    const { inDo, settings } = adminSettings();
    await inDo(admin => admin.setGatewayModelSettings(OPUS, { reasoning: "off" }));
    expect(await settings()).toStrictEqual({ [OPUS]: { reasoning: "off" } });
  });

  it("accepts a compaction budget up to the room the model's window leaves", async () => {
    const { inDo, settings } = adminSettings();
    await inDo(admin => admin.setGatewayModelSettings(OPUS, { compactionInputBudget: 1 }));
    await inDo(admin => admin.setGatewayModelSettings(
        "@cf/zai-org/glm-5.2", { compactionInputBudget: 229376 }));
    expect(await settings()).toStrictEqual({
      [OPUS]: { compactionInputBudget: 1 },
      "@cf/zai-org/glm-5.2": { compactionInputBudget: 229376 },
    });
  });

  it.each([
    ["one over the room the window leaves", "@cf/zai-org/glm-5.2", 229377,
      'The compaction budget of the "GLM 5.2 (Workers AI)" model must be a whole number of ' +
      "tokens from 1 to 229376."],
    ["zero", OPUS, 0, 'The compaction budget of the "Claude Opus 5.5" model must be a whole ' +
      "number of tokens from 1 to 1000000."],
    ["a negative one", OPUS, -1, "must be a whole number of tokens from 1 to 1000000."],
    ["a fractional one", OPUS, 1000.5, "must be a whole number of tokens from 1 to 1000000."],
    ["one that is not a number", OPUS, NaN, "must be a whole number of tokens from 1 to 1000000."],
  ])("refuses a compaction budget of %s, leaving storage and the mirror alone",
      async (_, id, compactionInputBudget, message) => {
    const { inDo, settings, put } = adminSettings();
    await inDo(admin => admin.setGatewayModelSettings(id, { reasoning: "low" }));
    put.mockClear();
    await expect(inDo(admin => admin.setGatewayModelSettings(
        id, { reasoning: "high", compactionInputBudget }))).rejects.toThrow(message);
    expect(await settings()).toStrictEqual({ [id]: { reasoning: "low" } });
    expect(put).not.toHaveBeenCalled();
  });

  // Workers AI reserves 32,768 tokens for the response, which is more than this window. Such a
  // model can't be added, so this is one that was stored.
  it("refuses any compaction budget for a model whose window leaves no room", async () => {
    const { inDo, settings } = adminSettings();
    await inDo(admin => admin.updateAdminConfig({ addedModels: [
      { provider: "cloudflare", id: "@cf/test/tiny", name: "Tiny", contextWindow: 1000 },
    ] }));
    await expect(inDo(admin => admin.setGatewayModelSettings(
        "@cf/test/tiny", { compactionInputBudget: 1 }))).rejects.toThrow(
        'The "Tiny" model\'s context window leaves no room for a compaction budget.');
    // Its level can still be set.
    await inDo(admin => admin.setGatewayModelSettings("@cf/test/tiny", { reasoning: "high" }));
    expect(await settings()).toStrictEqual({ "@cf/test/tiny": { reasoning: "high" } });
  });

  it("refuses an ID that is not a gateway model", async () => {
    const { inDo, settings, put } = adminSettings();
    // The second is a suggested model of a provider this gateway does not enable.
    for (let id of ["claude-fable-9", "gpt-6-luna", "constructor"]) {
      await expect(inDo(admin => admin.setGatewayModelSettings(id, { reasoning: "low" })))
          .rejects.toThrow(`No such model: ${id}`);
    }
    expect(await settings()).toStrictEqual({});
    expect(put).not.toHaveBeenCalled();
  });

  it("gives a model whose ID is __proto__ settings of its own", async () => {
    const { inDo, settings, mirror } = adminSettings();
    await inDo(admin => admin.addGatewayModel({ ...ADDED, id: "__proto__" }));
    await inDo(admin => admin.setGatewayModelSettings("__proto__", { reasoning: "low" }));
    expect(Object.entries(await settings())).toEqual([["__proto__", { reasoning: "low" }]]);
    expect(Object.entries(parseAdminConfig(mirror.current).modelSettings))
        .toEqual([["__proto__", { reasoning: "low" }]]);
    const view = await inDo(admin => admin.getSettings("admin"));
    expect(view.gatewayModels!.models.find(model => model.id === "__proto__")?.settings)
        .toStrictEqual({ reasoning: "low" });

    await inDo(admin => admin.setGatewayModelSettings("__proto__", {}));
    expect(Object.entries(await settings())).toEqual([]);
  });

  it("removes an added model along with its settings", async () => {
    const { inDo, settings } = adminSettings();
    await inDo(admin => admin.addGatewayModel(ADDED));
    await inDo(admin => admin.setGatewayModelSettings("claude-test", { reasoning: "low" }));
    await inDo(admin => admin.setGatewayModelSettings(OPUS, { reasoning: "max" }));

    await inDo(admin => admin.removeGatewayModel("claude-test"));
    expect(await settings()).toStrictEqual({ [OPUS]: { reasoning: "max" } });

    // Its ID is free again, with nothing set.
    await inDo(admin => admin.addGatewayModel(ADDED));
    const view = await inDo(admin => admin.getSettings("admin"));
    expect(view.gatewayModels!.models.find(model => model.id === "claude-test"))
        .not.toHaveProperty("settings");
  });

  // Settings outlive their model when the catalog drops a model an admin had changed.
  it("starts a model with nothing set whatever its ID was left with", async () => {
    const { inDo, settings } = adminSettings();
    await inDo(admin => admin.updateAdminConfig({
      modelSettings: { "claude-test": { reasoning: "max" }, [OPUS]: { reasoning: "low" } },
    }));
    await inDo(admin => admin.addGatewayModel(ADDED));
    expect(await settings()).toStrictEqual({ [OPUS]: { reasoning: "low" } });
  });

  it("keeps a suggested model's settings when removing an added model it shadows", async () => {
    const { inDo, settings } = adminSettings();
    await inDo(admin => admin.updateAdminConfig({
      addedModels: [{ ...ADDED, id: OPUS }],
      modelSettings: { [OPUS]: { reasoning: "low" } },
    }));
    await inDo(admin => admin.removeGatewayModel(OPUS));
    expect(await settings()).toStrictEqual({ [OPUS]: { reasoning: "low" } });
  });

  it("stores the deployment's default reasoning level, and mirrors it to KV", async () => {
    const { inDo, put, mirror } = adminSettings();
    const level = () => inDo(async admin => ({
      stored: admin.getAdminConfig().defaultReasoning,
      view: (await admin.getSettings("admin")).gatewayModels!.defaultReasoning,
    }));
    expect(await level()).toEqual({ stored: null, view: null });

    await inDo(admin => admin.setDefaultReasoning("high"));
    expect(await level()).toEqual({ stored: "high", view: "high" });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(".adminConfig");
    expect(JSON.parse(mirror.current!).defaultReasoning).toBe("high");

    await inDo(admin => admin.setDefaultReasoning(null));
    expect(await level()).toEqual({ stored: null, view: null });
    expect(JSON.parse(mirror.current!).defaultReasoning).toBeNull();
  });
});

describe("AdminSettings added models that behave like another", () => {
  it("stores the model an added model behaves like, trimmed", async () => {
    const { inDo, stored } = adminSettings();
    await inDo(admin => admin.addGatewayModel({ ...ADDED, behavesLike: " claude-opus-5-5 " }));
    expect((await stored()).addedModels)
        .toStrictEqual([{ ...ADDED, behavesLike: "claude-opus-5-5" }]);

    // The runtime has no entry for the model's own ID, so it takes the other model's levels.
    const view = await inDo(admin => admin.getSettings("admin"));
    expect(view.gatewayModels!.models.find(model => model.id === "claude-test")).toMatchObject({
      behavesLike: "claude-opus-5-5", runtimeKnown: false, behavesLikeKnown: true,
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  // As after an upgrade to a runtime that dropped the other model.
  it("reports a stored one the runtime does not know, and nothing for a model with none",
      async () => {
    const { inDo } = adminSettings();
    const plain = { ...ADDED, id: "claude-plain" };
    await inDo(admin => admin.updateAdminConfig(
        { addedModels: [{ ...ADDED, behavesLike: "claude-nope" }, plain] }));
    const { models } = (await inDo(admin => admin.getSettings("admin"))).gatewayModels!;
    expect(models.find(model => model.id === ADDED.id)).toMatchObject({
      behavesLike: "claude-nope", runtimeKnown: false, behavesLikeKnown: false,
      reasoningLevels: ["off", "minimal", "low", "medium", "high"],
    });
    expect(models.find(model => model.id === plain.id)).not.toHaveProperty("behavesLikeKnown");
  });

  it.each([
    ["the runtime does not know", "claude-nope"],
    // A Workers AI model, which this gateway also provides.
    ["of another provider", "@cf/zai-org/glm-5.2"],
    ["named by an inherited key", "constructor"],
  ])("refuses a model %s", async (_, behavesLike) => {
    const { inDo, stored, put } = adminSettings();
    await expect(inDo(admin => admin.addGatewayModel({ ...ADDED, behavesLike })))
        .rejects.toThrow(`"${behavesLike}" is not a model the runtime knows under provider ` +
            '"anthropic", so "claude-test" can\'t behave like it.');
    expect((await stored()).addedModels).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses an over-long one as malformed", async () => {
    const { inDo, stored } = adminSettings();
    await expect(inDo(admin => admin.addGatewayModel({ ...ADDED, behavesLike: "x".repeat(201) })))
        .rejects.toThrow("Invalid model:");
    expect((await stored()).addedModels).toEqual([]);
  });

  // The runtime's own entry is used, so the claim is unused rather than wrong.
  it("accepts one for a model the runtime knows, and reports that it knows the model",
      async () => {
    const { inDo } = adminSettings();
    await inDo(admin => admin.addGatewayModel(
        { ...ADDED, id: "claude-sonnet-4-5", behavesLike: "claude-opus-5-5" }));
    const view = await inDo(admin => admin.getSettings("admin"));
    expect(view.gatewayModels!.models.find(model => model.id === "claude-sonnet-4-5"))
        .toMatchObject({ behavesLike: "claude-opus-5-5", runtimeKnown: true });
  });
});

// The providers an admin turned on, as stored and as the admin panel is shown every provider.
const providers = (inDo: ReturnType<typeof adminSettings>["inDo"]) => inDo(async admin => ({
  stored: admin.getAdminConfig().addedProviders,
  view: (await admin.getSettings("admin")).gatewayModels!.providerSettings,
}));

describe("AdminSettings gateway providers", () => {
  const FLOOR = [
    { provider: "cloudflare", enabledBy: "environment", needsApiToken: false },
    { provider: "anthropic", enabledBy: "environment", needsApiToken: false },
  ];
  const OPENAI_OFF = { provider: "openai", needsApiToken: false };
  const OPENAI_ON = { ...OPENAI_OFF, enabledBy: "admin" };
  const GOOGLE_OFF = { provider: "google", needsApiToken: false };

  it("turns a provider on and off, storing and mirroring each change", async () => {
    const { inDo, put, mirror } = adminSettings();
    expect(await providers(inDo)).toStrictEqual(
        { stored: [], view: [...FLOOR, OPENAI_OFF, GOOGLE_OFF] });

    await inDo(admin => admin.setGatewayProviderEnabled("openai", true));
    expect(await providers(inDo)).toStrictEqual(
        { stored: ["openai"], view: [...FLOOR, OPENAI_ON, GOOGLE_OFF] });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(".adminConfig");
    expect(JSON.parse(mirror.current!).addedProviders).toStrictEqual(["openai"]);
    // Its suggested models are the deployment's, and models can be added under it.
    const on = (await inDo(admin => admin.getSettings("admin"))).gatewayModels!;
    expect(on.providers).toEqual(["cloudflare", "anthropic", "openai"]);
    expect(on.models.find(model => model.id === "gpt-6-sol"))
        .toMatchObject({ provider: "openai", mode: "hidden", defaultMode: "hidden" });
    await inDo(admin => admin.addGatewayModel({ ...ADDED, provider: "openai", id: "gpt-test" }));

    // Once is enough. Reading the config back drops a repeat, so only the raw write shows one.
    await inDo(admin => admin.setGatewayProviderEnabled("openai", true));
    expect(JSON.parse(mirror.current!).addedProviders).toStrictEqual(["openai"]);

    await inDo(admin => admin.setGatewayProviderEnabled("openai", false));
    expect(await providers(inDo)).toStrictEqual(
        { stored: [], view: [...FLOOR, OPENAI_OFF, GOOGLE_OFF] });
    expect(JSON.parse(mirror.current!).addedProviders).toStrictEqual([]);
    const off = (await inDo(admin => admin.getSettings("admin"))).gatewayModels!;
    expect(off.providers).toEqual(["cloudflare", "anthropic"]);
    expect(off.models.filter(model => model.provider === "openai")).toEqual([]);
  });

  it("keeps the admin's other providers when one is turned off", async () => {
    const { inDo } = adminSettings();
    await inDo(admin => admin.setGatewayProviderEnabled("google", true));
    await inDo(admin => admin.setGatewayProviderEnabled("openai", true));
    await inDo(admin => admin.setGatewayProviderEnabled("google", false));
    expect((await providers(inDo)).stored).toStrictEqual(["openai"]);
  });

  it("refuses to turn off a provider the environment enables", async () => {
    const { inDo, put } = adminSettings();
    await expect(inDo(admin => admin.setGatewayProviderEnabled("anthropic", false)))
        .rejects.toThrow(new Error('Provider "anthropic" is enabled by CF_AI_GATEWAY_PROVIDERS ' +
            "and can only be turned off there."));
    expect((await providers(inDo)).view.slice(0, 2)).toStrictEqual(FLOOR);
    expect(put).not.toHaveBeenCalled();

    // Nor one that an admin had also turned on before the environment listed it.
    await inDo(admin => admin.updateAdminConfig({ addedProviders: ["anthropic"] }));
    await expect(inDo(admin => admin.setGatewayProviderEnabled("anthropic", false)))
        .rejects.toThrow("can only be turned off there.");
    expect((await providers(inDo)).stored).toStrictEqual(["anthropic"]);
  });

  it("stores nothing when turning on a provider the environment enables", async () => {
    const { inDo } = adminSettings();
    await inDo(admin => admin.setGatewayProviderEnabled("anthropic", true));
    const { stored, view } = await providers(inDo);
    expect(stored).toStrictEqual([]);
    expect(view.slice(0, 2)).toStrictEqual(FLOOR);
  });

  it("refuses a provider AI Gateway does not serve, on or off", async () => {
    // The environment lists ollama here, which makes it no more servable.
    for (let listed of ["anthropic", "anthropic,ollama"]) {
      const { inDo, put } = adminSettings({ ...GATEWAY, CF_AI_GATEWAY_PROVIDERS: listed });
      for (let enabled of [true, false]) {
        await expect(inDo(admin => admin.setGatewayProviderEnabled("ollama", enabled)))
            .rejects.toThrow(new Error('Provider "ollama" is not served through AI Gateway.'));
      }
      expect((await providers(inDo)).stored).toStrictEqual([]);
      expect(put).not.toHaveBeenCalled();
    }
  });

  it("keeps what is stored for a provider's models while the provider is off", async () => {
    const { inDo, stored, settings } = adminSettings();
    const added = { ...ADDED, provider: "openai" as const, id: "gpt-test" };
    await inDo(admin => admin.setGatewayProviderEnabled("openai", true));
    await inDo(admin => admin.setGatewayModelMode("gpt-6-luna", "disabled"));
    await inDo(admin => admin.setGatewayModelSettings("gpt-6-luna", { reasoning: "low" }));
    await inDo(admin => admin.addGatewayModel(added));
    await inDo(admin => admin.setGatewayModelMode("gpt-test", "hidden"));
    const before = (await inDo(admin => admin.getSettings("admin"))).gatewayModels!;
    const kept = {
      modelModes: { "gpt-6-luna": "disabled", "gpt-test": "hidden" }, addedModels: [added],
    };
    expect(await stored()).toEqual(kept);

    await inDo(admin => admin.setGatewayProviderEnabled("openai", false));
    expect(await stored()).toEqual(kept);
    expect(await settings()).toStrictEqual({ "gpt-6-luna": { reasoning: "low" } });
    const off = (await inDo(admin => admin.getSettings("admin"))).gatewayModels!;
    expect(off.models.filter(model => model.provider === "openai")).toEqual([]);
    // Out of the table, its models can't be changed, and an added one keeps its ID.
    await expect(inDo(admin => admin.setGatewayModelMode("gpt-6-luna", "enabled")))
        .rejects.toThrow("No such model: gpt-6-luna");
    await expect(inDo(admin => admin.addGatewayModel({ ...ADDED, id: "gpt-test" })))
        .rejects.toThrow('"gpt-test" is already an added model.');

    await inDo(admin => admin.setGatewayProviderEnabled("openai", true));
    expect((await inDo(admin => admin.getSettings("admin"))).gatewayModels).toStrictEqual(before);
  });

  // The environment listing google with no token is a gateway that does not start. An admin
  // turning it on must leave every other gateway read and write working.
  it("turns google on for a deployment with no token, and reports that it needs one",
      async () => {
    const { inDo, stored } = adminSettings({
      ...GATEWAY, CF_AI_GATEWAY_API_TOKEN: undefined, WORKERS_AI: { fetch: vi.fn() },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await inDo(admin => admin.setGatewayProviderEnabled("google", true));
      const { gatewayModels } = await inDo(admin => admin.getSettings("admin"));
      expect(gatewayModels!.providerSettings).toStrictEqual([
        ...FLOOR, OPENAI_OFF, { provider: "google", enabledBy: "admin", needsApiToken: true },
      ]);
      expect(gatewayModels!.models.map(model => model.id)).toContain("gemini-3.6-flash");

      await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "hidden"));
      await inDo(admin => admin.addGatewayModel(
          { ...ADDED, provider: "google", id: "gemini-test" }));
      expect((await stored()).modelModes).toEqual({ "claude-fable-5-1": "hidden" });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

// The first of Workers AI's suggested models, which is the one a test of that provider asks.
const KIMI = "@cf/moonshotai/kimi-k2.7-code";

// One event of a Workers AI chat completion, as the gateway streams it.
const chunk = (choice: object, rest: object = {}) => `data: ${JSON.stringify({
  id: "completion", object: "chat.completion.chunk", created: 0, model: KIMI,
  choices: [{ index: 0, ...choice }], ...rest,
})}\n\n`;
function completion(text: string): Response {
  return new Response(
      chunk({ delta: { role: "assistant", content: text }, finish_reason: null }) +
      chunk({ delta: {}, finish_reason: "stop" },
          { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
      "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
}
const refusal = (status: number, said: string) => () => new Response(said, { status });

// A stream of server-sent events, each named by its type as Anthropic and OpenAI name theirs.
const events = (sent: { type: string }[]) => new Response(
    sent.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
// "OK" as each provider's own API streams it, by the gateway route the request took.
function answered(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname.includes("/anthropic/")) {
    return events([
      { type: "message_start", message: {
        id: "message", type: "message", role: "assistant", model: "claude", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ] as { type: string }[]);
  }
  if (pathname.includes("/openai/")) {
    const item = {
      type: "message", id: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    };
    return events([
      { type: "response.output_item.added", output_index: 0,
        item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: {
        id: "response", status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } },
    ] as { type: string }[]);
  }
  return completion("OK");
}

/**
 * An AdminSettings whose gateway rides a Workers AI binding that answers each request with
 * `respond`, beside the HTTPS token unless `vars` says otherwise. `test` runs one provider
 * test and `testModel` one model test, each returning its result with the entries it logged.
 */
function tested(respond: (request: Request) => Response | Promise<Response>,
                vars: object = {}) {
  const requests: { url: string, headers: Headers, body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url, headers: request.headers, body: await request.clone().json(),
    });
    return respond(request);
  });
  const settings = adminSettings({ ...GATEWAY, WORKERS_AI: { fetch }, ...vars });
  const logging = async <T>(event: string, run: (admin: AdminSettings) => Promise<T>) => {
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await settings.inDo(run);
      const entries = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
          .filter(entry => entry?.event === event);
      return { result, entries };
    } finally {
      logged.mockRestore();
    }
  };
  const test = (provider: Parameters<AdminSettings["testGatewayProvider"]>[0]) => logging(
      "gateway.provider.test", admin => admin.testGatewayProvider(provider, "admin@example.com"));
  const testModel = (modelId: string) => logging(
      "gateway.model.test", admin => admin.testGatewayModel(modelId, "admin@example.com"));
  return { ...settings, fetch, requests, test, testModel };
}

describe("AdminSettings.testGatewayProvider", () => {
  const TIMED_OUT = "The model did not answer within 15 seconds.";
  const NO_TOKEN = 'Provider "google" cannot use the Workers AI binding transport, and no ' +
      "CF_AI_GATEWAY_API_TOKEN is configured for the HTTPS one.";

  it("asks the provider's first suggested model for a few tokens, as the admin", async () => {
    const { test, requests, put, inDo } = tested(() => completion("OK"));
    const before = await inDo(admin => admin.getAdminConfig());
    const { result, entries } = await test("cloudflare");

    expect(KIMI).toBe(Object.keys(SUGGESTED_MODELS.cloudflare)[0]);
    expect(result).toStrictEqual({ model: KIMI, ok: true });
    expect(requests).toHaveLength(1);
    const [{ url, headers, body }] = requests;
    expect(url).toBe("https://workers-binding.ai/ai-gateway/gateways/platform-gateway/" +
        "workers-ai/v1/chat/completions");
    expect(JSON.parse(headers.get("cf-aig-metadata")!))
        .toStrictEqual({ user: "admin@example.com" });
    // Every test sends the same request, which a caching gateway must not answer itself.
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(body.model).toBe(KIMI);
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(16);

    expect(entries).toEqual([{
      component: "workshop.admin.settings", event: "gateway.provider.test",
      message: "tested an AI Gateway provider", modelId: KIMI, outcome: "ok",
      durationMs: expect.any(Number),
    }]);
    // Nothing is stored.
    expect(await inDo(admin => admin.getAdminConfig())).toStrictEqual(before);
    expect(put).not.toHaveBeenCalled();
  });

  it("reports a refused request with its status, and logs neither its message nor the prompt",
      async () => {
    const { test, requests } = tested(refusal(401, "Incorrect API key provided."));
    const { result, entries } = await test("cloudflare");
    expect(result).toStrictEqual(
        { model: KIMI, ok: false, status: 401, message: "401 Incorrect API key provided." });

    expect(entries).toEqual([{
      component: "workshop.admin.settings", event: "gateway.provider.test",
      message: "tested an AI Gateway provider", modelId: KIMI, outcome: "error", statusCode: 401,
      durationMs: expect.any(Number),
    }]);
    const prompt = (requests[0]!.body.messages as { content: string }[]).at(-1)!.content;
    expect(prompt).toBeTypeOf("string");
    expect(JSON.stringify(entries)).not.toContain(prompt);
    expect(JSON.stringify(entries)).not.toContain("Incorrect API key");
  });

  // pi's OpenAI adapter words a refusal differently from the provider SDKs.
  it("reports the status of a refused OpenAI request", async () => {
    const [model] = Object.keys(SUGGESTED_MODELS.openai);
    const { test, requests } = tested(() => Response.json(
        { error: { message: "Incorrect API key provided.", code: "invalid_api_key" } },
        { status: 401 }));
    const { result, entries } = await test("openai");
    expect(requests.map(({ url }) => url)).toEqual(
        ["https://workers-binding.ai/ai-gateway/gateways/platform-gateway/openai/responses"]);
    expect(result).toStrictEqual({
      model, ok: false, status: 401,
      message: 'OpenAI API error (401): ' +
          '{"message":"Incorrect API key provided.","code":"invalid_api_key"}',
    });
    expect(entries).toEqual([{
      component: "workshop.admin.settings", event: "gateway.provider.test",
      message: "tested an AI Gateway provider", modelId: model, outcome: "error", statusCode: 401,
      durationMs: expect.any(Number),
    }]);
  });

  // pi's Google adapter reports a refusal as the response body alone, which names no status.
  it("reports a refused Google request without a status", async () => {
    const { test, fetch: binding } = tested(() => completion("OK"));
    const urls: string[] = [];
    const skipCache: (string | null)[] = [];
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      skipCache.push(request.headers.get("cf-aig-skip-cache"));
      return Response.json(
          { error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" } },
          { status: 401 });
    });
    try {
      const { result, entries } = await test("google");
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("/platform-gateway/google-ai-studio/v1beta/models/");
      // Over HTTPS too, a gateway that caches responses is told to ask the provider.
      expect(skipCache).toEqual(["true"]);
      expect(result).toStrictEqual({
        model: "gemini-3.6-flash", ok: false,
        message: '{"error":{"code":401,"message":"API key not valid.","status":"UNAUTHENTICATED"}}',
      });
      expect(entries).toMatchObject([{ modelId: "gemini-3.6-flash", outcome: "error" }]);
      expect(entries[0]!.statusCode).toBeUndefined();
    } finally {
      fetched.mockRestore();
    }
    expect(binding).not.toHaveBeenCalled();
  });

  it("reports a provider that needs a token the deployment lacks, without a request",
      async () => {
    const { test, fetch } = tested(() => completion("OK"), { CF_AI_GATEWAY_API_TOKEN: undefined });
    const { result, entries } = await test("google");
    expect(result).toStrictEqual({ model: "gemini-3.6-flash", ok: false, message: NO_TOKEN });
    expect(fetch).not.toHaveBeenCalled();
    expect(entries).toMatchObject([{ modelId: "gemini-3.6-flash", outcome: "error" }]);
    expect(entries[0]!.statusCode).toBeUndefined();
  });

  it("reports a model that does not answer in time", async () => {
    // Fifteen seconds, shortened for the test. The transport answers only by failing once the
    // request is aborted.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(20));
    try {
      const { test, requests } = tested(request => new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
      const { result, entries } = await test("cloudflare");
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(requests).toHaveLength(1);
      expect(result).toStrictEqual({ model: KIMI, ok: false, message: TIMED_OUT });
      expect(entries).toMatchObject([{ modelId: KIMI, outcome: "error" }]);
      expect(entries[0]!.statusCode).toBeUndefined();
    } finally {
      timeout.mockRestore();
    }
  });

  it("tests a provider that is off, and leaves it off", async () => {
    const { test, inDo } = tested(
        () => completion("OK"), { CF_AI_GATEWAY_PROVIDERS: "anthropic" });
    expect((await test("cloudflare")).result).toStrictEqual({ model: KIMI, ok: true });
    const { stored, view } = await providers(inDo);
    expect(stored).toStrictEqual([]);
    expect(view[0]).toStrictEqual({ provider: "cloudflare", needsApiToken: false });
  });

  it("throws for a provider AI Gateway does not serve", async () => {
    const { inDo, fetch } = tested(() => completion("OK"));
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(inDo(admin => admin.testGatewayProvider("ollama", "admin@example.com")))
          .rejects.toThrow(new Error('Provider "ollama" is not served through AI Gateway.'));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("puts a failure's message on one line, cuts it short, and keeps the token out of it",
      async () => {
    const said = `bad\n\n  key:\tgateway-token was\r\nrefused ${"x".repeat(400)}`;
    const { test } = tested(refusal(403, said));
    const { result, entries } = await test("cloudflare");
    expect(result).toStrictEqual({
      model: KIMI, ok: false, status: 403,
      message: `403 bad key: [redacted] was refused ${"x".repeat(400)}`.slice(0, 300),
    });
    expect(JSON.stringify(entries)).not.toContain("gateway-token");
    expect(JSON.stringify(entries)).not.toContain("refused");

    // A token the cut would otherwise leave the start of.
    const straddling = tested(refusal(403, `${"y".repeat(292)}gateway-token`));
    const { message } = (await straddling.test("cloudflare")).result as { message: string };
    expect(message).toBe(`403 ${"y".repeat(292)}[red`);
  });

  // The request is out for as long as fifteen seconds, which no other admin call waits for.
  it("lets the config be read and changed while the request is out", async () => {
    const requested = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Response>();
    const { inDo } = tested(() => {
      requested.resolve();
      return answer.promise;
    });
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await inDo(async admin => {
        const test = admin.testGatewayProvider("cloudflare", "admin@example.com");
        await requested.promise;
        await admin.setGatewayModelMode("claude-fable-5-1", "hidden");
        const view = (await admin.getSettings("admin")).gatewayModels!;
        expect(view.models.find(model => model.id === "claude-fable-5-1")?.mode).toBe("hidden");
        answer.resolve(completion("OK"));
        expect(await test).toStrictEqual({ model: KIMI, ok: true });
      });
    } finally {
      logged.mockRestore();
    }
  });
});

// What a request asks its model for, in each API's own terms: the reasoning and the response
// cap. pi gives a Claude whose effort it manages that effort in a closing system message.
const asked = ({ body }: { body: Record<string, unknown> }) => {
  const { messages, thinking, output_config, reasoning } = body as {
    messages?: { output_config?: { effort: string } }[],
    thinking?: { type: string, budget_tokens?: number },
    output_config?: { effort: string }, reasoning?: { effort: string },
  };
  return {
    thinking: thinking?.type, budget: thinking?.budget_tokens,
    effort: messages?.at(-1)?.output_config?.effort ?? output_config?.effort ??
        reasoning?.effort ?? body.reasoning_effort,
    cap: body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens,
  };
};

describe("AdminSettings.testGatewayModel", () => {
  const GLM = "@cf/zai-org/glm-5.2";
  const OPUS = "claude-opus-5-5";
  const SONNET_5 = "claude-sonnet-5";
  const EVERY_PROVIDER = { CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare" };
  const LOGGED = {
    component: "workshop.admin.settings", event: "gateway.model.test",
    message: "tested an AI Gateway model", durationMs: expect.any(Number),
  };
  // An AdminSettings whose models all answer "OK". `sent` tests one and returns what its request
  // asked for.
  function answering() {
    const settings = tested(answered, EVERY_PROVIDER);
    const sent = async (modelId: string) => {
      const { result } = await settings.testModel(modelId);
      expect(result).toStrictEqual({ model: modelId, ok: true });
      return asked(settings.requests.at(-1)!);
    };
    return { ...settings, sent };
  }

  it("asks the model for an answer, as the admin, and stores nothing", async () => {
    const { testModel, requests, put, inDo } = tested(answered);
    const before = await inDo(admin => admin.getAdminConfig());
    const { result, entries } = await testModel(GLM);

    expect(result).toStrictEqual({ model: GLM, ok: true });
    expect(requests).toHaveLength(1);
    const [{ url, headers, body }] = requests;
    expect(url).toBe("https://workers-binding.ai/ai-gateway/gateways/platform-gateway/" +
        "workers-ai/v1/chat/completions");
    expect(JSON.parse(headers.get("cf-aig-metadata")!))
        .toStrictEqual({ user: "admin@example.com" });
    // Every test of a model sends the same request, which a caching gateway must not answer
    // itself.
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(body.model).toBe(GLM);
    expect(body.messages).toEqual([{ role: "user", content: "Reply with OK." }]);

    expect(entries).toEqual([{ ...LOGGED, modelId: GLM, outcome: "ok" }]);
    expect(await inDo(admin => admin.getAdminConfig())).toStrictEqual(before);
    expect(put).not.toHaveBeenCalled();
  });

  // The settings are read from the object's own storage: the KV mirror of these tests is empty.
  it("asks for the reasoning level in effect for the model", async () => {
    const { sent, requests, inDo } = answering();
    // With nothing set, each model's built-in request. A quick request, which is what a provider
    // test sends, would turn Sonnet 5's thinking off.
    expect(await sent(SONNET_5)).toEqual({ thinking: "adaptive", cap: 2048 });
    expect(await sent("gpt-6-sol")).toEqual({ effort: "medium", cap: 2048 });
    expect(await sent(GLM)).toEqual({ cap: 2048 });

    // The deployment's default, for a model with no level of its own.
    await inDo(admin => admin.setDefaultReasoning("high"));
    expect(await sent(SONNET_5)).toEqual({ thinking: "adaptive", effort: "high", cap: 2048 });
    expect(await sent("gpt-6-sol")).toEqual({ effort: "high", cap: 2048 });
    expect(await sent(GLM)).toEqual({ effort: "high", cap: 2048 });

    // The model's own level comes ahead of the default.
    await inDo(admin => admin.setGatewayModelSettings(SONNET_5, { reasoning: "low" }));
    expect(await sent(SONNET_5)).toEqual({ thinking: "adaptive", effort: "low", cap: 2048 });
    expect(requests).toHaveLength(7);
  });

  // Both ask Opus 5.5, the first of Anthropic's suggested models, which can't stop thinking.
  it("sends an agent turn's request where a provider test sends a quick one", async () => {
    const { test, sent, requests } = answering();
    expect((await test("anthropic")).result).toStrictEqual({ model: OPUS, ok: true });
    expect(asked(requests[0]!)).toEqual({ thinking: "adaptive", effort: "low", cap: 16 });
    expect(await sent(OPUS)).toEqual({ thinking: "adaptive", effort: "high", cap: 2048 });
  });

  it("asks an added model in the format of the model it behaves like", async () => {
    const { sent, inDo } = answering();
    await inDo(admin => admin.addGatewayModel({ ...ADDED, behavesLike: OPUS }));
    await inDo(admin => admin.addGatewayModel({ ...ADDED, id: "claude-plain" }));
    // The built-in request is borrowed too: an Anthropic model the runtime does not know is
    // asked for nothing.
    expect(await sent("claude-test")).toEqual({ thinking: "adaptive", effort: "high", cap: 2048 });
    expect(await sent("claude-plain")).toEqual({ cap: 2048 });

    // Opus 5.5 takes a level as an effort, and a model the runtime does not know as a budget.
    await inDo(admin => admin.setDefaultReasoning("medium"));
    expect(await sent("claude-test"))
        .toEqual({ thinking: "adaptive", effort: "medium", cap: 2048 });
    expect(await sent("claude-plain")).toEqual({ thinking: "enabled", budget: 1024, cap: 2048 });
  });

  it("caps the response at 2,048 tokens, or at the model's own cap when that is lower",
      async () => {
    const { sent, inDo } = answering();
    await inDo(admin => admin.addGatewayModel({
      provider: "cloudflare", id: "@cf/test/short", name: "Short", contextWindow: 100000,
      outputLimit: 1000,
    }));
    expect(await sent("@cf/test/short")).toEqual({ cap: 1000 });
    // Workers AI's own models answer with up to 32,768 tokens.
    expect(await sent(KIMI)).toEqual({ cap: 2048 });
  });

  it("tests a model that is hidden or disabled, and leaves it so", async () => {
    const { sent, inDo, stored, put } = answering();
    await inDo(admin => admin.setGatewayModelMode(GLM, "disabled"));
    await inDo(admin => admin.setGatewayModelMode(KIMI, "hidden"));
    put.mockClear();
    expect(await sent(GLM)).toEqual({ cap: 2048 });
    expect(await sent(KIMI)).toEqual({ cap: 2048 });
    expect((await stored()).modelModes).toEqual({ [GLM]: "disabled", [KIMI]: "hidden" });
    expect(put).not.toHaveBeenCalled();
  });

  it("reports a refused request with its status, and logs neither its message nor the prompt",
      async () => {
    const { testModel, requests } = tested(refusal(401, "Incorrect API key\n for gateway-token."));
    const { result, entries } = await testModel(GLM);
    // On one line, without the deployment's gateway token.
    expect(result).toStrictEqual({
      model: GLM, ok: false, status: 401, message: "401 Incorrect API key for [redacted].",
    });

    expect(entries).toEqual([{ ...LOGGED, modelId: GLM, outcome: "error", statusCode: 401 }]);
    const prompt = (requests[0]!.body.messages as { content: string }[]).at(-1)!.content;
    expect(prompt).toBe("Reply with OK.");
    expect(JSON.stringify(entries)).not.toContain(prompt);
    expect(JSON.stringify(entries)).not.toContain("Incorrect API key");
  });

  it("reports a model whose provider needs a token the deployment lacks, without a request",
      async () => {
    const { testModel, fetch, inDo } = tested(answered, { CF_AI_GATEWAY_API_TOKEN: undefined });
    await inDo(admin => admin.setGatewayProviderEnabled("google", true));
    const { result, entries } = await testModel("gemini-3.6-flash");
    expect(result).toStrictEqual({
      model: "gemini-3.6-flash", ok: false,
      message: 'Provider "google" cannot use the Workers AI binding transport, and no ' +
          "CF_AI_GATEWAY_API_TOKEN is configured for the HTTPS one.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(entries).toEqual([{ ...LOGGED, modelId: "gemini-3.6-flash", outcome: "error" }]);
  });

  it("reports a model that does not answer in time", async () => {
    // Thirty seconds, shortened for the test. The transport answers only by failing once the
    // request is aborted.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(20));
    try {
      const { testModel, requests } = tested(request => new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
      const { result, entries } = await testModel(GLM);
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(requests).toHaveLength(1);
      expect(result).toStrictEqual(
          { model: GLM, ok: false, message: "The model did not answer within 30 seconds." });
      expect(entries).toEqual([{ ...LOGGED, modelId: GLM, outcome: "error" }]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("throws for an ID that names no gateway model", async () => {
    const { inDo, fetch } = tested(answered);
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // The second is a suggested model of a provider this gateway does not enable.
      for (let id of ["claude-fable-9", "gpt-6-luna", "constructor"]) {
        await expect(inDo(admin => admin.testGatewayModel(id, "admin@example.com")))
            .rejects.toThrow(new Error(`No such model: ${id}`));
      }
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  // The request is out for as long as thirty seconds, which no other admin call waits for.
  it("lets the config be read and changed while the request is out", async () => {
    const requested = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Response>();
    const { inDo } = tested(() => {
      requested.resolve();
      return answer.promise;
    });
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await inDo(async admin => {
        const test = admin.testGatewayModel(GLM, "admin@example.com");
        await requested.promise;
        await admin.setGatewayModelMode("claude-fable-5-1", "hidden");
        const view = (await admin.getSettings("admin")).gatewayModels!;
        expect(view.models.find(model => model.id === "claude-fable-5-1")?.mode).toBe("hidden");
        answer.resolve(completion("OK"));
        expect(await test).toStrictEqual({ model: GLM, ok: true });
      });
    } finally {
      logged.mockRestore();
    }
  });
});

describe("AdminSettings outside AI Gateway mode", () => {
  it("has no gateway models to show, and refuses to change any", async () => {
    const { inDo, stored, settings, put } = adminSettings({});
    expect((await inDo(admin => admin.getSettings("admin"))).gatewayModels).toBeUndefined();

    await expect(inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "hidden")))
        .rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.addGatewayModel(ADDED))).rejects.toThrow(NOT_GATEWAY);
    await inDo(admin => admin.updateAdminConfig({ addedModels: [ADDED] }));
    put.mockClear();
    await expect(inDo(admin => admin.removeGatewayModel("claude-test"))).rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.setUserModelsEnabled(false))).rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.setModelsDevSuggestions(true))).rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.setGatewayModelSettings("claude-test", { reasoning: "low" })))
        .rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.setDefaultReasoning("low"))).rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.setGatewayProviderEnabled("openai", true)))
        .rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.testGatewayProvider("anthropic", "admin")))
        .rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.testGatewayModel("claude-fable-5-1", "admin")))
        .rejects.toThrow(NOT_GATEWAY);
    expect(await inDo(admin => admin.getAdminConfig().addedProviders)).toStrictEqual([]);
    expect(await settings()).toStrictEqual({});
    expect(await inDo(admin => admin.getAdminConfig().defaultReasoning)).toBeNull();
    expect(await stored()).toEqual({ modelModes: {}, addedModels: [ADDED] });
    expect(await inDo(admin => admin.getAdminConfig().userModelsEnabled)).toBe(true);
    expect(await inDo(admin => admin.getAdminConfig().modelsDevSuggestions)).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
