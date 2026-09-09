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
    { name: "zendesk_add_comment", title: "Add Zendesk comment", description: "Queue a public or internal Zendesk comment for approval.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^\\d+$" }, body: { type: "string", minLength: 1, maxLength: BODY_MAX }, visibility: { type: "string", enum: ["internal", "public"] }, attachmentTokens: { type: "array", items: { type: "string", maxLength: 1600 }, maxItems: MAX_UPLOAD_TOKENS } }, required: ["id", "body"], additionalProperties: false } },
    { name: "zendesk_update_fields", title: "Update Zendesk fields", description: "Queue allowlisted Zendesk ticket field updates for approval.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^\\d+$" }, fields: { type: "object", maxProperties: 10, additionalProperties: true } }, required: ["id", "fields"], additionalProperties: false } },
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
