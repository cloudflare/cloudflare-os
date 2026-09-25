import { recordActivity, type ActivityMetricInput } from "@gadgets/observability/metrics";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.analytics");

export type ProductAnalyticsConnectionType = "gatekeeper" | "ai_model" | "agent_spawner";

// The record written to Pipelines stream. Each event is also recorded as an `activity/v1` metric
// (see toActivityMetric).
//
// Events:
// - account_created: an account was created.
// - user_authenticated: a user authenticated.
// - gadget_created/opened/deleted: workspace lifecycle and open events ("gadget" here means the
//   workspace; `gadget_id` is its id).
// - gadget_interaction: chat, UI connection, and code merge interactions.
// - workpiece_created/committed: a gadget workpiece was created in a workspace, or its pending
//   creation was accepted.
// - connection_created/removed: gatekeeper, AI model, or agent spawner connections changed.
// - blueprint_created/imported: blueprint lifecycle events.
//
// Per-event shapes defined in ProductAnalyticsGadgetInput and ProductAnalyticsInput.

export type ProductAnalyticsRecord = {
  event_id: string;
  event_ts: string;
  event_name: string;
  user_id?: string;
  gadget_id?: string;
  properties: Record<string, unknown>;
};

/** Events about a specific gadget. */
export type ProductAnalyticsGadgetInput =
  | {
      event_name: "gadget_created";
      user_id: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      /** Whether the gadget was created from empty chat, via blueprint, or by external message. */
      source: "blank" | "blueprint" | "external_message";
      blueprint_id?: string;
    }
  | {
      event_name: "gadget_opened";
      user_id: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      /** Whether the gadget was opened with share link or not. */
      source: "direct" | "share_key";
    }
  | {
      event_name: "gadget_deleted";
      user_id: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
    }
  | {
      event_name: "gadget_interaction";
      user_id: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      /** Gadget-local id of the chat thread. */
      chat_id?: number;
      interaction_type: "gadget_ui_connected" | "chat_started" | "chat_message_sent" | "code_merged";
    }
  | {
      event_name: "connection_created";
      user_id: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      /** Gadget-local id of the connection. */
      gatekeeper_id: number;
      /** What type of connection was created: gatekeeper, model, agent. */
      connection_type: ProductAnalyticsConnectionType;
      vendor_id?: string;
    }
  | {
      event_name: "connection_removed";
      user_id: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      gatekeeper_id: number;
      connection_type?: ProductAnalyticsConnectionType;
      vendor_id?: string;
    }
  | {
      event_name: "blueprint_created";
      user_id: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      blueprint_id: string;
    }
  | {
      event_name: "workpiece_created";
      user_id?: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      workpiece_id: number;
      /** Whether the gadget is provisional to a chat until its changes are accepted. */
      pending: boolean;
    }
  | {
      event_name: "workpiece_committed";
      user_id?: string;
      gadget_id?: string;
      gadget_owner_user_id?: string;
      workpiece_id: number;
    };

export type ProductAnalyticsInput =
  | {
      event_name: "account_created";
      user_id: string;
      source: "password" | "cf_access" | "gatekeeper";
    }
  | {
      event_name: "user_authenticated";
      user_id: string;
      source: "password" | "cf_access" | "gatekeeper" | "session_token";
    }
  | {
      event_name: "blueprint_imported";
      user_id: string;
      blueprint_id: string;
    }
  | ProductAnalyticsGadgetInput;

export function recordAnalytics(
    ctx: ExecutionContext | DurableObjectState,
    env: Cloudflare.Env,
    event: ProductAnalyticsInput): void {
  sendProductAnalytics(ctx, env, event);
  recordActivity(toActivityMetric(event));
}

function sendProductAnalytics(
    ctx: ExecutionContext | DurableObjectState,
    env: Cloudflare.Env,
    event: ProductAnalyticsInput): void {
  try {
    if (!env.PRODUCT_ANALYTICS) {
      return;
    }

    // Pull the common fields up to columns; everything else becomes properties.
    let { event_name, user_id, gadget_id, ...properties } =
        event as ProductAnalyticsInput & { user_id?: string; gadget_id?: string };

    let record: ProductAnalyticsRecord = {
      event_id: crypto.randomUUID(),
      event_ts: new Date().toISOString(),
      event_name,
      user_id,
      gadget_id,
      properties,
    };

    let send = env.PRODUCT_ANALYTICS.send([record]).catch(err => {
      logger.warn("analytics send failed", {
        event: "analytics.send.failed", eventName: event_name, error: err,
      });
    });

    ctx.waitUntil(send);
  } catch (err) {
    logger.warn("analytics record failed", {
      event: "analytics.record.failed", eventName: event.event_name, error: err,
    });
  }
}

/** Maps a product analytics event to its `activity/v1` metric. */
export function toActivityMetric(event: ProductAnalyticsInput): ActivityMetricInput {
  switch (event.event_name) {
    case "account_created":
      return { eventType: "account.created", actorId: event.user_id, detail: event.source };
    case "user_authenticated":
      return { eventType: "user.authenticated", actorId: event.user_id, detail: event.source };
    case "blueprint_imported":
      return { eventType: "blueprint.imported", actorId: event.user_id };
    case "gadget_created":
      return {
        ...workspaceIds(event),
        // Whoever creates a workspace owns it, including callers that don't say so.
        ownerId: event.gadget_owner_user_id ?? event.user_id,
        eventType: "workspace.created",
        detail: event.source,
      };
    case "gadget_opened":
      return { ...workspaceIds(event), eventType: "workspace.opened", detail: event.source };
    case "gadget_deleted":
      return { ...workspaceIds(event), eventType: "workspace.deleted" };
    case "gadget_interaction":
      return {
        ...workspaceIds(event), eventType: "workspace.interaction", detail: event.interaction_type,
      };
    case "connection_created":
      return {
        ...workspaceIds(event), eventType: "connection.created", detail: event.connection_type,
      };
    case "connection_removed":
      return {
        ...workspaceIds(event), eventType: "connection.removed", detail: event.connection_type,
      };
    case "blueprint_created":
      return { ...workspaceIds(event), eventType: "blueprint.created" };
    case "workpiece_created":
      return {
        ...workspaceIds(event),
        eventType: "gadget.created",
        gadgetId: event.workpiece_id,
        gadgetState: event.pending ? "pending" : "permanent",
      };
    case "workpiece_committed":
      return {
        ...workspaceIds(event),
        eventType: "gadget.committed",
        gadgetId: event.workpiece_id,
        gadgetState: "permanent",
      };
  }
}

function workspaceIds(
    event: { user_id?: string; gadget_id?: string; gadget_owner_user_id?: string })
    : Pick<ActivityMetricInput, "actorId" | "ownerId" | "workspaceId"> {
  return {
    actorId: event.user_id,
    ownerId: event.gadget_owner_user_id,
    workspaceId: event.gadget_id,
  };
}
