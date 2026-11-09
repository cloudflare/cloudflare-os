// Deployment-wide admin configuration: a single object owned by the AdminSettings durable object and
// mirrored to one reserved BLUEPRINTS KV key, so the per-(re)connect getServerConfig() path and the
// agent can resolve it with a single cheap KV get.
//
// This covers the "soft" deployment customizations only (branding, agent instructions, which
// gatekeeper connectors/resources are offered, the models an AI Gateway deployment provides, and
// the audit retention admins choose within the bound admin-access.ts reads from the environment).
// Authentication/authorization config (sign-in providers, password login) is deliberately NOT
// here — it stays env-var driven so it can't be changed by a compromised admin session. Everything
// here is enabled by default; the admin UI opts things *out*.

import { AdminSettingChange, AiModelProvider, AmbientGatekeeperMode, BlueprintBinding, BlueprintMetadata, BlueprintOutput, DEFAULT_BANNER_COLOR, GatewayModel, GatewayModelCapabilities, GatewayModelMode, GatewayModelSettings, MAX_ADMIN_AUDIT_RETENTION_DAYS, MAX_UPDATE_CHECK_INTERVAL_MINUTES, MAX_UPDATE_HOURS, OutputFormatOffer, REASONING_LEVELS, SUGGESTED_MODELS, isAmbientGatekeeperMode, isBannerColor, isGatewayModelMode, isOutputIcon, isReasoningLevel } from "@gadgets/workshop-shared/api";
import { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { adminSettingChange } from "./admin-access.js";
import { sanitizeBlueprintOutput } from "./blueprint-archive.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig, type FormatCuration } from "./storage-schema/admin-settings-storage.js";
import { ADMIN_CONFIG_KEY, BlueprintKvEnv, readBlueprintKvRecord } from "./storage-schema/blueprints-kv.js";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.admin.config");

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
 * Throws an Error with `message` unless `order` lists each of `ids` exactly once, so that a stale
 * client reordering a list can't silently drop an entry.
 *
 * Uniqueness is checked separately from length because the lookup Set dedupes: [A, A] against
 * [A, B] passes both a length and a membership test, drops B, and leaves a duplicate that makes
 * every later reorder throw.
 */
export function assertPermutation(order: readonly string[], ids: Iterable<string>, message: string)
    : void {
  let known = new Set(ids);
  if (order.length !== known.size || new Set(order).size !== order.length
      || order.some(id => !known.has(id))) {
    throw new Error(message);
  }
}

/**
 * `formats` rearranged into the order `blueprintIds` gives. Throws unless that is a permutation of
 * what is promoted (see assertPermutation).
 */
export function reorderFormats(formats: FormatCuration[], blueprintIds: string[])
    : FormatCuration[] {
  let byId = new Map(formats.map(f => [f.blueprintId, f]));
  assertPermutation(blueprintIds, byId.keys(),
      "Format order must list each promoted format exactly once.");
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
  let {provider, id, name, contextWindow, outputLimit, behavesLike, capabilities} =
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
  capabilities = sanitizeCapabilities(capabilities);
  return {
    provider, id, name, contextWindow,
    ...(outputLimit === undefined ? {} : {outputLimit}),
    ...(behavesLike ? {behavesLike} : {}),
    ...(capabilities ? {capabilities} : {}),
  };
}

// The well-formed part of what an added model is stated to do, or undefined if none of it is:
// a malformed statement is one not made. Reasoning levels are kept once each, least to most.
function sanitizeCapabilities(value: unknown): GatewayModelCapabilities | undefined {
  if (!value || typeof value !== "object") return undefined;
  let {imageInput, reasoningLevels} = value as Partial<GatewayModelCapabilities>;
  let capabilities: GatewayModelCapabilities = {};
  if (typeof imageInput === "boolean") capabilities.imageInput = imageInput;
  if (Array.isArray(reasoningLevels) && reasoningLevels.every(isReasoningLevel)) {
    capabilities.reasoningLevels =
        REASONING_LEVELS.filter(level => reasoningLevels.includes(level));
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function isTokenLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** How many gateway model names Auto Router may be allowed, at most. */
export const MAX_ALLOWED_MODELS = 100;

/**
 * Whether `value` is a gateway model name as Auto Router's allow-list takes one: `provider/model`
 * with no whitespace or comma (the list's separator on the wire), no longer than an added model's
 * id.
 */
export function isAllowedModelName(value: string): boolean {
  return value.length <= MAX_ADDED_MODEL_TEXT && /^[^\s,/]+\/[^\s,]+$/.test(value);
}

// The well-formed names of `value`, trimmed and once each, or undefined for no list or an empty
// or over-long one.
function sanitizeAllowedModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let names = [...new Set(value.filter((name): name is string => typeof name === "string")
      .map(name => name.trim()).filter(isAllowedModelName))];
  return names.length > 0 && names.length <= MAX_ALLOWED_MODELS ? names : undefined;
}

/**
 * The well-formed part of a gateway model's settings, or undefined if none of it is. Shape only:
 * how large a compaction budget may be depends on the model (see compactionBudgetRange() in
 * admin-settings.ts), and which model may list allowed models on the model (see
 * AdminSettings.setGatewayModelSettings).
 */
export function sanitizeModelSettings(value: unknown): GatewayModelSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  let {reasoning, compactionInputBudget, allowedModels} = value as Partial<GatewayModelSettings>;
  let settings: GatewayModelSettings = {};
  if (isReasoningLevel(reasoning)) settings.reasoning = reasoning;
  if (isTokenLimit(compactionInputBudget)) settings.compactionInputBudget = compactionInputBudget;
  let allowed = sanitizeAllowedModels(allowedModels);
  if (allowed) settings.allowedModels = allowed;
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

/**
 * Whether `value` may be the minimum age or the notice snooze of the update notice: a whole number
 * of hours from 0 to MAX_UPDATE_HOURS.
 */
export function isUpdateHours(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UPDATE_HOURS;
}

/**
 * Whether `value` may be the update check interval: a whole number of minutes from 1 to
 * MAX_UPDATE_CHECK_INTERVAL_MINUTES.
 */
export function isUpdateCheckInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 &&
      value <= MAX_UPDATE_CHECK_INTERVAL_MINUTES;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// An exact, lowercase ASCII host name: no scheme, port, path, wildcard or trailing dot. ASCII because
// `URL.host` always is (an IDN arrives as punycode), so any other entry could never match.
const HOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * An admin's `restrictedWebFetchHosts` as stored: trimmed, lowercased, without blanks or
 * duplicates. Throws on an entry that is not an exact ASCII host name.
 */
export function parseRestrictedWebFetchHosts(hosts: string[]): string[] {
  let parsed = new Set<string>();
  for (let entry of hosts) {
    let host = entry.trim().toLowerCase();
    if (host === "") continue;
    if (!HOST_NAME.test(host)) {
      throw new Error(`"${entry}" is not a host name. Enter exact host names, such as docs.example.com.`);
    }
    parsed.add(host);
  }
  return [...parsed];
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
  let modelOrder: Partial<Record<AiModelProvider, string[]>> =
      p.modelOrder && typeof p.modelOrder === "object"
          ? Object.fromEntries(Object.entries(p.modelOrder).flatMap(([provider, ids]) =>
              isProvider(provider) ? [[provider, [...new Set(strings(ids))]]] : []))
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
    restrictedWebFetchHosts: strings(p.restrictedWebFetchHosts),
    restrictedWebFetchApprovals: p.restrictedWebFetchApprovals === true,
    sharedViews: p.sharedViews !== false,
    formats: parseFormats(p.formats),
    modelModes,
    addedProviders: Array.isArray(p.addedProviders)
      ? [...new Set(p.addedProviders.filter(isProvider))]
      : [],
    providerOrder: Array.isArray(p.providerOrder)
      ? [...new Set(p.providerOrder.filter(isProvider))]
      : [],
    addedModels: parseAddedModels(p.addedModels),
    modelOrder,
    modelSettings,
    defaultReasoning: isReasoningLevel(p.defaultReasoning) ? p.defaultReasoning : null,
    userModelsEnabled: typeof p.userModelsEnabled === "boolean"
      ? p.userModelsEnabled
      : DEFAULT_ADMIN_CONFIG.userModelsEnabled,
    modelsDevSuggestions: typeof p.modelsDevSuggestions === "boolean"
      ? p.modelsDevSuggestions
      : DEFAULT_ADMIN_CONFIG.modelsDevSuggestions,
    // A config stored before the flag existed counts as saved, so a seed set on an existing
    // deployment never overrides what its admins chose.
    modelsSaved: typeof p.modelsSaved === "boolean" ? p.modelsSaved : true,
    updateChecksEnabled: typeof p.updateChecksEnabled === "boolean"
      ? p.updateChecksEnabled
      : DEFAULT_ADMIN_CONFIG.updateChecksEnabled,
    updateCheckIntervalMinutes: isUpdateCheckInterval(p.updateCheckIntervalMinutes)
      ? p.updateCheckIntervalMinutes
      : DEFAULT_ADMIN_CONFIG.updateCheckIntervalMinutes,
    updateMinimumAgeHours: isUpdateHours(p.updateMinimumAgeHours)
      ? p.updateMinimumAgeHours
      : DEFAULT_ADMIN_CONFIG.updateMinimumAgeHours,
    updateNoticeSnoozeHours: isUpdateHours(p.updateNoticeSnoozeHours)
      ? p.updateNoticeSnoozeHours
      : DEFAULT_ADMIN_CONFIG.updateNoticeSnoozeHours,
    // The admins' choice, kept as chosen: adminAccessPolicy() (admin-access.ts) holds it within the
    // environment's bound wherever it is enforced, so changing the bound needs no rewrite.
    adminAuditRetentionDays: isAdminAuditRetention(p.adminAuditRetentionDays)
      ? p.adminAuditRetentionDays
      : DEFAULT_ADMIN_CONFIG.adminAuditRetentionDays,
  };
}

function isAdminAuditRetention(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 &&
      value <= MAX_ADMIN_AUDIT_RETENTION_DAYS;
}

// The lists whose entries have ids, by the field naming each entry's id. A list whose entries have
// ids belongs here, so that one entry's change records that entry, not the whole list.
const KEYED_LISTS: Partial<Record<keyof AdminConfig, string>> = {
  formats: "blueprintId",
  addedModels: "id",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The entries of a keyed list by id, in list order. Ids are deduplicated on read (parseFormats,
// parseAddedModels), so each names one entry.
function entriesById(list: unknown, idField: string): Map<string, unknown> {
  let byId = new Map<string, unknown>();
  if (!Array.isArray(list)) return byId;
  for (let entry of list) {
    let id = isPlainObject(entry) ? entry[idField] : undefined;
    if (typeof id === "string" && !byId.has(id)) byId.set(id, entry);
  }
  return byId;
}

function diffKeyedList(field: string, before: unknown, after: unknown, idField: string)
    : (AdminSettingChange | undefined)[] {
  let was = entriesById(before, idField);
  let now = entriesById(after, idField);
  let changes = [...new Set([...was.keys(), ...now.keys()])].toSorted()
      .map(id => adminSettingChange(field, id, was.get(id), now.get(id)));
  let keptBefore = [...was.keys()].filter(id => now.has(id));
  let keptAfter = [...now.keys()].filter(id => was.has(id));
  if (keptBefore.some((id, i) => id !== keptAfter[i])) {
    changes.push(adminSettingChange(field, undefined, [...was.keys()], [...now.keys()]));
  }
  return changes;
}

// Object.hasOwn, so that a "__proto__" or "constructor" entry is read as itself, never as
// Object.prototype or its constructor.
function ownValue(map: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function diffMap(field: string, before: Record<string, unknown>, after: Record<string, unknown>)
    : (AdminSettingChange | undefined)[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted()
      .map(key => adminSettingChange(field, key, ownValue(before, key), ownValue(after, key)));
}

/**
 * The settings `after` changes from `before`, as an AdminSettingRecord lists them, each built with
 * adminSettingChange(), field by field in DEFAULT_ADMIN_CONFIG order:
 *   - a list of entries with ids (formats, by blueprintId; addedModels, by id): one change per
 *     entry added, removed or changed, in sorted id order, `key` naming it and the values the
 *     entry alone; then, when the entries both sides hold are in a different relative order, one
 *     change without `key` whose values are the lists of every id, in order;
 *   - a map (an object, not an array: banner, disabledResources, ambientGatekeeperModes,
 *     modelModes, modelOrder, modelSettings): one change per own key, in sorted order, whose
 *     value differs;
 *   - any other field: one change with the whole value.
 * Presence is tested with Object.hasOwn, so a "__proto__" or "constructor" entry is an ordinary
 * one. Empty when nothing differs.
 */
export function diffAdminConfig(before: AdminConfig, after: AdminConfig): AdminSettingChange[] {
  let changes: (AdminSettingChange | undefined)[] = [];
  for (let field of Object.keys(DEFAULT_ADMIN_CONFIG) as (keyof AdminConfig)[]) {
    let was: unknown = before[field];
    let now: unknown = after[field];
    let idField = KEYED_LISTS[field];
    if (idField) {
      changes.push(...diffKeyedList(field, was, now, idField));
    } else if (isPlainObject(was) && isPlainObject(now)) {
      changes.push(...diffMap(field, was, now));
    } else {
      changes.push(adminSettingChange(field, undefined, was, now));
    }
  }
  return changes.filter(change => change !== undefined);
}

/**
 * The fields ADMIN_CONFIG_SEED may set: the Models tab's. The rest of the config is what an admin
 * curates for the people using a deployment, which nothing outside the admin UI should decide.
 */
export const ADMIN_CONFIG_SEED_FIELDS = [
  "modelModes", "addedProviders", "providerOrder", "addedModels", "modelOrder", "modelSettings",
  "defaultReasoning", "userModelsEnabled", "modelsDevSuggestions",
] as const satisfies readonly (keyof AdminConfig)[];

/** What ADMIN_CONFIG_SEED may hold. */
export type AdminConfigSeed =
    Partial<Pick<AdminConfig, typeof ADMIN_CONFIG_SEED_FIELDS[number]>>;

/**
 * Parse an ADMIN_CONFIG_SEED value: a JSON object, or that object as a JSON string, which is what
 * a secret can carry. A value that is not one, or that names a field ADMIN_CONFIG_SEED_FIELDS
 * leaves out, gives no seed at all rather than part of one, so that a typo cannot apply half of
 * what was meant. The fields' values are checked later, by normalizeAdminConfig(), the same way
 * as a stored config's.
 */
export function parseAdminConfigSeed(raw: unknown): AdminConfigSeed {
  if (raw === undefined || raw === null || raw === "") return {};
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    logger.error("ADMIN_CONFIG_SEED is not JSON; ignoring it", {event: "admin.seed.invalid"});
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    logger.error("ADMIN_CONFIG_SEED is not a JSON object; ignoring it", {
      event: "admin.seed.invalid",
    });
    return {};
  }
  let allowed: readonly string[] = ADMIN_CONFIG_SEED_FIELDS;
  let unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    logger.error(`ADMIN_CONFIG_SEED sets fields it may not (${unknown.join(", ")}); ignoring it`, {
      event: "admin.seed.invalid",
    });
    return {};
  }
  return value as AdminConfigSeed;
}

// The last seed parsed, by the value it was parsed from, so the hot path parses (and logs a bad
// seed) once per isolate rather than once per read.
let parsedSeed: { raw: unknown, seed: AdminConfigSeed } | undefined;

/** The deployment's ADMIN_CONFIG_SEED, parsed (see parseAdminConfigSeed). */
export function adminConfigSeed(env: Pick<Cloudflare.Env, "ADMIN_CONFIG_SEED">): AdminConfigSeed {
  let raw = env.ADMIN_CONFIG_SEED;
  if (parsedSeed === undefined || parsedSeed.raw !== raw) {
    parsedSeed = { raw, seed: parseAdminConfigSeed(raw) };
  }
  return parsedSeed.seed;
}

// The Models tab fields of a config no admin has changed them in: the defaults, under the seed.
function unsavedModelFields(seed: AdminConfigSeed): AdminConfigSeed {
  let defaults = Object.fromEntries(ADMIN_CONFIG_SEED_FIELDS.map(
      field => [field, DEFAULT_ADMIN_CONFIG[field]])) as AdminConfigSeed;
  return { ...defaults, ...seed };
}

/**
 * The config a deployment runs on, from the one stored (in the AdminSettings DO or its KV mirror;
 * null when there is none) and its ADMIN_CONFIG_SEED. Until an admin changes a Models tab setting
 * (`modelsSaved`), those fields are the defaults under the seed, whatever is stored for them: the
 * deployment's own writes, such as promoting its bundled formats on its first request, store a
 * config without ending the seed, and a changed seed applies on the next deploy.
 *
 * Without a seed the stored config is read as it is, as it was before seeds existed; so a
 * deployment whose seed is removed keeps the values the seed last gave it.
 */
export function effectiveAdminConfig(
    stored: Partial<AdminConfig> | null, seed: AdminConfigSeed): AdminConfig {
  let config = normalizeAdminConfig(stored ?? { ...DEFAULT_ADMIN_CONFIG });
  if (config.modelsSaved || Object.keys(seed).length === 0) return config;
  return normalizeAdminConfig({ ...config, ...unsavedModelFields(seed) });
}

/**
 * Whether a write from `current` to `next` changes a Models tab setting, which is what ends a
 * seed (see effectiveAdminConfig). Compared by value, so a setter that rebuilds a record without
 * changing it does not count.
 */
export function changesModelSettings(current: AdminConfig, next: AdminConfig): boolean {
  return ADMIN_CONFIG_SEED_FIELDS.some(
      field => canonicalJson(current[field]) !== canonicalJson(next[field]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
          : v);
}

export function parseAdminConfig(raw: string | null, seed: AdminConfigSeed = {}): AdminConfig {
  if (!raw) return effectiveAdminConfig(null, seed);
  let stored: Partial<AdminConfig>;
  try {
    stored = JSON.parse(raw) as Partial<AdminConfig>;
  } catch {
    return effectiveAdminConfig(null, seed);
  }
  return effectiveAdminConfig(stored, seed);
}

export function serializeAdminConfig(config: AdminConfig): string {
  return JSON.stringify(config);
}

/** Read the admin config from the KV mirror. Cheap enough for the hot path (a single KV get). */
export async function readAdminConfig(env: Cloudflare.Env): Promise<AdminConfig> {
  return parseAdminConfig(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY), adminConfigSeed(env));
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
