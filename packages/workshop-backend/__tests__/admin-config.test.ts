import { describe, expect, it } from "vitest";
import type { GatewayModel } from "@gadgets/workshop-shared/api";
import { defaultOutputFormatId, normalizeAdminConfig, parseAdminConfig, reorderFormats, resolveFormatOutput, sanitizeAddedModel, sanitizeModelSettings, sanitizeOutputOverrides, serializeAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";

describe("parseAdminConfig", () => {
  it("backfills fields missing from a config persisted before they existed", () => {
    // A config written before `formats` was added. Every consumer indexes into these, so a missing
    // field must come back as its default rather than undefined.
    let stored = JSON.stringify({ signupsEnabled: false, siteName: "acme" });
    let config = parseAdminConfig(stored);

    expect(config.signupsEnabled).toBe(false);
    expect(config.siteName).toBe("acme");
    expect(config.formats).toEqual([]);
    expect(config.userSearchEnabled).toBe(true);
    for (let key of Object.keys(DEFAULT_ADMIN_CONFIG)) {
      expect(config[key as keyof typeof config], key).toBeDefined();
    }
  });

  it("defaults user search opposite signups while preserving an explicit setting", () => {
    expect(DEFAULT_ADMIN_CONFIG.userSearchEnabled).toBe(!DEFAULT_ADMIN_CONFIG.signupsEnabled);
    expect(parseAdminConfig(JSON.stringify({ signupsEnabled: true })).userSearchEnabled).toBe(false);
    expect(parseAdminConfig(JSON.stringify({
      signupsEnabled: true,
      userSearchEnabled: true,
    })).userSearchEnabled).toBe(true);
  });

  it("applies the dependent default to legacy AdminSettings records", () => {
    expect(normalizeAdminConfig({ signupsEnabled: false }).userSearchEnabled).toBe(true);
  });

  it("drops malformed format entries rather than the whole list", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "good", enabled: true, agentHint: "  prefer me  " },
        { enabled: true },                       // no blueprintId
        "nonsense",
        { blueprintId: "defaults-enabled" },     // enabled omitted
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "good", enabled: true, agentHint: "prefer me" },
      { blueprintId: "defaults-enabled", enabled: true },
    ]);
  });

  // Everything downstream keys formats by blueprint id; setFormatOrder() in particular treats the
  // list as a set and refuses every reordering if it isn't one. A duplicate would make the menu
  // permanently unorderable, so it can't be allowed to survive a read.
  it("keeps only the first entry for a repeated blueprint", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "dup", enabled: true, agentHint: "first" },
        { blueprintId: "other", enabled: true },
        { blueprintId: "dup", enabled: false, agentHint: "second" },
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "dup", enabled: true, agentHint: "first" },
      { blueprintId: "other", enabled: true },
    ]);
  });
});

describe("reorderFormats", () => {
  let promoted = [
    { blueprintId: "a", enabled: true },
    { blueprintId: "b", enabled: true },
    { blueprintId: "c", enabled: true },
  ];

  it("rearranges into the order given", () => {
    expect(reorderFormats(promoted, ["c", "a", "b"]).map(f => f.blueprintId))
        .toEqual(["c", "a", "b"]);
  });

  // A repeated id passes both a length and a membership test, so without an explicit uniqueness
  // check it would drop "b" and leave a duplicate that makes every later reorder throw.
  it("refuses a repeated id", () => {
    expect(() => reorderFormats(promoted, ["a", "a", "c"])).toThrow(/exactly once/);
  });

  it("refuses a short list, a long list, and an unknown id", () => {
    expect(() => reorderFormats(promoted, ["a", "b"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "c", "a"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "z"])).toThrow(/exactly once/);
  });
});

describe("format presentation", () => {
  let declared = { id: "presentation", noun: "Slides", plural: "Slides", icon: "presentation" } as const;

  it("applies overrides over the blueprint's own declaration", () => {
    expect(resolveFormatOutput(declared, { noun: "Briefing", plural: "Briefings" }))
        .toEqual({ ...declared, noun: "Briefing", plural: "Briefings" });
  });

  it("has no format to offer when neither side supplies a complete one", () => {
    expect(resolveFormatOutput(undefined, { noun: "Briefing" })).toBeUndefined();
    expect(resolveFormatOutput(undefined, undefined)).toBeUndefined();
  });

  it("keeps only well-formed override fields", () => {
    expect(sanitizeOutputOverrides({ noun: "  Deck  ", icon: "notAnIcon", plural: "" }))
        .toEqual({ noun: "Deck" });
    expect(sanitizeOutputOverrides({ icon: "notAnIcon" })).toBeUndefined();
    expect(sanitizeOutputOverrides({ noun: "x".repeat(41) })).toBeUndefined();
  });

  it("derives a stable, valid grouping id without asking the admin for one", () => {
    expect(defaultOutputFormatId("acme.contract-memo")).toBe("acme.contract-memo");
    let long = "acme." + "contract-".repeat(8);
    expect(defaultOutputFormatId(long)).toBe(defaultOutputFormatId(long));
    expect(defaultOutputFormatId(long)).toHaveLength(40);
    expect(defaultOutputFormatId(long)).not.toBe(defaultOutputFormatId(long + "other"));
  });
});

describe("admin config site logo", () => {
  it("defaults legacy and malformed values to no custom logo", () => {
    expect(parseAdminConfig("{}").siteLogoConfigured).toBe(false);
    expect(parseAdminConfig('{"siteLogoConfigured":"yes"}').siteLogoConfigured).toBe(false);
  });

  it("round-trips configured logo state", () => {
    let config = parseAdminConfig('{"siteLogoConfigured":true}');
    expect(config.siteLogoConfigured).toBe(true);
    expect(parseAdminConfig(serializeAdminConfig(config))).toEqual(config);
  });
});

describe("admin config gateway models", () => {
  let added: GatewayModel =
      { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 500000 };

  it("defaults to no mode overrides and no added models", () => {
    for (let stored of ["{}", '{"modelModes":"hidden","addedModels":{"id":"x"}}',
        '{"modelModes":null,"addedModels":null}']) {
      let config = parseAdminConfig(stored);
      expect(config.modelModes).toStrictEqual({});
      expect(config.addedModels).toStrictEqual([]);
    }
  });

  it("drops mode overrides that are not modes", () => {
    let config = parseAdminConfig(JSON.stringify({
      modelModes: { a: "hidden", b: "disabled", c: "enabled", d: "optional", e: 3, f: null, g: {} },
    }));
    expect(config.modelModes).toStrictEqual({ a: "hidden", b: "disabled", c: "enabled" });
  });

  // A mode assigned to `__proto__` on an ordinary object is silently lost, and an object assigned
  // there would become the prototype every lookup falls through to.
  it("keeps a __proto__ override as an ordinary entry", () => {
    let config = parseAdminConfig(
        '{"modelModes":{"__proto__":"disabled","a":"hidden","constructor":"disabled"}}');
    expect(Object.getPrototypeOf(config.modelModes)).toBe(Object.prototype);
    expect(Object.entries(config.modelModes)).toEqual(
        [["__proto__", "disabled"], ["a", "hidden"], ["constructor", "disabled"]]);
    expect(parseAdminConfig(serializeAdminConfig(config)).modelModes)
        .toStrictEqual(config.modelModes);

    let polluted = parseAdminConfig('{"modelModes":{"__proto__":{"a":"disabled"}}}');
    expect(Object.getPrototypeOf(polluted.modelModes)).toBe(Object.prototype);
    expect(polluted.modelModes.a).toBeUndefined();
  });

  it("drops malformed added models rather than the whole list", () => {
    let config = parseAdminConfig(JSON.stringify({
      addedModels: [
        { ...added, id: "  claude-test  ", name: "  Claude Test  " },
        "nonsense",
        null,
        { ...added, id: "no-provider", provider: undefined },
        { ...added, id: "unknown-provider", provider: "mistral" },
        { ...added, id: "inherited-provider", provider: "constructor" },
        { ...added, id: " " },
        { ...added, id: "x".repeat(201) },
        { ...added, id: "numeric-name", name: 5 },
        { ...added, id: "blank-name", name: "" },
        { ...added, id: "no-window", contextWindow: undefined },
        { ...added, id: "fractional-window", contextWindow: 1.5 },
        { ...added, id: "string-window", contextWindow: "1000" },
        { ...added, id: "zero-output", outputLimit: 0 },
        { ...added, id: "with-output", provider: "cloudflare", outputLimit: 8000 },
      ],
    }));

    expect(config.addedModels).toStrictEqual([
      added,
      { ...added, id: "with-output", provider: "cloudflare", outputLimit: 8000 },
    ]);
  });

  // Gateway models are looked up by id alone, so a second entry under one id could never be used.
  it("keeps only the first added model under an id", () => {
    let config = parseAdminConfig(JSON.stringify({
      addedModels: [
        added,
        { ...added, id: "other" },
        { ...added, id: " claude-test ", provider: "openai", name: "Second" },
      ],
    }));
    expect(config.addedModels).toStrictEqual([added, { ...added, id: "other" }]);
  });

  it("builds an added model from its own fields only", () => {
    expect(sanitizeAddedModel({ ...added, outputLimit: 8000, apiToken: "secret", mode: "hidden" }))
        .toStrictEqual({ ...added, outputLimit: 8000 });
    expect(sanitizeAddedModel([added])).toBeUndefined();
  });

  it("keeps the model an added model behaves like, trimmed, and reads a blank one as absent",
      () => {
    expect(sanitizeAddedModel({ ...added, behavesLike: "  claude-opus-5-5 " }))
        .toStrictEqual({ ...added, behavesLike: "claude-opus-5-5" });
    for (let behavesLike of ["", "   ", undefined, null, 5]) {
      expect(sanitizeAddedModel({ ...added, behavesLike })).toStrictEqual(added);
    }
    expect(sanitizeAddedModel({ ...added, behavesLike: "x".repeat(200) })?.behavesLike)
        .toHaveLength(200);
    expect(sanitizeAddedModel({ ...added, behavesLike: "x".repeat(201) })).toBeUndefined();

    let config = parseAdminConfig(JSON.stringify(
        { addedModels: [{ ...added, behavesLike: " claude-opus-5-5 " }] }));
    expect(config.addedModels).toStrictEqual([{ ...added, behavesLike: "claude-opus-5-5" }]);
  });

  it("keeps the well-formed part of what an added model is stated to do", () => {
    let stated = (capabilities: unknown) => sanitizeAddedModel({ ...added, capabilities });
    expect(stated({ imageInput: false, reasoningLevels: ["off", "high"], strictTools: true }))
        .toStrictEqual(
            { ...added, capabilities: { imageInput: false, reasoningLevels: ["off", "high"] } });
    // Each level once, least to most.
    expect(stated({ reasoningLevels: ["max", "low", "off", "low", "max"] }))
        .toStrictEqual({ ...added, capabilities: { reasoningLevels: ["off", "low", "max"] } });
    // No level states a model that does no reasoning, which is not the same as stating nothing.
    expect(stated({ reasoningLevels: [] }))
        .toStrictEqual({ ...added, capabilities: { reasoningLevels: [] } });

    // A malformed field is one not stated, and the rest is kept.
    expect(stated({ imageInput: "yes", reasoningLevels: ["high"] }))
        .toStrictEqual({ ...added, capabilities: { reasoningLevels: ["high"] } });
    for (let reasoningLevels of [["high", "extreme"], "high", { 0: "high" }, [["high"]], null]) {
      expect(stated({ imageInput: true, reasoningLevels }))
          .toStrictEqual({ ...added, capabilities: { imageInput: true } });
    }
    // With nothing well-formed in it there is no statement, and the model is added all the same.
    for (let capabilities of [{}, { imageInput: 1, reasoningLevels: ["extreme"] }, null, "image",
        ["high"], true, undefined]) {
      expect(stated(capabilities)).toStrictEqual(added);
    }
  });

  it("round-trips what an added model is stated to do", () => {
    let model: GatewayModel = {
      ...added, behavesLike: "claude-opus-5-5",
      capabilities: { imageInput: true, reasoningLevels: ["low", "xhigh"] },
    };
    let config = parseAdminConfig(serializeAdminConfig(
        { ...DEFAULT_ADMIN_CONFIG, addedModels: [model, { ...added, id: "plain" }] }));
    expect(config.addedModels).toStrictEqual([model, { ...added, id: "plain" }]);

    let stored = parseAdminConfig(JSON.stringify({ addedModels: [
      { ...added, capabilities: { imageInput: "no", reasoningLevels: ["high", "off", "high"] } },
    ] }));
    expect(stored.addedModels)
        .toStrictEqual([{ ...added, capabilities: { reasoningLevels: ["off", "high"] } }]);
  });

  it("defaults to no model settings and no default reasoning level", () => {
    expect(DEFAULT_ADMIN_CONFIG.modelSettings).toStrictEqual({});
    expect(DEFAULT_ADMIN_CONFIG.defaultReasoning).toBeNull();
    for (let stored of ["{}", '{"modelSettings":"high","defaultReasoning":"extreme"}',
        '{"modelSettings":null,"defaultReasoning":null}', '{"defaultReasoning":3}',
        '{"defaultReasoning":["high"]}']) {
      let config = parseAdminConfig(stored);
      expect(config.modelSettings, stored).toStrictEqual({});
      expect(config.defaultReasoning, stored).toBeNull();
    }
  });

  it("keeps the well-formed part of each model's settings, and no empty entry", () => {
    let config = parseAdminConfig(JSON.stringify({
      modelSettings: {
        both: { reasoning: "high", compactionInputBudget: 1000 },
        "bad-level": { reasoning: "extreme", compactionInputBudget: 1000 },
        "fractional-budget": { reasoning: "low", compactionInputBudget: 1.5 },
        "foreign-field": { reasoning: "off", mode: "hidden" },
        "nothing-valid": { reasoning: "nope", compactionInputBudget: 0 },
        "negative-budget": { compactionInputBudget: -5 },
        "string-budget": { compactionInputBudget: "1000" },
        empty: {},
        nothing: null,
        text: "high",
        list: ["high"],
      },
    }));
    expect(config.modelSettings).toStrictEqual({
      both: { reasoning: "high", compactionInputBudget: 1000 },
      "bad-level": { compactionInputBudget: 1000 },
      "fractional-budget": { reasoning: "low" },
      "foreign-field": { reasoning: "off" },
    });
  });

  it("reads a model's settings as their well-formed part, or as nothing", () => {
    expect(sanitizeModelSettings({ reasoning: "max", compactionInputBudget: 1 }))
        .toStrictEqual({ reasoning: "max", compactionInputBudget: 1 });
    expect(sanitizeModelSettings({ reasoning: "max", compactionInputBudget: 2 ** 53 }))
        .toStrictEqual({ reasoning: "max" });
    for (let value of [{}, { reasoning: undefined }, { compactionInputBudget: NaN }, null, "max"]) {
      expect(sanitizeModelSettings(value)).toBeUndefined();
    }
  });

  it("keeps a __proto__ model's settings as an ordinary entry", () => {
    let config = parseAdminConfig(
        '{"modelSettings":{"__proto__":{"reasoning":"low"},"a":{"reasoning":"high"}}}');
    expect(Object.getPrototypeOf(config.modelSettings)).toBe(Object.prototype);
    expect(Object.entries(config.modelSettings)).toEqual(
        [["__proto__", { reasoning: "low" }], ["a", { reasoning: "high" }]]);
    expect(parseAdminConfig(serializeAdminConfig(config)).modelSettings)
        .toStrictEqual(config.modelSettings);
  });

  it("round-trips model settings and the default reasoning level", () => {
    let modelSettings = { a: { reasoning: "xhigh" as const }, b: { compactionInputBudget: 5000 } };
    let config = parseAdminConfig(serializeAdminConfig(
        { ...DEFAULT_ADMIN_CONFIG, modelSettings, defaultReasoning: "minimal" }));
    expect(config.modelSettings).toStrictEqual(modelSettings);
    expect(config.defaultReasoning).toBe("minimal");
    expect(parseAdminConfig('{"defaultReasoning":"off"}').defaultReasoning).toBe("off");
  });

  it("round-trips modes and added models", () => {
    let config = parseAdminConfig(serializeAdminConfig(
        { ...DEFAULT_ADMIN_CONFIG, modelModes: { a: "disabled" }, addedModels: [added] }));
    expect(config.modelModes).toStrictEqual({ a: "disabled" });
    expect(config.addedModels).toStrictEqual([added]);
  });

  it("keeps the added providers that are providers, once each", () => {
    expect(DEFAULT_ADMIN_CONFIG.addedProviders).toStrictEqual([]);
    for (let stored of ["{}", '{"addedProviders":null}', '{"addedProviders":"openai"}',
        '{"addedProviders":{"0":"openai"}}', '{"addedProviders":[]}']) {
      expect(parseAdminConfig(stored).addedProviders, stored).toStrictEqual([]);
    }

    let config = parseAdminConfig(JSON.stringify({
      addedProviders: ["openai", "mistral", "google", 3, null, "openai", ["anthropic"],
          "constructor", " anthropic", "ollama"],
    }));
    // Whether AI Gateway can route a provider is not a matter of shape: ollama is one.
    expect(config.addedProviders).toStrictEqual(["openai", "google", "ollama"]);
    expect(parseAdminConfig(serializeAdminConfig(config)).addedProviders)
        .toStrictEqual(config.addedProviders);
  });

  it("lets users add their own models unless that is stored as off", () => {
    expect(DEFAULT_ADMIN_CONFIG.userModelsEnabled).toBe(true);
    expect(parseAdminConfig(null).userModelsEnabled).toBe(true);
    for (let stored of ["{}", '{"userModelsEnabled":null}', '{"userModelsEnabled":"false"}',
        '{"userModelsEnabled":0}', '{"userModelsEnabled":true}']) {
      expect(parseAdminConfig(stored).userModelsEnabled, stored).toBe(true);
    }
    expect(parseAdminConfig('{"userModelsEnabled":false}').userModelsEnabled).toBe(false);
    expect(parseAdminConfig(serializeAdminConfig(
        { ...DEFAULT_ADMIN_CONFIG, userModelsEnabled: false })).userModelsEnabled).toBe(false);
  });

  it("suggests models from models.dev only when that is stored as on", () => {
    expect(DEFAULT_ADMIN_CONFIG.modelsDevSuggestions).toBe(false);
    expect(parseAdminConfig(null).modelsDevSuggestions).toBe(false);
    for (let stored of ["{}", '{"modelsDevSuggestions":null}', '{"modelsDevSuggestions":"true"}',
        '{"modelsDevSuggestions":1}', '{"modelsDevSuggestions":false}']) {
      expect(parseAdminConfig(stored).modelsDevSuggestions, stored).toBe(false);
    }
    expect(parseAdminConfig('{"modelsDevSuggestions":true}').modelsDevSuggestions).toBe(true);
    expect(parseAdminConfig(serializeAdminConfig(
        { ...DEFAULT_ADMIN_CONFIG, modelsDevSuggestions: true })).modelsDevSuggestions).toBe(true);
  });
});
