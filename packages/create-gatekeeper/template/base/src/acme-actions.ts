// What a gadget can change in Acme Service, as kit actions: each kind's approval text,
// auto-approval verdict and API call. Sessions validate and stage them (acme-session.ts); nothing
// here runs until a user approves.

import {
  defineActions, type ActionDefinition, type ActionSetOptions, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { Rest } from "./acme-api";
import { VENDOR_ID } from "./acme-env";

/** Every action's payload, by kind. */
export type AcmeActions = {
  rename: { itemId: string; title: string; stagedAt: string };
};

export type AcmeAction = TaggedAction<AcmeActions>;

/** What apply handlers may do. */
export type AcmeActionHost = {
  /** Runs a write as the connected user. */
  write<T>(op: (api: Rest) => Promise<T>): Promise<T>;
};

// A user's "always approve" rule is stored under the tag, so it can't change once shipped; the
// label is what the user sees.
const RENAME = { tag: "rename-items", label: "Rename items" };

// STOP(actions): One invented action. For each real one decide, and record in `action-table.json`
// (regenerate it with `vitest run -u`, and read the diff): its kind, whether it is
// `autoApprovable` (true unless the skill's opt-out policy applies), whether the session goes on
// with a simulated result or awaits the decision, whether a repeat after an unknown outcome is
// safe (`claimBeforeApply` if not), and its fence.

/** Every action a gadget can stage, by the name its stored records resolve by. */
export const definitions: { [K in keyof AcmeActions]: ActionDefinition<AcmeActions[K], AcmeActionHost> } = {
  rename: {
    kind: RENAME,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => ({
      title: sanitizeTitle("Rename an Acme Service item"),
      ...buildDescription(`Renames item ${payload.itemId}.`).verbatim("New title", payload.title).finish(),
      implementsRevert: false,
    }),
    apply: async (payload, host) => {
      await host.write(api => api.patch("/items/{id}", { path: { id: payload.itemId }, body: { title: payload.title } }));
    },
  },
};

/** What holds for every action, unless one is named as an exception. */
export const policy: ActionSetOptions<AcmeActionHost, AcmeActions> = {
  // Fenced on the connected user rather than the connection generation: a reconnect, which must be
  // the same user, must not strand what is waiting.
  fence: "authority",
  vendorId: VENDOR_ID,
};

export const actions = defineActions<AcmeActionHost, AcmeActions>(definitions, policy);
