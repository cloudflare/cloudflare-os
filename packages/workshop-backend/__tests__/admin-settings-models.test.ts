import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GatewayModel } from "@gadgets/workshop-shared/api";
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
  return { inDo, stored, put, mirror };
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
    expect(byId.get("claude-test")).toStrictEqual(
        { ...ADDED, mode: "enabled", defaultMode: "enabled", added: true });
    expect(gatewayModels!.models.at(-1)!.id).toBe("claude-test");
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

describe("AdminSettings outside AI Gateway mode", () => {
  it("has no gateway models to show, and refuses to change any", async () => {
    const { inDo, stored, put } = adminSettings({});
    expect((await inDo(admin => admin.getSettings("admin"))).gatewayModels).toBeUndefined();

    await expect(inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "hidden")))
        .rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.addGatewayModel(ADDED))).rejects.toThrow(NOT_GATEWAY);
    await inDo(admin => admin.updateAdminConfig({ addedModels: [ADDED] }));
    put.mockClear();
    await expect(inDo(admin => admin.removeGatewayModel("claude-test"))).rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.setUserModelsEnabled(false))).rejects.toThrow(NOT_GATEWAY);
    await expect(inDo(admin => admin.setModelsDevSuggestions(true))).rejects.toThrow(NOT_GATEWAY);
    expect(await stored()).toEqual({ modelModes: {}, addedModels: [ADDED] });
    expect(await inDo(admin => admin.getAdminConfig().userModelsEnabled)).toBe(true);
    expect(await inDo(admin => admin.getAdminConfig().modelsDevSuggestions)).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
