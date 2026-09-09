import type {
  ZendeskActionResult,
  ZendeskCodingSessionToolInfo,
  ZendeskCodingSessionToolResult,
  ZendeskQueuedAction,
} from "./types.js";

const BODY_MAX = 12_000;
const MAX_LIMIT = 50;
const MAX_UPLOAD_TOKENS = 10;
const CURSOR_MAX = 2_048;

export function codingTools(): ZendeskCodingSessionToolInfo[] {
  return [
    { name: "zendesk_get_current_user", title: "Get current Zendesk user", description: "Read the signed-in Zendesk user's id, display name, and email when available.", mode: "read", classifiedBy: "server-annotation", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "zendesk_search_tickets", title: "Search Zendesk tickets", description: "Search tickets in the connected Zendesk subdomain. assignedToMe filters by the signed-in user's assignee ID, not requester. Keep query, limit, and exhaustive unchanged while paging; do not combine assignedToMe with an assignee query term. The default path stops at Zendesk's 1,000-result ceiling and reports completeness.zendesk=false; set exhaustive=true on the first page to page every match through the export endpoint (ordered by created_at, cursors expire after one hour). Never restate results as complete unless completeness.zendesk is true.", mode: "read", classifiedBy: "server-annotation", inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 300 }, assignedToMe: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT }, exhaustive: { type: "boolean" }, cursor: { type: "string", maxLength: CURSOR_MAX } }, additionalProperties: false } },
    { name: "zendesk_read_ticket", title: "Read Zendesk ticket", description: "Read normalized Work Items data for one Zendesk ticket.", mode: "read", classifiedBy: "server-annotation", inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^\\d+$" } }, required: ["id"], additionalProperties: false } },
    {
      name: "zendesk_create_ticket", title: "Create Zendesk ticket",
      description: "Create one ticket in the connected account with an initial internal comment unless public is explicit. Set subject only at the top level; fields.subject is rejected. Returns a pending action ID; poll that ID instead of creating again. The completed result contains the real id, key, and URL. Interrupted writes report a failed result with unknown-outcome guidance: verify Zendesk before any new creation. No attachments, CCs, or new requester creation. Available only on account bindings.",
      mode: "action", classifiedBy: "default",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["subject", "comment"],
        properties: {
          subject: { type: "string", minLength: 1, maxLength: 300 },
          comment: { type: "object", additionalProperties: false, required: ["body"], properties: { body: { type: "string", minLength: 1, maxLength: BODY_MAX }, visibility: { type: "string", enum: ["internal", "public"], default: "internal" } } },
          requesterId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Existing requester ID. Omit to use Zendesk's default requester." },
          fields: {
            type: "object", maxProperties: 10, additionalProperties: false,
            properties: {
              status: { type: "string", enum: ["new", "open", "pending", "hold", "solved"] },
              priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
              type: { type: "string", enum: ["problem", "incident", "question", "task"] },
              assignee_id: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
              group_id: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
              tags: { type: "array", maxItems: 50, items: { type: "string", maxLength: 120 } },
            },
            patternProperties: { "^custom_[1-9][0-9]*$": { anyOf: [{ type: "string", maxLength: 2000 }, { type: "number" }, { type: "boolean" }, { type: "null" }, { type: "array", maxItems: 50, items: { type: "string", maxLength: 120 } }] } },
          },
        },
      },
    },
    { name: "zendesk_add_comment", title: "Add Zendesk comment", description: "Queue a public or internal Zendesk comment for approval.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^\\d+$" }, body: { type: "string", minLength: 1, maxLength: BODY_MAX }, visibility: { type: "string", enum: ["internal", "public"] }, attachmentTokens: { type: "array", items: { type: "string", maxLength: 1600 }, maxItems: MAX_UPLOAD_TOKENS } }, required: ["id", "body"], additionalProperties: false } },
    { name: "zendesk_update_fields", title: "Update Zendesk fields", description: "Queue edits to subject, status, priority, type, assignee_id, group_id, tags, or custom_<id> for approval. subject must be a nonblank string of at most 300 characters with no NUL bytes; it replaces the ticket title. Pending edits are reflected in ticket reads. tags replaces the entire tag list. Concurrent changes fail with a conflict; read the latest ticket before resubmitting.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^\\d+$" }, fields: { type: "object", minProperties: 1, maxProperties: 10, properties: { subject: { type: "string", minLength: 1, maxLength: 300, pattern: "^(?![\\s\\S]*\\u0000)[\\s\\S]*\\S[\\s\\S]*$" } }, additionalProperties: true } }, required: ["id", "fields"], additionalProperties: false } },
  ];
}

export function toolOk(value: unknown): ZendeskCodingSessionToolResult {
  const text = String(JSON.stringify(value, null, 2)).slice(0, 24_000);
  return { status: "ok", content: [{ type: "text", text }], text, structuredContent: value };
}

export function toolPending(action: ZendeskQueuedAction, message: string): ZendeskCodingSessionToolResult {
  return { status: "pending", actionId: action.actionId, message };
}

export function zendeskActionResultToToolResult(result: ZendeskActionResult, actionId: number): ZendeskCodingSessionToolResult {
  if (result.status === "ready") return toolOk(result.result);
  if (result.status === "failed") return { status: "failed", message: result.message };
  if (result.status === "rejected") return { status: "rejected", message: "Zendesk action was rejected in Workshop." };
  return { status: "pending", actionId, message: "Zendesk action is still pending." };
}
