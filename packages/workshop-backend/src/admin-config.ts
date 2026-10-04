// Deployment-wide admin configuration: a single object owned by the AdminSettings durable object and
// mirrored to one reserved BLUEPRINTS KV key, so the per-(re)connect getServerConfig() path and the
// agent can resolve it with a single cheap KV get.
//
// This covers the "soft" deployment customizations only (branding, agent instructions, which
// gatekeeper connectors/resources are offered, and the models an AI Gateway deployment provides).
// Authentication/authorization config (sign-in
// providers, password login) is deliberately NOT here — it stays env-var driven so it can't be
// changed by a compromised admin session. Everything here is enabled by default; the admin UI opts
// things *out*.

import { AiModelProvider, AmbientGatekeeperMode, BlueprintBinding, BlueprintMetadata, BlueprintOutput, DEFAULT_BANNER_COLOR, GatewayModel, GatewayModelMode, GatewayModelSettings, OutputFormatOffer, SUGGESTED_MODELS, isAmbientGatekeeperMode, isBannerColor, isGatewayModelMode, isOutputIcon, isReasoningLevel } from "@gadgets/workshop-shared/api";
import { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { sanitizeBlueprintOutput } from "./blueprint-archive.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig, type FormatCuration } from "./storage-schema/admin-settings-storage.js";
import { ADMIN_CONFIG_KEY, BlueprintKvEnv, readBlueprintKvRecord } from "./storage-schema/blueprints-kv.js";

/**
 * Longest `agentHint` a promoted format may carry. Every enabled format's hint goes into the
 * system prompt on every turn, so this is a budget rather than a validation limit; a sentence or
 * two is what the panel asks for.
 */
export const MAX_AGENT_HINT = 400;

// Accept a stored format entry only if it is well-formed.
function parseFormats(value: unknown): FormatCuration[] {
  if (!Array.isArray(value)) return [];
  let formats: FormatCuration[] = [];
  let seen = new Set<string>();
  for (let raw of value) {
    if (!raw || typeof raw !== "object") continue;
    let {blueprintId, enabled, agentHint, overrides} = raw as Partial<FormatCuration>;
    if (typeof blueprintId !== "string" || !blueprintId) continue;
    if (seen.has(blueprintId)) continue;
    seen.add(blueprintId);
    let entry: FormatCuration = {blueprintId, enabled: enabled !== false};
    if (typeof agentHint === "string" && agentHint.trim()) {
      entry.agentHint = agentHint.trim().slice(0, MAX_AGENT_HINT);
    }
    let clean = sanitizeOutputOverrides(overrides);
    if (clean) entry.overrides = clean;
    formats.push(entry);
  }
  return formats;
}

/**
 * `formats` rearranged into the order `blueprintIds` gives. Throws unless that is a permutation of
 * what is promoted, so a stale client can't silently drop a format.
 *
 * Uniqueness is checked separately from length because the lookup Map dedupes: [A, A] against
 * promoted [A, B] passes both a length and a membership test, drops B, and leaves a duplicate that
 * makes every later reorder throw.
 */
export function reorderFormats(formats: FormatCuration[], blueprintIds: string[])
    : FormatCuration[] {
  let byId = new Map(formats.map(f => [f.blueprintId, f]));
  if (blueprintIds.length !== byId.size || new Set(blueprintIds).size !== blueprintIds.length
      || blueprintIds.some(id => !byId.has(id))) {
    throw new Error("Format order must list each promoted format exactly once.");
  }
  return blueprintIds.map(id => byId.get(id)!);
}

/**
 * FNV-1a, as eight hex characters. Short because callers concatenate it into a length-budgeted
 * string, and synchronous because they are -- `crypto.subtle.digest()` would make them async.
 * Compared only for equality, so nothing depends on collision resistance.
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable grouping id for a promoted blueprint that doesn't declare what it produces. An
 * implementation detail of the Outputs filter. Keeps short blueprint ids readable and preserves
 * uniqueness.
 */
export function defaultOutputFormatId(blueprintId: string): string {
  if (blueprintId.length <= 40) return blueprintId;
  return `${blueprintId.slice(0, 31)}-${fingerprint(blueprintId)}`;
}

/**
 * Keep only the well-formed fields of an admin's presentation override, or undefined if none
 * survive.
 */
export function sanitizeOutputOverrides(overrides: unknown): Partial<BlueprintOutput> | undefined {
  if (!overrides || typeof overrides !== "object") return undefined;
  let {id, noun, plural, icon} = overrides as Partial<BlueprintOutput>;
  let clean: Partial<BlueprintOutput> = {};
  for (let [key, value] of Object.entries({id, noun, plural})) {
    if (typeof value === "string" && value.trim() && value.trim().length <= 40) {
      clean[key as "id" | "noun" | "plural"] = value.trim();
    }
  }
  if (isOutputIcon(icon)) clean.icon = icon;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * The presentation a gadget instantiated from `blueprintId` should inherit: the blueprint's own
 * declaration with this deployment's override applied. Called on every instantiation path, so an
 * admin who renames "Slides" to "Briefing" gets Briefings from then on.
 *
 * Overrides apply even when the format is disabled: disabling stops it being *offered*, but a
 * gadget built from that blueprint still carries the deployment's naming.
 */
export function deploymentOutputForBlueprint(
    config: AdminConfig, blueprintId: string, declared: BlueprintOutput | undefined)
    : BlueprintOutput | undefined {
  return resolveFormatOutput(declared, config.formats.find(f => f.blueprintId === blueprintId)?.overrides);
}

/**
 * Resolve what a promoted blueprint should be shown as: the blueprint's own declaration with the
 * deployment's overrides applied. Returns undefined when the blueprint declares nothing and the
 * admin overrode nothing meaningful.
 */
export function resolveFormatOutput(
    declared: BlueprintOutput | undefined, overrides?: Partial<BlueprintOutput>)
    : BlueprintOutput | undefined {
  let merged = {...declared, ...overrides};
  if (!merged.id || !merged.noun || !merged.plural || !merged.icon) return undefined;
  return merged as BlueprintOutput;
}

// --- Reading the promoted set ---
//
// Three surfaces offer the deployment's formats -- the user's New menu, the agent's catalog, and
// the admin panel that curates them.

/** One promoted blueprint joined with the blueprint it points at. */
export type PromotedFormat = {
  entry: FormatCuration;

  /**
   * The blueprint's own metadata. Absent when it has been deleted since being promoted; such an
   * entry is skipped everywhere except the admin panel, which offers to remove it.
   */
  metadata?: BlueprintMetadata;

  /** What the blueprint declares it produces, after validation. Absent if it declares nothing usable. */
  declared?: BlueprintOutput;

  /** `declared` with the deployment's overrides applied. */
  output?: BlueprintOutput;
};

/** Join promoted entries with the blueprints they point at, preserving order. */
export async function listPromotedFormats(env: BlueprintKvEnv, formats: FormatCuration[])
    : Promise<PromotedFormat[]> {
  let records = await Promise.all(
      formats.map(entry => readBlueprintKvRecord(env, entry.blueprintId)));

  return formats.map((entry, i) => {
    let metadata = records[i]?.metadata;
    let declared = sanitizeBlueprintOutput(metadata?.output);
    return {entry, metadata, declared, output: resolveFormatOutput(declared, entry.overrides)};
  });
}

/**
 * A format the deployment is offering, plus the two things only the agent's catalog wants: the
 * admin's note about when to prefer it, and the bindings its blueprint expects to be wired up.
 * listOutputFormats() drops both.
 */
export type FormatOffer = OutputFormatOffer & {
  agentHint?: string;
  bindings: Record<string, BlueprintBinding>;
};

/**
 * The formats this deployment offers, in menu order: promoted, enabled, and resolvable to a
 * complete presentation. A promoted blueprint that has since been deleted, or that names nothing
 * to call itself, is silently skipped.
 */
export async function listFormatOffers(env: BlueprintKvEnv, config: AdminConfig)
    : Promise<FormatOffer[]> {
  let enabled = config.formats.filter(entry => entry.enabled);
  if (enabled.length === 0) return [];

  let offers: FormatOffer[] = [];
  for (let {entry, metadata, output} of await listPromotedFormats(env, enabled)) {
    if (!metadata || !output) continue;
    offers.push({
      blueprintId: entry.blueprintId,
      output,
      description: metadata.description,
      requiresSetup: Object.keys(metadata.bindings).length > 0,
      bindings: metadata.bindings,
      ...(entry.agentHint ? {agentHint: entry.agentHint} : {}),
    });
  }
  return offers;
}

// Object.hasOwn, so that a name like "constructor" is not taken for a provider.
function isProvider(value: unknown): value is AiModelProvider {
  return typeof value === "string" && Object.hasOwn(SUGGESTED_MODELS, value);
}

/** Longest id or name an added AI Gateway model may carry, its `behavesLike` id included. */
const MAX_ADDED_MODEL_TEXT = 200;

/**
 * An added AI Gateway model if `value` is a well-formed one, or undefined. Shape only: whether the
 * gateway serves the provider and the id is free depends on the deployment (see GatewayModels in
 * ai-gateway.ts).
 */
export function sanitizeAddedModel(value: unknown): GatewayModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  let {provider, id, name, contextWindow, outputLimit, behavesLike} =
      value as Partial<GatewayModel>;
  if (!isProvider(provider)) return undefined;
  if (typeof id !== "string" || typeof name !== "string") return undefined;
  id = id.trim();
  name = name.trim();
  for (let text of [id, name]) {
    if (!text || text.length > MAX_ADDED_MODEL_TEXT) return undefined;
  }
  if (!isTokenLimit(contextWindow)) return undefined;
  if (outputLimit !== undefined && !isTokenLimit(outputLimit)) return undefined;
  // Blank reads as absent.
  behavesLike = typeof behavesLike === "string" ? behavesLike.trim() : "";
  if (behavesLike.length > MAX_ADDED_MODEL_TEXT) return undefined;
  return {
    provider, id, name, contextWindow,
    ...(outputLimit === undefined ? {} : {outputLimit}),
    ...(behavesLike ? {behavesLike} : {}),
  };
}

function isTokenLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * The well-formed part of a gateway model's settings, or undefined if none of it is. Shape only:
 * how large a compaction budget may be depends on the model (see compactionBudgetRange() in
 * admin-settings.ts).
 */
export function sanitizeModelSettings(value: unknown): GatewayModelSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  let {reasoning, compactionInputBudget} = value as Partial<GatewayModelSettings>;
  let settings: GatewayModelSettings = {};
  if (isReasoningLevel(reasoning)) settings.reasoning = reasoning;
  if (isTokenLimit(compactionInputBudget)) settings.compactionInputBudget = compactionInputBudget;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

// Accept a stored added model only if it is well-formed, and only the first under each id.
function parseAddedModels(value: unknown): GatewayModel[] {
  if (!Array.isArray(value)) return [];
  let models = new Map<string, GatewayModel>();
  for (let raw of value) {
    let model = sanitizeAddedModel(raw);
    if (model && !models.has(model.id)) models.set(model.id, model);
  }
  return [...models.values()];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Apply defaults to a partial admin config loaded from either authoritative DO
 * storage or its KV mirror.
 */
export function normalizeAdminConfig(p: Partial<AdminConfig>): AdminConfig {
  let disabledResources: Record<string, string[]> = {};
  if (p.disabledResources && typeof p.disabledResources === "object") {
    for (let [vendorId, patterns] of Object.entries(p.disabledResources)) {
      let list = strings(patterns);
      if (list.length > 0) disabledResources[vendorId] = list;
    }
  }
  let ambientGatekeeperModes: Record<string, AmbientGatekeeperMode> = {};
  if (p.ambientGatekeeperModes && typeof p.ambientGatekeeperModes === "object") {
    for (let [vendorId, mode] of Object.entries(p.ambientGatekeeperModes)) {
      if (isAmbientGatekeeperMode(mode)) ambientGatekeeperModes[vendorId.toLowerCase()] = mode;
    }
  }
  // Object.fromEntries defines own properties, so a stored "__proto__" key stays an ordinary entry.
  let modelModes: Record<string, GatewayModelMode> =
      p.modelModes && typeof p.modelModes === "object"
          ? Object.fromEntries(
              Object.entries(p.modelModes).filter(([, mode]) => isGatewayModelMode(mode)))
          : {};
  let modelSettings: Record<string, GatewayModelSettings> =
      p.modelSettings && typeof p.modelSettings === "object"
          ? Object.fromEntries(Object.entries(p.modelSettings).flatMap(([id, stored]) => {
              let settings = sanitizeModelSettings(stored);
              return settings ? [[id, settings]] : [];
            }))
          : {};
  let signupsEnabled = typeof p.signupsEnabled === "boolean"
    ? p.signupsEnabled
    : DEFAULT_ADMIN_CONFIG.signupsEnabled;
  return {
    signupsEnabled,
    userSearchEnabled: typeof p.userSearchEnabled === "boolean"
      ? p.userSearchEnabled
      : !signupsEnabled,
    siteName: typeof p.siteName === "string" ? p.siteName : "",
    siteLogoConfigured: typeof p.siteLogoConfigured === "boolean" ? p.siteLogoConfigured : false,
    instanceInstructions: typeof p.instanceInstructions === "string" ? p.instanceInstructions : "",
    announcement: typeof p.announcement === "string" ? p.announcement : "",
    banner: {
      text: typeof p.banner?.text === "string" ? p.banner.text : "",
      color: isBannerColor(p.banner?.color) ? p.banner!.color : DEFAULT_BANNER_COLOR,
    },
    accentColor: typeof p.accentColor === "string" ? p.accentColor : "",
    disabledResources,
    disabledGatekeepers: strings(p.disabledGatekeepers).map(v => v.toLowerCase()),
    ambientGatekeeperModes,
    formats: parseFormats(p.formats),
    modelModes,
    addedProviders: Array.isArray(p.addedProviders)
      ? [...new Set(p.addedProviders.filter(isProvider))]
      : [],
    addedModels: parseAddedModels(p.addedModels),
    modelSettings,
    defaultReasoning: isReasoningLevel(p.defaultReasoning) ? p.defaultReasoning : null,
    userModelsEnabled: typeof p.userModelsEnabled === "boolean"
      ? p.userModelsEnabled
      : DEFAULT_ADMIN_CONFIG.userModelsEnabled,
    modelsDevSuggestions: typeof p.modelsDevSuggestions === "boolean"
      ? p.modelsDevSuggestions
      : DEFAULT_ADMIN_CONFIG.modelsDevSuggestions,
  };
}

export function parseAdminConfig(raw: string | null): AdminConfig {
  if (!raw) return { ...DEFAULT_ADMIN_CONFIG };
  try {
    return normalizeAdminConfig(JSON.parse(raw) as Partial<AdminConfig>);
  } catch {
    return { ...DEFAULT_ADMIN_CONFIG };
  }
}

export function serializeAdminConfig(config: AdminConfig): string {
  return JSON.stringify(config);
}

/** Read the admin config from the KV mirror. Cheap enough for the hot path (a single KV get). */
export async function readAdminConfig(env: Cloudflare.Env): Promise<AdminConfig> {
  return parseAdminConfig(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY));
}

// --- Resource-disable helpers ---

export function isResourceDisabled(
    config: AdminConfig, vendorId: string, urlPattern: string): boolean {
  return config.disabledResources[vendorId]?.includes(urlPattern) ?? false;
}

export function filterEnabledResources(
    config: AdminConfig, vendorId: string, resources: SupportedResource[]): SupportedResource[] {
  let disabled = config.disabledResources[vendorId];
  if (!disabled || disabled.length === 0) return resources;
  return resources.filter(r => !disabled.includes(r.urlPattern));
}

// --- Agent system-prompt instructions ---

/**
 * Wrap the admin instructions in a clearly-delimited block for the system prompt, or "" when unset.
 * Callers are responsible for separating this from the preceding prompt with a blank line.
 */
export function formatInstanceInstructions(instructions: string): string {
  let trimmed = instructions.trim();
  if (!trimmed) return "";
  return `# Deployment-specific instructions\n\n` +
      `The administrator of this deployment has provided the following additional instructions. ` +
      `Follow them unless they conflict with the user's safety or the instructions above.\n\n` +
      `<deployment_instructions>\n${trimmed}\n</deployment_instructions>`;
}
