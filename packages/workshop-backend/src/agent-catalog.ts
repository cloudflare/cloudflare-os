import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES,
  AGENT_CATALOG_MAX_ID_LENGTH, AGENT_CATALOG_MAX_TITLE_LENGTH,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type { AiChatMessage, AlwaysAvailableResource } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.agent.catalog");

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
export function formatAlwaysAvailableResourcesPrompt(resources: AlwaysAvailableResource[]): string {
  let lines = resources.map(resource =>
    `- ${resource.title}: \`env.${resource.name}\`${formatAgentCatalogPrompt(resource.catalog)}`);
  return `The following resources are always available as bindings in your env for use with the ` +
    `executeCode tool (you don't need to request them):\n${lines.join("\n")}\n` +
    `When one is relevant, use describeBinding with the binding's name to learn its API before ` +
    `using it. If a Gadget's persistent code needs one, wire it into that gadget with ` +
    `setGadgetBinding.`;
}

/**
 * Each always-available resource as the agent last saw it before `sequence`: `listed`, as the system
 * prompt lists them, updated by each "catalogChange" message before that point.
 */
export function seenAlwaysAvailableResources(
    listed: AlwaysAvailableResource[], messages: AiChatMessage[], sequence: number)
    : Map<string, AlwaysAvailableResource> {
  let seen = new Map(listed.map(resource => [resource.name, resource]));
  for (let message of messages) {
    if (message.type === "catalogChange" && message.sequence < sequence) {
      for (let resource of message.resources) seen.set(resource.name, resource);
    }
  }
  return seen;
}

/**
 * The resources in `current` to tell the agent about: those it hasn't seen, and those whose catalog
 * would show differently from the one it last saw. A null catalog failed to load (or there is
 * none), so it says nothing about what changed.
 */
export function findCatalogChanges(
    seen: ReadonlyMap<string, AlwaysAvailableResource>, current: AlwaysAvailableResource[])
    : AlwaysAvailableResource[] {
  return current.filter(resource => {
    let before = seen.get(resource.name);
    return before === undefined || (resource.catalog !== null &&
        formatAgentCatalogPrompt(resource.catalog) !== formatAgentCatalogPrompt(before.catalog));
  });
}

const serializedEntries = (catalog: AgentCatalog | null) =>
    new Set(catalog?.entries.map(entry => JSON.stringify(entry)));

/**
 * What the agent is told about a resource that changed since it last saw it (`before`), or that it
 * hasn't seen: the entries added and those no longer listed, as JSON like the system prompt shows
 * them.
 */
export function formatCatalogChange(
    resource: AlwaysAvailableResource, before: AlwaysAvailableResource | undefined): string {
  let binding = `\`env.${resource.name}\` (${resource.title})`;
  if (before === undefined) {
    return `${binding} is now always available in your env. Use ` +
        `describeBinding("${resource.name}") to learn its API before using it.` +
        formatAgentCatalogPrompt(resource.catalog);
  }
  let was = serializedEntries(before.catalog);
  let now = serializedEntries(resource.catalog);
  let added = [...now].filter(entry => !was.has(entry));
  let dropped = [...was].filter(entry => !now.has(entry));
  let lines = [`The catalog of ${binding} changed outside this conversation.`];
  if (added.length > 0) lines.push(`Added: [${added.join(",")}]`);
  if (dropped.length > 0) lines.push(`No longer listed: [${dropped.join(",")}]`);
  let truncated = resource.catalog?.truncated === true;
  if (truncated !== (before.catalog?.truncated === true)) {
    lines.push(truncated
        ? "The list is now partial: there are more entries than it shows."
        : "The list is now complete.");
  }
  return lines.join("\n");
}
