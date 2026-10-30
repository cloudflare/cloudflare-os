// The approval-card description for the one action this gatekeeper submits, kept free of Workers
// imports so its verdict can be unit-tested.

import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import type { SupabaseValue } from "./types";

/** The kind every `execute()` statement carries. */
export const RUN_SQL_ACTION: ActionKind = { tag: "supabase.runSql", label: "Run SQL" };

/** The kinds an action can be auto-approved under: none, because `execute()` is never. */
export const AUTO_APPROVABLE_KINDS: ActionKind[] = [];

/** The description submitted for an `execute()` statement against project `ref`. */
export function executeActionDescription(ref: string, sql: string, params?: SupabaseValue[]): ActionDescription {
  return {
    title: "Run SQL on Supabase",
    // A field shows the statement literally, so nothing in it can escape into the prose.
    ...buildDescription(`Execute a mutating SQL statement against Supabase project ${codeSpan(ref)}.`)
      .verbatim("SQL", sql, "sql")
      .json("Parameters", params ?? [])
      .finish(),
    actionKind: RUN_SQL_ACTION,
    // Arbitrary SQL: one kind covers both benign statements and destructive ones (DROP, TRUNCATE,
    // GRANT, several statements at once), and no parser here can tell them apart safely, so it is
    // never auto-approved.
    autoApprovable: false,
    // Arbitrary SQL cannot be automatically reverted.
    implementsRevert: false,
    // This gatekeeper doesn't simulate writes, so the agent shouldn't continue (and read back
    // un-applied state) until the user decides on this statement.
    awaitDecision: true,
  };
}
