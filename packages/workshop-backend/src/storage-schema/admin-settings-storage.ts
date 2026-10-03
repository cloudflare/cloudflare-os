// The AdminSettings Durable Object's storage schema: `makeAdminSettingsStorage()` and the record
// types it stores.
//
// Everything the AdminSettings object persists is declared in this one file, so that a change to
// the stored shape of the deployment's settings shows up as a change here. See
// overseer-storage.ts for the conventions. `AdminConfig` is additionally mirrored to KV as JSON
// (see blueprints-kv.ts); the code that normalizes, serializes and reads it lives in
// admin-config.ts.

import { collection, createTypedStorage } from "@gadgets/typed-storage";
import {
  DEFAULT_BANNER_COLOR,
  type AiModelProvider, type AmbientGatekeeperMode, type BannerConfig, type BlueprintOutput,
  type BlueprintPublicInfo, type GatewayModel, type GatewayModelMode, type GatewayModelSettings,
  type ReasoningLevel,
} from "@gadgets/workshop-shared/api";

export type AdminConfig = {
  /**
   * Whether new account signups are allowed (default true). Note: this is an access toggle, not
   * authentication config — which auth providers exist and whether password login is on stay
   * env-driven (see auth/config.ts).
   */
  signupsEnabled: boolean;
  /**
   * Whether users may search the deployment-wide user directory to find collaborators. When not
   * explicitly configured, this defaults to the opposite of `signupsEnabled`. The directory itself
   * is maintained either way, and this switch just controls user access.
   */
  userSearchEnabled: boolean;
  /**
   * Site name shown next to the top-bar logo, or "" to use DEFAULT_SITE_NAME. Resolve it for
   * display with `resolveSiteName()`.
   */
  siteName: string;
  /** Whether this deployment has a custom site logo. Image bytes are stored separately. */
  siteLogoConfigured: boolean;
  /** Extra instructions appended to the agent system prompt. */
  instanceInstructions: string;
  /** Centered top-bar notice. Markdown. */
  announcement: string;
  /** Full-width banner (text + accent color). */
  banner: BannerConfig;
  /** Accent (brand) color hex, or "" for the default theme. */
  accentColor: string;
  /** Disabled gatekeeper resources: vendorId -> disabled resource urlPatterns. */
  disabledResources: Record<string, string[]>;
  /** Fully-disabled gatekeeper vendor ids. */
  disabledGatekeepers: string[];
  /**
   * Per-vendor provisioning mode for auto-provisioning ("ambient") gatekeepers (e.g. the Context
   * Library). Absent ⇒ the default ("optional", see provisioning-policy.ts). Only meaningful for
   * vendors that declare autoProvisionsAccount.
   */
  ambientGatekeeperModes: Record<string, AmbientGatekeeperMode>;

  /**
   * The blueprints offered as this deployment's standard output formats. What a user gets from
   * "New Slides", and what the agent is told to prefer. Order is menu order.
   *
   * Separate from the blueprint's own declaration of what it produces (BlueprintMetadata.output):
   * any user can publish a blueprint calling itself a Document, but only this list decides what
   * the deployment offers.
   */
  formats: FormatCuration[];

  /**
   * How each AI Gateway model is offered: model id -> mode, for the models an admin changed.
   * Absent ⇒ the model's default (SUGGESTED_MODELS' for a suggested model, "enabled" for an added
   * one), so an untouched model follows the catalog across upgrades. Only meaningful in AI Gateway
   * mode (see GatewayModels in ai-gateway.ts).
   */
  modelModes: Record<string, GatewayModelMode>;
  /**
   * The providers an admin turned on beside the ones CF_AI_GATEWAY_PROVIDERS lists. That variable
   * is a floor: these add to it and take nothing from it. Only the ones AI Gateway serves count
   * (see GatewayModels in ai-gateway.ts).
   */
  addedProviders: AiModelProvider[];
  /** Models added to the ones the deployment provides through AI Gateway, in listing order. */
  addedModels: GatewayModel[];
  /**
   * What an admin set for each AI Gateway model: model id -> settings, for the models that have
   * any. Absent ⇒ the model's built-in behaviour, at `defaultReasoning` where that is set. Only
   * meaningful in AI Gateway mode (see GatewayModels in ai-gateway.ts).
   */
  modelSettings: Record<string, GatewayModelSettings>;
  /**
   * The reasoning level of every AI Gateway model whose settings give none, or null for each
   * model's built-in behaviour. Never applies to a model a user added.
   */
  defaultReasoning: ReasoningLevel | null;
  /**
   * Whether users may add models of their own (default true), which in AI Gateway mode run through
   * the deployment's gateway. While false, the gateway's models are the only ones a user can list
   * or run; the models users stored are kept. Only meaningful in AI Gateway mode (see GatewayModels
   * in ai-gateway.ts).
   */
  userModelsEnabled: boolean;
  /**
   * Whether the admin UI may suggest models from models.dev while an admin adds one (default
   * false). The admin's browser reads it and fetches the suggestions; the server only stores it.
   */
  modelsDevSuggestions: boolean;
};

/**
 * One promoted blueprint. The blueprint itself supplies the noun, plural and icon, so improving
 * the blueprint improves every deployment that hasn't overridden it.
 */
export type FormatCuration = {
  blueprintId: string;

  /**
   * Offered to users and the agent. Disabling keeps the entry (and its overrides) around, so
   * re-enabling doesn't lose the admin's edits.
   */
  enabled: boolean;

  /** One line telling the agent when to choose this format, e.g. "prefer for contracts and memos". */
  agentHint?: string;

  /**
   * Presentation the deployment substitutes for the blueprint's own, e.g. an org that calls its
   * decks "Briefings". Absent fields fall back to the blueprint's declaration.
   */
  overrides?: Partial<BlueprintOutput>;
};

export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  signupsEnabled: true,
  userSearchEnabled: false,
  siteName: "",
  siteLogoConfigured: false,
  instanceInstructions: "",
  announcement: "",
  banner: { text: "", color: DEFAULT_BANNER_COLOR },
  accentColor: "",
  disabledResources: {},
  disabledGatekeepers: [],
  ambientGatekeeperModes: {},
  formats: [],
  modelModes: {},
  addedProviders: [],
  addedModels: [],
  modelSettings: {},
  defaultReasoning: null,
  userModelsEnabled: true,
  modelsDevSuggestions: false,
};

export function makeAdminSettingsStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      // Mirror of the currently-featured blueprint public records. The user DO owns the
      // authoritative featured bit; this DO keeps the publishable deployment-wide copy.
      featuredBlueprints: collection<BlueprintPublicInfo>()({
        primaryKey: 'id',
      }),
    },
    singletons: {
      // Authoritative deployment admin config. Mirrored to BLUEPRINTS KV (ADMIN_CONFIG_KEY) so the
      // connect/login/agent hot paths can read it without touching this singleton DO.
      adminConfig: DEFAULT_ADMIN_CONFIG as AdminConfig,

      // Which set of bundled blueprints has been installed (see
      // bundledBlueprintsManifestVersion). Empty means none yet; a mismatch means the repo shipped
      // new or updated ones and they should be reinstalled.
      installedFormatBlueprints: "",

      // Bundled blueprint ids that have already been offered for promotion into
      // AdminConfig.formats. Tracked separately from the install stamp so that promotion happens
      // exactly once per blueprint: an admin who then removes a format keeps it removed, while a
      // deployment that installed before curation existed still gets promoted.
      promotedFormatBlueprints: <string[]>[],
    },
  });
}

export type AdminSettingsStorage = ReturnType<typeof makeAdminSettingsStorage>;
