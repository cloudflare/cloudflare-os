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
  type AmbientGatekeeperMode, type BannerConfig, type BlueprintOutput, type BlueprintPublicInfo,
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
