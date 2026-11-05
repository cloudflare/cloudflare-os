import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES, DEFAULT_UPDATE_MINIMUM_AGE_HOURS, DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS, MAX_UPDATE_CHECK_INTERVAL_MINUTES, MAX_UPDATE_HOURS, type GatewayModel, DEFAULT_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_AUDIT_RETENTION_DAYS } from "@gadgets/workshop-shared/api";
import { adminConfigSeed, changesModelSettings, defaultOutputFormatId, effectiveAdminConfig, isUpdateCheckInterval, isUpdateHours, normalizeAdminConfig, parseAdminConfig, parseAdminConfigSeed, readAdminConfig, parseRestrictedWebFetchHosts, reorderFormats, resolveFormatOutput, sanitizeAddedModel, sanitizeModelSettings, sanitizeOutputOverrides, serializeAdminConfig, diffAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig, type FormatCuration } from "../src/storage-schema/admin-settings-storage.js";

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

describe("parseRestrictedWebFetchHosts", () => {
  it("stores trimmed, lowercase hosts once each, without blanks", () => {
    expect(parseRestrictedWebFetchHosts([" Docs.Example.com ", "", "docs.example.com", "api.example.com"]))
      .toEqual(["docs.example.com", "api.example.com"]);
  });

  it("refuses entries no URL's host could match", () => {
    for (let entry of [
      "https://docs.example.com",
      "*.example.com",
      "bücher.example", // `URL.host` holds an IDN only as punycode
    ]) {
      expect(() => parseRestrictedWebFetchHosts(["docs.example.com", entry]), entry).toThrow(/is not a host name/);
    }
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
    // Allowed models are kept trimmed and once each, less the malformed; an empty list is none.
    expect(sanitizeModelSettings({
      allowedModels: [
        " anthropic/* ", "openai/gpt-6-luna", "anthropic/*", "claude opus", "a,b/c", 3,
      ],
    })).toStrictEqual({ allowedModels: ["anthropic/*", "openai/gpt-6-luna"] });
    for (let value of [{}, { reasoning: undefined }, { compactionInputBudget: NaN }, null, "max",
        { allowedModels: [] }, { allowedModels: ["anthropic"] },
        { allowedModels: "anthropic/*" }]) {
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

describe("admin config update notice", () => {
  const HOURS = ["updateMinimumAgeHours", "updateNoticeSnoozeHours"] as const;

  it("checks for updates by itself, at the default hours, unless stored otherwise", () => {
    expect(DEFAULT_ADMIN_CONFIG).toMatchObject({
      updateChecksEnabled: true,
      updateCheckIntervalMinutes: DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES,
      updateMinimumAgeHours: DEFAULT_UPDATE_MINIMUM_AGE_HOURS,
      updateNoticeSnoozeHours: DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS,
    });
    // A config, in the Durable Object or in KV, stored before the settings existed.
    for (let config of [normalizeAdminConfig({ signupsEnabled: false }), parseAdminConfig("{}"),
        parseAdminConfig(null)]) {
      expect(config).toMatchObject({
        updateChecksEnabled: true, updateCheckIntervalMinutes: 60, updateMinimumAgeHours: 24,
        updateNoticeSnoozeHours: 24,
      });
    }
  });

  it("reads anything but a stored boolean as automatic checks on", () => {
    for (let stored of [null, "false", 0, true]) {
      expect(normalizeAdminConfig({ updateChecksEnabled: stored as boolean }).updateChecksEnabled,
          String(stored)).toBe(true);
    }
    expect(normalizeAdminConfig({ updateChecksEnabled: false }).updateChecksEnabled).toBe(false);
    expect(parseAdminConfig(serializeAdminConfig(
        { ...DEFAULT_ADMIN_CONFIG, updateChecksEnabled: false })).updateChecksEnabled).toBe(false);
  });

  it.each(HOURS)("reads a %s that is not a whole number of hours in range as the default",
      field => {
    for (let stored of [1.5, -1, MAX_UPDATE_HOURS + 1, NaN, Infinity, "12", null]) {
      expect(normalizeAdminConfig({ [field]: stored as number })[field], String(stored)).toBe(24);
      expect(isUpdateHours(stored), String(stored)).toBe(false);
    }
  });

  it.each(HOURS)("keeps a stored %s from 0 to the maximum", field => {
    for (let stored of [0, 1, 48, MAX_UPDATE_HOURS]) {
      expect(normalizeAdminConfig({ [field]: stored })[field]).toBe(stored);
      let kv = serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, [field]: stored });
      expect(parseAdminConfig(kv)[field]).toBe(stored);
      expect(isUpdateHours(stored)).toBe(true);
    }
  });

  it("reads a check interval that is not a whole number of minutes in range as the default", () => {
    for (let stored of [1.5, 0, -1, MAX_UPDATE_CHECK_INTERVAL_MINUTES + 1, NaN, Infinity, "12",
        null]) {
      expect(normalizeAdminConfig({ updateCheckIntervalMinutes: stored as number })
          .updateCheckIntervalMinutes, String(stored)).toBe(60);
      expect(isUpdateCheckInterval(stored), String(stored)).toBe(false);
    }
  });

  it("keeps a stored check interval from 1 minute to the maximum", () => {
    for (let stored of [1, 15, 360, MAX_UPDATE_CHECK_INTERVAL_MINUTES]) {
      expect(normalizeAdminConfig({ updateCheckIntervalMinutes: stored })
          .updateCheckIntervalMinutes).toBe(stored);
      let kv = serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, updateCheckIntervalMinutes: stored });
      expect(parseAdminConfig(kv).updateCheckIntervalMinutes).toBe(stored);
      expect(isUpdateCheckInterval(stored)).toBe(true);
    }
  });
});

describe("ADMIN_CONFIG_SEED", () => {
  const SEED = {
    modelModes: { "claude-fable-5-1": "hidden" },
    modelSettings: { "@cf/zai-org/glm-5.2": { reasoning: "high", compactionInputBudget: 200000 } },
    addedModels: [
      { provider: "cloudflare", id: "@cf/test/added", name: "Added", contextWindow: 131072 },
    ],
    defaultReasoning: "medium",
    userModelsEnabled: false,
    modelsDevSuggestions: true,
  } as const;
  const seeded = (seed: unknown = SEED) =>
      effectiveAdminConfig(null, adminConfigSeed({ ADMIN_CONFIG_SEED: JSON.stringify(seed) }));

  it("is nothing while unset or empty", () => {
    expect(effectiveAdminConfig(null, adminConfigSeed({}))).toEqual(DEFAULT_ADMIN_CONFIG);
    expect(effectiveAdminConfig(null, adminConfigSeed({ ADMIN_CONFIG_SEED: "" })))
        .toEqual(DEFAULT_ADMIN_CONFIG);
  });

  it("sets the Models tab's fields over the defaults, as a secret's string or a JSON var", () => {
    for (let ADMIN_CONFIG_SEED of [JSON.stringify(SEED), structuredClone(SEED)]) {
      expect(effectiveAdminConfig(null, adminConfigSeed({ ADMIN_CONFIG_SEED })))
          .toEqual({ ...DEFAULT_ADMIN_CONFIG, ...SEED });
    }
  });

  it("checks the values the way a stored config's are checked", () => {
    let config = seeded({
      modelModes: { kept: "disabled", dropped: "sometimes" },
      defaultReasoning: "loud",
    });
    expect(config.modelModes).toEqual({ kept: "disabled" });
    expect(config.defaultReasoning).toBeNull();
  });

  it("is ignored whole when it sets a field outside the Models tab", () => {
    // Half of a seed is never applied: a typo in one field name must not leave the rest in force.
    expect(parseAdminConfigSeed(JSON.stringify({ ...SEED, signupsEnabled: false }))).toEqual({});
    expect(parseAdminConfigSeed(JSON.stringify({ ...SEED, modelSetting: {} }))).toEqual({});
    expect(parseAdminConfigSeed(JSON.stringify({ ...SEED, modelsSaved: true }))).toEqual({});
  });

  it("is ignored when it is not a JSON object", () => {
    for (let raw of ["{", "[]", "null", "\"text\"", "3", [SEED]]) {
      expect(parseAdminConfigSeed(raw), JSON.stringify(raw)).toEqual({});
    }
  });

  it("still decides a stored config's model fields until an admin changes one", () => {
    // What promoting the bundled formats on the first request stores: other settings, written
    // over the seeded config, with modelsSaved still false.
    let bootstrapped = { ...seeded(), siteName: "acme" };
    let newSeed = { modelSettings: { "@cf/zai-org/glm-5.2": { reasoning: "max" } } };
    let config = effectiveAdminConfig(bootstrapped, newSeed);
    expect(config.siteName).toBe("acme");
    expect(config.modelSettings).toEqual(newSeed.modelSettings);
    // A field the old seed set and the new one leaves out is back to its default, not left over.
    expect(config.addedModels).toEqual([]);
    expect(config.modelModes).toEqual({});
  });

  it("decides nothing once an admin has changed a model setting, or in a config stored before it existed", () => {
    let saved = { ...seeded(), modelsSaved: true, modelModes: {} };
    expect(effectiveAdminConfig(saved, SEED).modelModes).toEqual({});
    // A legacy config has no flag at all.
    let { modelsSaved: _, ...legacy } = { ...DEFAULT_ADMIN_CONFIG, siteName: "acme" };
    let config = effectiveAdminConfig(legacy, SEED);
    expect(config.modelsSaved).toBe(true);
    expect(config.modelSettings).toEqual({});
  });

  it("ends with a change to any Models tab field, compared by value", () => {
    let config = seeded({ ...SEED, modelSettings: {
      ...SEED.modelSettings, "claude-opus-5-5": { compactionInputBudget: 300000 } } });
    expect(changesModelSettings(config, { ...config, siteName: "acme" })).toBe(false);
    // Rebuilt in a different key order, but the same settings.
    let reordered = { ...config, modelSettings: Object.fromEntries(
        Object.entries(config.modelSettings).toReversed()) };
    expect(Object.keys(reordered.modelSettings)).not.toEqual(Object.keys(config.modelSettings));
    expect(changesModelSettings(config, reordered)).toBe(false);
    expect(changesModelSettings(config, { ...config, modelModes: {} })).toBe(true);
    expect(changesModelSettings(config, { ...config, userModelsEnabled: true })).toBe(true);
  });

  it("is what the KV hot path reads, under the same rules", async () => {
    const ADMIN_CONFIG_SEED = JSON.stringify(SEED);
    const withMirror = (value: string | null) => ({
      ADMIN_CONFIG_SEED, BLUEPRINTS: { get: async () => value },
    }) as unknown as Cloudflare.Env;

    expect((await readAdminConfig(withMirror(null))).modelSettings).toEqual(SEED.modelSettings);
    let bootstrapped = serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, siteName: "acme" });
    expect((await readAdminConfig(withMirror(bootstrapped))).modelSettings)
        .toEqual(SEED.modelSettings);
    let saved = serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, modelsSaved: true });
    expect((await readAdminConfig(withMirror(saved))).modelSettings).toEqual({});
  });
});

describe("admin config audit retention", () => {
  it("defaults the audit retention", () => {
    let config = parseAdminConfig(null);
    expect(config.adminAuditRetentionDays).toBe(DEFAULT_ADMIN_AUDIT_RETENTION_DAYS);
    expect(DEFAULT_ADMIN_CONFIG.adminAuditRetentionDays).toBe(90);
  });

  // The environment's bound is applied where the choice is enforced, never here, so a stored
  // choice outside today's bound is kept for when it changes.
  it("keeps a stored choice whatever the environment's bound", () => {
    for (let days of [1, 7, 365, MAX_ADMIN_AUDIT_RETENTION_DAYS]) {
      expect(normalizeAdminConfig({ adminAuditRetentionDays: days }).adminAuditRetentionDays)
          .toBe(days);
    }
  });

  it("reads a malformed stored choice as the default", () => {
    for (let stored of [0, -1, 1.5, MAX_ADMIN_AUDIT_RETENTION_DAYS + 1, NaN, "30", null]) {
      expect(normalizeAdminConfig({ adminAuditRetentionDays: stored as number })
          .adminAuditRetentionDays, String(stored)).toBe(90);
    }
  });
});

function configWith(patch: Partial<AdminConfig> = {}): AdminConfig {
  return { ...structuredClone(DEFAULT_ADMIN_CONFIG), ...patch };
}

function formats(count: number): FormatCuration[] {
  return Array.from({ length: count }, (_, i) => ({ blueprintId: `bp-${i}`, enabled: true }));
}

function addedModel(id: string): GatewayModel {
  return { provider: "anthropic", id, name: id, contextWindow: 1000 };
}

describe("diffAdminConfig", () => {
  it("is empty when nothing differs", () => {
    expect(diffAdminConfig(configWith(), configWith())).toEqual([]);
  });

  it("records scalars, strings as themselves and the rest as JSON", () => {
    expect(diffAdminConfig(configWith(), configWith({ siteName: "Acme \"OS\"" })))
        .toEqual([{ setting: "siteName", before: "", after: "Acme \"OS\"" }]);
    expect(diffAdminConfig(configWith(), configWith({ signupsEnabled: false, adminAuditRetentionDays: 120 })))
        .toEqual([
          { setting: "signupsEnabled", before: "true", after: "false" },
          { setting: "adminAuditRetentionDays", before: "90", after: "120" },
        ]);
    expect(diffAdminConfig(configWith(), configWith({ defaultReasoning: "high" })))
        .toEqual([{ setting: "defaultReasoning", before: "null", after: "high" }]);
  });

  it("records long instructions edited at the end whole", () => {
    let before = "i".repeat(8_000);
    let after = `${"i".repeat(7_990)}0123456789`;
    expect(diffAdminConfig(configWith({ instanceInstructions: before }),
        configWith({ instanceInstructions: after })))
        .toEqual([{ setting: "instanceInstructions", before, after }]);
  });

  it("records a map one key at a time", () => {
    expect(diffAdminConfig(configWith(), configWith({ banner: { text: "Hi", color: "warning" } })))
        .toEqual([
          { setting: "banner", key: "color", before: "info", after: "warning" },
          { setting: "banner", key: "text", before: "", after: "Hi" },
        ]);
    expect(diffAdminConfig(configWith(), configWith({ banner: { text: "Hi", color: "info" } })))
        .toEqual([{ setting: "banner", key: "text", before: "", after: "Hi" }]);
  });

  it("records model modes per key, own keys only", () => {
    let before = configWith({ modelModes: { a: "disabled", c: "hidden" } });
    let modes = JSON.parse('{"b": "disabled", "c": "hidden", "__proto__": "hidden", ' +
        '"constructor": "disabled"}');
    let changes = diffAdminConfig(before, configWith({ modelModes: modes }));
    expect(changes).toEqual([
      { setting: "modelModes", key: "__proto__", after: "hidden" },
      { setting: "modelModes", key: "a", before: "disabled" },
      { setting: "modelModes", key: "b", after: "disabled" },
      { setting: "modelModes", key: "constructor", after: "disabled" },
    ]);
  });

  it("records model settings and disabled resources per key, as JSON", () => {
    expect(diffAdminConfig(configWith({ modelSettings: { m: { reasoning: "low" } } }),
        configWith({ modelSettings: { m: { reasoning: "high", compactionInputBudget: 5000 } } })))
        .toEqual([{
          setting: "modelSettings", key: "m", before: '{"reasoning":"low"}',
          after: '{"compactionInputBudget":5000,"reasoning":"high"}',
        }]);
    expect(diffAdminConfig(configWith({ disabledResources: { github: ["repo"] } }),
        configWith({ disabledResources: { github: ["repo", "issue"], gitlab: ["project"] } })))
        .toEqual([
          { setting: "disabledResources", key: "github", before: '["repo"]', after: '["repo","issue"]' },
          { setting: "disabledResources", key: "gitlab", after: '["project"]' },
        ]);
  });

  it("records one format entry, not the whole list", () => {
    let before = formats(30);
    let after = structuredClone(before);
    after[29].agentHint = "prefer for memos";
    expect(diffAdminConfig(configWith({ formats: before }), configWith({ formats: after }))).toEqual([{
      setting: "formats", key: "bp-29", before: '{"blueprintId":"bp-29","enabled":true}',
      after: '{"agentHint":"prefer for memos","blueprintId":"bp-29","enabled":true}',
    }]);
  });

  it("records an added or removed format alone, and a reorder as the id lists", () => {
    let three = formats(3);
    expect(diffAdminConfig(configWith({ formats: three }), configWith({ formats: three.slice(0, 2) })))
        .toEqual([{ setting: "formats", key: "bp-2", before: '{"blueprintId":"bp-2","enabled":true}' }]);
    expect(diffAdminConfig(configWith({ formats: three }), configWith({ formats: formats(4) })))
        .toEqual([{ setting: "formats", key: "bp-3", after: '{"blueprintId":"bp-3","enabled":true}' }]);
    expect(diffAdminConfig(configWith({ formats: three }),
        configWith({ formats: [three[2], three[0], three[1]] })))
        .toEqual([{
          setting: "formats", before: '["bp-0","bp-1","bp-2"]', after: '["bp-2","bp-0","bp-1"]',
        }]);
  });

  it("records one added model entry at a time", () => {
    let sixty = Array.from({ length: 60 }, (_, i) => addedModel(`m-${i}`));
    let appended = diffAdminConfig(configWith({ addedModels: sixty }),
        configWith({ addedModels: [...sixty, addedModel("new")] }));
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ setting: "addedModels", key: "new" });
    expect(appended[0]).not.toHaveProperty("before");
    let removed = diffAdminConfig(configWith({ addedModels: sixty }),
        configWith({ addedModels: sixty.filter(m => m.id !== "m-7") }));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ setting: "addedModels", key: "m-7" });
    expect(removed[0]).not.toHaveProperty("after");
  });

  it("records a list without ids whole", () => {
    expect(diffAdminConfig(configWith(), configWith({ disabledGatekeepers: ["x", "y"] })))
        .toEqual([{ setting: "disabledGatekeepers", before: "[]", after: '["x","y"]' }]);
  });

  it("ignores the order objects were built in", () => {
    expect(diffAdminConfig(
        configWith({ modelSettings: { m: { reasoning: "low", compactionInputBudget: 5 } } }),
        configWith({ modelSettings: { m: { compactionInputBudget: 5, reasoning: "low" } } })))
        .toEqual([]);
  });

  it("excerpts an entry past the value cap, and cuts an over-long key", () => {
    let pattern = "p".repeat(12_000);
    let [change] = diffAdminConfig(configWith(), configWith({ disabledResources: { v: [pattern] } }));
    expect(change.excerpt).toEqual({ offset: 0, afterLength: pattern.length + 4 });

    let [cut] = diffAdminConfig(configWith(),
        configWith({ disabledResources: { ["k".repeat(300)]: ["x"] } }));
    expect(cut.key).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(cut.key!.endsWith("…")).toBe(true);
  });
});
