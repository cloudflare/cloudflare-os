import { afterAll, beforeAll, expect, it } from "vitest";
import {
  SUGGESTED_MODELS, isClassifierModel, type AdminModel, type GatewayModel, type GatewayModelMode,
} from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, logIn, nextUsernames, signUp, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

const LOG_URL = "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai-gateway/gateways/" +
    "platform-gateway/logs/scripted-log-id";

// One reply for each chat turn the cases below run, in order, then one for each model test and
// one for each provider test.
const model = scriptedChatCompletions([
  { text: "Charged reply." }, { text: "Built-in reply." }, { text: "Default-level reply." },
  { text: "Own-level reply." },
  { text: "OK" }, { error: { status: 401, message: "Invalid gateway credentials." } },
  { text: "OK" }, { error: { status: 401, message: "Invalid gateway credentials." } },
]);
let logReads = 0;
const network = new NetworkInterceptor({
  handlers: [async (url, method, headers, request) => {
    if (method === "GET" && url.href === LOG_URL) {
      // Logs land after the response, so the first read misses and the Workshop must retry.
      return logReads++ === 0
        ? new Response("not yet", { status: 404 })
        : Response.json({ success: true, result: { cost: 1.25 } });
    }
    const response = await model.handler(url, method, headers, request);
    return response && new Response(response.body, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), "cf-aig-log-id": "scripted-log-id" },
    });
  }],
});
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    // The HTTPS transport reads the log with a plain fetch the interceptor answers.
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
        CF_AI_GATEWAY_API_TOKEN: "read-run-token",
        CF_AI_GATEWAY_USE_BINDING: "false",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("a chat is charged the AI Gateway log's cost in place of the estimate", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("gatewaycost")[0]!);
  using ws = await api.newGadget();

  const chatId = await ws.newChat("What does this cost?", SCRIPTED_MODEL_ID);
  await waitForIdleChat(ws, chatId);
  await waitFor("the gateway cost", async () =>
    (await ws.listChats()).find(chat => chat.id === chatId)?.totalCost === 1.25 || null);
  expect((await ws.getMetadata()).totalCost).toBe(1.25);
  expect(logReads).toBe(2);
});

const ADDED: GatewayModel = {
  provider: "cloudflare", id: "@cf/test/added", name: "Added (Workers AI)",
  contextWindow: 100000, outputLimit: 8000,
};
// As the admin is shown it: a model the runtime has no entry for, which it takes for one that
// does no reasoning, with the prompt budget its own limits leave.
const ADDED_VIEW = {
  ...ADDED, mode: "enabled", defaultMode: "enabled", added: true,
  reasoningLevels: [], builtInReasoning: null, builtInCompactionInputBudget: 92000,
  maxCompactionInputBudget: 92000, runtimeKnown: false,
};
const disabledMessage = (name: string) =>
    `The "${name}" model is disabled on this deployment by an administrator.`;
const ADDING_REFUSED = "Adding your own models is disabled on this deployment by an administrator.";
const cantBeUsedMessage = (name: string) => `The "${name}" model can't be used: ` +
    "adding your own models is disabled on this deployment by an administrator.";
const ids = (models: readonly { id: string }[]) => models.map(candidate => candidate.id);
// The IDs of the gateway models listModels() offers: the enabled ones, but no classifier, which
// can't chat.
const chatIds = (models: readonly AdminModel[]) => ids(models.filter(candidate =>
    candidate.mode === "enabled" && !isClassifierModel(candidate.provider, candidate.id)));
// A provider the gateway serves, as the admin is shown it while it is off.
const offProvider = (provider: string) => ({ provider, needsApiToken: false });

// The cases below share one deployment, whose admin signs up once and logs in after that.
let adminSignedUp = false;
function adminSession(publicApi: Parameters<typeof signUp>[0]) {
  const session = adminSignedUp
      ? logIn(publicApi, ADMIN_USERNAME) : signUp(publicApi, ADMIN_USERNAME);
  adminSignedUp = true;
  return session;
}

it("an admin's modes, added models and say over users' own decide which models run", async () => {
  using adminPublic = connect(harness.url);
  using adminUser = await adminSession(adminPublic);
  using admin = await adminUser.getAdminApi();
  if (admin === null) throw new Error("The deployment admin API was unavailable");
  const gatewayModels = async () => {
    const view = (await admin.getSettings()).gatewayModels;
    if (view === undefined) throw new Error("The admin settings listed no gateway models");
    return view;
  };

  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("gatewaymodes")[0]!);
  using ws = await api.newGadget();

  // Every model starts in its default mode: the catalog's, on the one provider this gateway
  // enables.
  const before = await gatewayModels();
  expect(before.providers).toEqual(["cloudflare"]);
  expect(before.models.filter(candidate => candidate.provider !== "cloudflare" ||
      candidate.added || candidate.mode !== candidate.defaultMode)).toEqual([]);
  const scripted = before.models.find(candidate => candidate.id === SCRIPTED_MODEL_ID);
  const other = before.models.find(
      candidate => candidate.mode === "enabled" && candidate.id !== SCRIPTED_MODEL_ID);
  if (scripted?.mode !== "enabled" || other === undefined) {
    throw new Error("The gateway offers too few models for this test");
  }
  const offered = chatIds(before.models);
  expect(ids(await api.listModels())).toEqual(offered);
  expect(ids(await api.listClassifierModels()))
      .toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"]);

  // A gadget's model binding, minted while its model is still enabled. Starting a session calls
  // no provider.
  using binding = await ws.newAiModelGatekeeper(SCRIPTED_MODEL_ID);
  (await binding.openSession())[Symbol.dispose]();

  try {
    await admin.setGatewayModelMode(SCRIPTED_MODEL_ID, "disabled");
    await admin.setGatewayModelMode(other.id, "hidden");
    await admin.addGatewayModel(ADDED);

    expect(ids(await api.listModels())).toEqual(
        [...offered.filter(id => id !== SCRIPTED_MODEL_ID && id !== other.id), ADDED.id]);
    expect(await api.getAiConfig()).toEqual({
      enabled: true,
      enabledProviders: ["cloudflare"],
      builtInModelIds: [...ids(before.models), ADDED.id],
      userModelsEnabled: true,
    });
    const withMode = (id: string, mode: GatewayModelMode) => (candidate: typeof scripted) =>
        candidate.id === id ? { ...candidate, mode } : candidate;
    expect(await gatewayModels()).toEqual({
      providers: ["cloudflare"],
      providerSettings: before.providerSettings,
      models: [
        ...before.models.map(withMode(SCRIPTED_MODEL_ID, "disabled")).map(withMode(other.id, "hidden")),
        ADDED_VIEW,
      ],
      defaultReasoning: null,
      userModelsEnabled: true,
      modelsDevSuggestions: false,
    });

    // Disabled: nothing resolves it, the binding minted earlier included, and its ID stays taken.
    await expect(api.setPreferredModel(SCRIPTED_MODEL_ID))
        .rejects.toThrow(`No such model: ${SCRIPTED_MODEL_ID}`);
    await expect(ws.newChat("Is anyone there?", SCRIPTED_MODEL_ID))
        .rejects.toThrow(disabledMessage(scripted.name));
    await expect(ws.newAiModelGatekeeper(SCRIPTED_MODEL_ID))
        .rejects.toThrow(disabledMessage(scripted.name));
    await expect(binding.openSession()).rejects.toThrow(disabledMessage(scripted.name));
    await expect(api.addModel(
        { type: "agent", id: SCRIPTED_MODEL_ID, name: "Mine" },
        { provider: "cloudflare", model: SCRIPTED_MODEL_ID, apiToken: "" }))
        .rejects.toThrow(`A model with ID "${SCRIPTED_MODEL_ID}" already exists.`);

    // Hidden and added models resolve.
    await api.setPreferredModel(other.id);
    await api.setPreferredModel(ADDED.id);
    using addedBinding = await ws.newAiModelGatekeeper(ADDED.id);
    (await addedBinding.openSession())[Symbol.dispose]();
    await expect(api.deleteModel(ADDED.id))
        .rejects.toThrow(`Cannot delete built-in model "${ADDED.name}".`);

    // What the admin may not do. None of it changes anything.
    const settled = await gatewayModels();
    await expect(admin.setGatewayModelMode("no-such-model", "hidden"))
        .rejects.toThrow("No such model: no-such-model");
    await expect(admin.addGatewayModel({ ...ADDED, name: "Again" }))
        .rejects.toThrow(`"${ADDED.id}" is already an added model.`);
    await expect(admin.addGatewayModel({ ...ADDED, id: SCRIPTED_MODEL_ID }))
        .rejects.toThrow(`"${SCRIPTED_MODEL_ID}" is already a suggested model.`);
    await expect(admin.addGatewayModel({ ...ADDED, id: "new-model", provider: "anthropic" }))
        .rejects.toThrow('Provider "anthropic" is not enabled on this deployment.');
    await expect(admin.addGatewayModel({ ...ADDED, id: "new-model", provider: "ollama" }))
        .rejects.toThrow('Provider "ollama" is not served through AI Gateway.');
    await expect(admin.addGatewayModel({ ...ADDED, id: "new-model", contextWindow: 0 }))
        .rejects.toThrow("Invalid model:");
    await expect(admin.removeGatewayModel(SCRIPTED_MODEL_ID))
        .rejects.toThrow(`No such added model: ${SCRIPTED_MODEL_ID}`);
    expect(await gatewayModels()).toEqual(settled);

    // An added model is disabled like any other. Removing it forgets that along with the model,
    // so the ID starts over when it is added again.
    await admin.setGatewayModelMode(ADDED.id, "disabled");
    await expect(addedBinding.openSession()).rejects.toThrow(disabledMessage(ADDED.name));
    await admin.removeGatewayModel(ADDED.id);
    await expect(ws.newChat("Is anyone there?", ADDED.id))
        .rejects.toThrow(`No such model: ${ADDED.id}`);
    await admin.addGatewayModel(ADDED);
    expect((await gatewayModels()).models.at(-1)).toEqual(ADDED_VIEW);
    await admin.removeGatewayModel(ADDED.id);

    // Back in its default mode, a model is as it was before the admin touched it.
    await admin.setGatewayModelMode(SCRIPTED_MODEL_ID, "enabled");
    await admin.setGatewayModelMode(other.id, "enabled");
    expect(await gatewayModels()).toEqual(before);
    expect(ids(await api.listModels())).toEqual(offered);
    (await binding.openSession())[Symbol.dispose]();

    // A model a user adds runs through the deployment's gateway too, until the admin makes the
    // gateway's models the only ones.
    const mine = { type: "agent" as const, id: "gatewaymodes-mine", name: "Mine" };
    const mineConfig = { provider: "cloudflare" as const, model: "@cf/test/mine", apiToken: "" };
    await api.addModel(mine, mineConfig);
    expect(ids(await api.listModels())).toEqual([...offered, mine.id]);
    using mineBinding = await ws.newAiModelGatekeeper(mine.id);
    (await mineBinding.openSession())[Symbol.dispose]();

    await admin.setUserModelsEnabled(false);
    expect(await gatewayModels()).toEqual({ ...before, userModelsEnabled: false });
    expect(await api.getAiConfig()).toMatchObject({ enabled: true, userModelsEnabled: false });
    expect(ids(await api.listModels())).toEqual(offered);
    await expect(ws.newChat("Is anyone there?", mine.id))
        .rejects.toThrow(cantBeUsedMessage(mine.name));
    await expect(mineBinding.openSession()).rejects.toThrow(cantBeUsedMessage(mine.name));
    await expect(api.addModel({ ...mine, id: "gatewaymodes-another" }, mineConfig))
        .rejects.toThrow(ADDING_REFUSED);
    (await binding.openSession())[Symbol.dispose]();

    // Nothing was deleted, so the model is back as soon as users may add their own again.
    await admin.setUserModelsEnabled(true);
    expect(await gatewayModels()).toEqual(before);
    expect(await api.getAiConfig()).toMatchObject({ enabled: true, userModelsEnabled: true });
    expect(ids(await api.listModels())).toEqual([...offered, mine.id]);
    (await mineBinding.openSession())[Symbol.dispose]();

    // Whether the admin UI suggests models is stored and reported, and changes nothing else.
    await admin.setModelsDevSuggestions(true);
    expect(await gatewayModels()).toEqual({ ...before, modelsDevSuggestions: true });
    await admin.setModelsDevSuggestions(false);
    expect(await gatewayModels()).toEqual(before);
  } finally {
    try {
      await admin.setModelsDevSuggestions(false);
      await admin.setUserModelsEnabled(true);
      await admin.setGatewayModelMode(SCRIPTED_MODEL_ID, "enabled");
      await admin.setGatewayModelMode(other.id, "enabled");
    } finally {
      if (ids((await gatewayModels()).models).includes(ADDED.id)) {
        await admin.removeGatewayModel(ADDED.id);
      }
    }
  }
});

it("an admin's reasoning levels reach a model's chat turns, its own ahead of the default",
    async () => {
  using adminPublic = connect(harness.url);
  using adminUser = await adminSession(adminPublic);
  using admin = await adminUser.getAdminApi();
  if (admin === null) throw new Error("The deployment admin API was unavailable");
  // The scripted model as the admin is shown it, beside the deployment's default level.
  const scripted = async () => {
    const view = (await admin.getSettings()).gatewayModels;
    const found = view?.models.find(candidate => candidate.id === SCRIPTED_MODEL_ID);
    if (view === undefined || found === undefined) {
      throw new Error("The admin settings did not list the scripted model");
    }
    return { ...found, defaultReasoning: view.defaultReasoning };
  };

  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("gatewaylevels")[0]!);
  using ws = await api.newGadget();
  // The effort that a new chat's turn on the scripted model asks the provider for.
  const turnEffort = async () => {
    const sent = model.requests.length;
    await waitForIdleChat(ws, await ws.newChat("How hard is this?", SCRIPTED_MODEL_ID));
    expect(model.requests).toHaveLength(sent + 1);
    return (model.requests[sent] as { reasoning_effort?: string }).reasoning_effort;
  };

  const before = await scripted();
  expect(before).toMatchObject(
      { reasoningLevels: ["off", "high", "max"], runtimeKnown: true, defaultReasoning: null });
  expect(before).not.toHaveProperty("settings");
  // With nothing set, the request names no effort at all.
  expect(await turnEffort()).toBeUndefined();

  try {
    await admin.setDefaultReasoning("high");
    expect(await turnEffort()).toBe("high");

    const settings = { reasoning: "max", compactionInputBudget: 100000 } as const;
    await admin.setGatewayModelSettings(SCRIPTED_MODEL_ID, settings);
    expect(await scripted()).toEqual({ ...before, settings, defaultReasoning: "high" });
    expect(await turnEffort()).toBe("max");

    // What the admin may not set. None of it changes anything.
    const max = before.maxCompactionInputBudget;
    await expect(admin.setGatewayModelSettings(
        SCRIPTED_MODEL_ID, { compactionInputBudget: max + 1 })).rejects.toThrow(
        `The compaction budget of the "${before.name}" model must be a whole number of tokens ` +
        `from 1 to ${max}.`);
    await expect(admin.setGatewayModelSettings("no-such-model", { reasoning: "low" }))
        .rejects.toThrow("No such model: no-such-model");
    expect(await scripted()).toEqual({ ...before, settings, defaultReasoning: "high" });
  } finally {
    try {
      await admin.setGatewayModelSettings(SCRIPTED_MODEL_ID, {});
    } finally {
      await admin.setDefaultReasoning(null);
    }
  }
  expect(await scripted()).toEqual(before);
});

it("an admin tests a model with the request its chats send, whatever the model's mode",
    async () => {
  using adminPublic = connect(harness.url);
  using adminUser = await adminSession(adminPublic);
  using admin = await adminUser.getAdminApi();
  if (admin === null) throw new Error("The deployment admin API was unavailable");

  await expect(admin.testGatewayModel("no-such-model"))
      .rejects.toThrow("No such model: no-such-model");

  try {
    await admin.setGatewayModelSettings(SCRIPTED_MODEL_ID, { reasoning: "max" });
    // No chat can run a disabled model, which an admin can still test.
    await admin.setGatewayModelMode(SCRIPTED_MODEL_ID, "disabled");
    const sent = model.requests.length;
    expect(await admin.testGatewayModel(SCRIPTED_MODEL_ID))
        .toEqual({ model: SCRIPTED_MODEL_ID, ok: true });
    expect(await admin.testGatewayModel(SCRIPTED_MODEL_ID)).toEqual({
      model: SCRIPTED_MODEL_ID, ok: false, status: 401,
      message: "401 Invalid gateway credentials.",
    });
    // Each request names the level set for the model, under the test's response cap.
    const request = { model: SCRIPTED_MODEL_ID, reasoning_effort: "max", max_tokens: 2048 };
    expect(model.requests.slice(sent)).toMatchObject([request, request]);
  } finally {
    try {
      await admin.setGatewayModelMode(SCRIPTED_MODEL_ID, "enabled");
    } finally {
      await admin.setGatewayModelSettings(SCRIPTED_MODEL_ID, {});
    }
  }
});

it("an admin turns on a provider beside the environment's, and tests what one answers",
    async () => {
  using adminPublic = connect(harness.url);
  using adminUser = await adminSession(adminPublic);
  using admin = await adminUser.getAdminApi();
  if (admin === null) throw new Error("The deployment admin API was unavailable");
  const gatewayModels = async () => {
    const view = (await admin.getSettings()).gatewayModels;
    if (view === undefined) throw new Error("The admin settings listed no gateway models");
    return view;
  };

  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("gatewayproviders")[0]!);
  const mine = { type: "agent" as const, id: "gatewayproviders-mine", name: "Mine" };
  const mineConfig = { provider: "anthropic" as const, model: "claude-mine", apiToken: "" };

  // The environment lists Workers AI alone. Every other provider the gateway serves is off.
  const before = await gatewayModels();
  expect(before.providerSettings).toEqual([
    { provider: "cloudflare", enabledBy: "environment", needsApiToken: false },
    offProvider("anthropic"), offProvider("openai"), offProvider("google"),
  ]);
  expect(await api.getAiConfig()).toMatchObject({ enabledProviders: ["cloudflare"] });
  await expect(api.addModel(mine, mineConfig))
      .rejects.toThrow('Provider "anthropic" is not available in AI Gateway mode.');

  try {
    // On, a provider is as one the environment lists: its catalog's models in their default
    // modes, and open to the admin's and the users' own.
    await admin.setGatewayProviderEnabled("anthropic", true);
    const on = await gatewayModels();
    expect(on).toEqual({
      ...before,
      providers: ["cloudflare", "anthropic"],
      providerSettings: [
        before.providerSettings[0],
        { provider: "anthropic", enabledBy: "admin", needsApiToken: false },
        offProvider("openai"), offProvider("google"),
      ],
      models: on.models,
    });
    const added = on.models.slice(before.models.length);
    expect(on.models.slice(0, before.models.length)).toEqual(before.models);
    expect(ids(added)).toEqual(Object.keys(SUGGESTED_MODELS.anthropic));
    expect(added.filter(candidate => candidate.provider !== "anthropic" || candidate.added ||
        candidate.mode !== candidate.defaultMode)).toEqual([]);
    expect(await api.getAiConfig()).toEqual({
      enabled: true,
      enabledProviders: ["cloudflare", "anthropic"],
      builtInModelIds: ids(on.models),
      userModelsEnabled: true,
    });
    expect(ids(await api.listModels())).toEqual(chatIds(on.models));
    await api.addModel(mine, mineConfig);

    // What the admin may not do. None of it changes anything.
    await expect(admin.setGatewayProviderEnabled("cloudflare", false)).rejects.toThrow(
        'Provider "cloudflare" is enabled by CF_AI_GATEWAY_PROVIDERS and can only be turned ' +
        "off there.");
    await expect(admin.setGatewayProviderEnabled("ollama", true))
        .rejects.toThrow('Provider "ollama" is not served through AI Gateway.');
    await expect(admin.testGatewayProvider("ollama"))
        .rejects.toThrow('Provider "ollama" is not served through AI Gateway.');
    expect(await gatewayModels()).toEqual(on);

    // A test asks the provider's first suggested model, and reports what the gateway answered.
    const [first] = Object.keys(SUGGESTED_MODELS.cloudflare);
    const sent = model.requests.length;
    expect(await admin.testGatewayProvider("cloudflare")).toEqual({ model: first, ok: true });
    expect(await admin.testGatewayProvider("cloudflare")).toEqual({
      model: first, ok: false, status: 401, message: "401 Invalid gateway credentials.",
    });
    expect(model.requests.slice(sent).map(request => (request as { model?: string }).model))
        .toEqual([first, first]);
    expect(await gatewayModels()).toEqual(on);

    // Off again, the deployment is as it was. The model a user added meanwhile is still theirs.
    await admin.setGatewayProviderEnabled("anthropic", false);
    expect(await gatewayModels()).toEqual(before);
    expect(await api.getAiConfig()).toMatchObject({ enabledProviders: ["cloudflare"] });
    expect(ids(await api.listModels())).toContain(mine.id);
  } finally {
    await admin.setGatewayProviderEnabled("anthropic", false);
  }
  expect(model.remainingSteps()).toBe(0);
});
