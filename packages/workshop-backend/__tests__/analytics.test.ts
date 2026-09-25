import { describe, expect, it } from "vitest";
import type { ActivityEventType } from "@gadgets/observability/metrics";
import { toActivityMetric, type ProductAnalyticsInput } from "../src/analytics.js";

const USER = "a".repeat(64);
const OWNER = "b".repeat(64);
const WORKSPACE = "c".repeat(64);
const workspace = { user_id: USER, gadget_id: WORKSPACE, gadget_owner_user_id: OWNER };

// Keyed by event name, so a new ProductAnalyticsInput variant fails to type-check until it is
// given an expected metric here.
const CASES: { [N in ProductAnalyticsInput["event_name"]]:
    [Extract<ProductAnalyticsInput, { event_name: N }>, ActivityEventType] } = {
  account_created:
      [{ event_name: "account_created", user_id: USER, source: "gatekeeper" }, "account.created"],
  user_authenticated:
      [{ event_name: "user_authenticated", user_id: USER, source: "password" },
       "user.authenticated"],
  blueprint_imported:
      [{ event_name: "blueprint_imported", user_id: USER, blueprint_id: "bp" },
       "blueprint.imported"],
  gadget_created:
      [{ event_name: "gadget_created", ...workspace, source: "blank" }, "workspace.created"],
  gadget_opened:
      [{ event_name: "gadget_opened", ...workspace, source: "direct" }, "workspace.opened"],
  gadget_deleted: [{ event_name: "gadget_deleted", ...workspace }, "workspace.deleted"],
  gadget_interaction:
      [{ event_name: "gadget_interaction", ...workspace, interaction_type: "chat_started" },
       "workspace.interaction"],
  connection_created:
      [{ event_name: "connection_created", ...workspace, gatekeeper_id: 1,
         connection_type: "gatekeeper" }, "connection.created"],
  connection_removed:
      [{ event_name: "connection_removed", ...workspace, gatekeeper_id: 1 },
       "connection.removed"],
  blueprint_created:
      [{ event_name: "blueprint_created", ...workspace, blueprint_id: "bp" }, "blueprint.created"],
  workpiece_created:
      [{ event_name: "workpiece_created", ...workspace, workpiece_id: 4, pending: true },
       "gadget.created"],
  workpiece_committed:
      [{ event_name: "workpiece_committed", ...workspace, workpiece_id: 4 }, "gadget.committed"],
};

describe("toActivityMetric", () => {
  it.each(Object.values(CASES))("maps %o", (event, eventType) => {
    expect(toActivityMetric(event).eventType).toBe(eventType);
  });

  it("carries the workspace ids and the event's qualifier", () => {
    expect(toActivityMetric(CASES.gadget_interaction[0])).toEqual({
      eventType: "workspace.interaction",
      actorId: USER,
      ownerId: OWNER,
      workspaceId: WORKSPACE,
      detail: "chat_started",
    });
  });

  it("treats a workspace's creator as its owner when the caller doesn't name one", () => {
    expect(toActivityMetric(
        { event_name: "gadget_created", user_id: USER, gadget_id: WORKSPACE, source: "blank" }))
        .toMatchObject({ actorId: USER, ownerId: USER });
  });

  it("records a gadget's state", () => {
    expect(toActivityMetric(CASES.workpiece_created[0]))
        .toMatchObject({ gadgetId: 4, gadgetState: "pending" });
    expect(toActivityMetric(CASES.workpiece_committed[0]))
        .toMatchObject({ gadgetId: 4, gadgetState: "permanent" });
  });
});
