// The approval-card description for the one action this gatekeeper submits, kept free of Workers
// imports so its verdict can be unit-tested.

import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import type { PageRequest } from "./types";

/** The kind every `enrich*` request carries. */
export const ENRICH_ACTION: ActionKind = { tag: "zoominfo.enrich", label: "Enrich records (spends credits)" };

/** The kinds an action can be auto-approved under: none, because an enrichment never is. */
export const AUTO_APPROVABLE_KINDS: ActionKind[] = [];

/**
 * The description submitted for an enrichment. `summary` opens the prose, so the caller passes
 * every agent value in it through `codeSpan` (`fieldList` for lists); the request itself is shown
 * exactly in the fields.
 */
export function enrichmentActionDescription(
  summary: string,
  attributes: Record<string, unknown>,
  worstCaseCredits: number,
  page?: PageRequest,
): ActionDescription {
  return {
    title: `ZoomInfo: ${summary}`,
    // The request body is what leaves the workspace (names, emails, company identifiers), so
    // the approver sees it exactly, after the summary and the cost.
    ...buildDescription(
      `${summary}\n\n**Credit cost:** up to **${worstCaseCredits}** ZoomInfo bulk-data ` +
      `credit${worstCaseCredits === 1 ? "" : "s"} (fewer if records are already under ` +
      `management; none for no-match/error results). Charged only on approval.`)
      .json("Request", attributes)
      .json("Page", page ?? {})
      .finish(),
    actionKind: ENRICH_ACTION,
    // Every enrichment may spend billed credits, and whether a record costs anything is only known
    // from ZoomInfo's response, so it is never auto-approved.
    autoApprovable: false,
    // Spent credits can't be refunded, so there is no automatic revert.
    implementsRevert: false,
    // No simulation: suspend the agent until the user decides rather than letting it read back
    // un-enriched state.
    awaitDecision: true,
  };
}
