import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES,
  AGENT_CATALOG_MAX_ID_LENGTH, AGENT_CATALOG_MAX_TITLE_LENGTH,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.agent.catalog");

export type AgentCatalogSnapshot = {
  gatekeeperId: number;
  catalog: AgentCatalog | null;
};

function normalizeText(value: string, maxLength: number): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Workshop-side re-validation of a gatekeeper's catalog (the gatekeeper output is untrusted): strip
 * control chars / collapse whitespace, drop unusable entries, and re-clamp to the global
 * AGENT_CATALOG_MAX_* bounds. Gatekeepers should apply the same caps before RPC, but the Workshop
 * does not trust them to do so. `id` keeps the full bound since it is the opaque key the agent passes
 * back; only the title/description need shortening. The count clamp drops from the tail so the
 * gatekeeper's priority order decides what survives; the survivors are then sorted for display.
 */
export function normalizeAgentCatalog(catalog: AgentCatalog): AgentCatalog {
  let entries = catalog.entries
      .map(entry => ({
        id: normalizeText(entry.id, AGENT_CATALOG_MAX_ID_LENGTH),
        title: normalizeText(entry.title, AGENT_CATALOG_MAX_TITLE_LENGTH),
        description: normalizeText(entry.description, AGENT_CATALOG_MAX_DESCRIPTION_LENGTH),
      }))
      .filter(entry => entry.id.length > 0 && entry.title.length > 0);
  let dropped = entries.length > AGENT_CATALOG_MAX_ENTRIES;
  if (dropped) {
    logger.warn("agent catalog exceeded the entry cap", {
      event: "agent.catalog.truncated", size: entries.length,
    });
  }
  return {
    entries: entries
        .slice(0, AGENT_CATALOG_MAX_ENTRIES)
        .toSorted((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
    ...(catalog.truncated === true || dropped ? {truncated: true} : {}),
  };
}

export async function completeAgentCatalogSnapshot(
    existing: AgentCatalogSnapshot[] | undefined,
    gatekeeperIds: number[],
    loadCatalog: (gatekeeperId: number) => Promise<AgentCatalog | null>):
    Promise<{snapshots: AgentCatalogSnapshot[], changed: boolean}> {
  let activeIds = new Set(gatekeeperIds);
  let existingCount = existing?.length ?? 0;
  let catalogs = new Map(
      existing
          ?.filter(entry => activeIds.has(entry.gatekeeperId))
          .map(entry => [entry.gatekeeperId, entry.catalog]));
  let removedStaleEntries = catalogs.size !== existingCount;
  let missing = gatekeeperIds.filter(gatekeeperId => !catalogs.has(gatekeeperId));
  await Promise.all(missing.map(async gatekeeperId => {
    // Isolate per entry: one failing loader must not reject the whole snapshot (it would lose every
    // other catalog and abort the turn). A failed/empty load is recorded as null, like any other.
    try {
      catalogs.set(gatekeeperId, await loadCatalog(gatekeeperId));
    } catch (error) {
      logger.warn("failed to load agent catalog", {
        event: "agent.catalog.load.failed", gatekeeperId, error,
      });
      catalogs.set(gatekeeperId, null);
    }
  }));
  return {
    snapshots: [...catalogs]
        .toSorted(([left], [right]) => left - right)
        .map(([gatekeeperId, catalog]) => ({gatekeeperId, catalog})),
    changed: missing.length > 0 || removedStaleEntries,
  };
}

/** The catalog as a JSON blob for inclusion in a prompt, on its own line, or "" if empty. */
export function formatAgentCatalogPrompt(catalog: AgentCatalog | null): string {
  if (!catalog?.entries.length) return "";
  return `\n${JSON.stringify(catalog)}`;
}

/**
 * Build the system-prompt section that tells the agent which always-available resource bindings it
 * has (their `env.NAME` entries) plus each one's discovery catalog, and how to use them. This
 * describes the agent's environment rather than anything the user said, so it lives in the system
 * prompt alongside the bindings list rather than as a synthetic user turn.
 */
export function formatAlwaysAvailableResourcesPrompt(resources: Array<{
  title: string;
  name: string;
  catalog: AgentCatalog | null;
}>): string {
  let lines = resources.map(resource =>
    `- ${resource.title}: \`env.${resource.name}\`${formatAgentCatalogPrompt(resource.catalog)}`);
  return `The following resources are always available as bindings in your env for use with the ` +
    `executeCode tool (you don't need to request them):\n${lines.join("\n")}\n` +
    `When one is relevant, use describeBinding with the binding's name to learn its API before ` +
    `using it. If a Gadget's persistent code needs one, wire it into that gadget with ` +
    `setGadgetBinding.`;
}
