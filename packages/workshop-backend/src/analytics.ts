import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.analytics");

export type ProductAnalyticsConnectionType = "gatekeeper" | "ai_model" | "agent_spawner";

// The record written to Pipelines stream.
//
// Events:
// - account_created: an account was created.
// - user_authenticated: a user authenticated.
// - gadget_created/opened/deleted: gadget lifecycle and open events.
// - gadget_interaction: chat, UI connection, and code merge interactions.
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
      /** Whether the gadget was created from empty chat or via blueprint. */
      source: "blank" | "blueprint";
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
    };

export type ProductAnalyticsInput =
  | {
      event_name: "account_created";
      user_id: string;
      source: "password" | "cf_access";
    }
  | {
      event_name: "user_authenticated";
      user_id: string;
      source: "password" | "cf_access" | "session_token";
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
