// The pages every MCP gatekeeper serves in a browser tab during connect: "connected" (the kit's
// handoff page), "that link expired", and "it didn't work, here's why". All of it comes from the
// kit, re-exported so both connectors take it from one place: its `htmlResponse` is the hardened
// one (no caching, no framing, no referrer), which matters because the handoff page carries the
// ticket.
//
// Anything a gatekeeper asks the user is *not* here. Only `gatekeeper-mcp` has a question to ask (see
// its `connect-form.ts`); the gateway's endpoint is a deployment setting, so it has no form and would
// carry the form's markup and CSS for nothing.

export {
  connectHandoffPageHtml,
  errorPageHtml,
  escapeHtml,
  htmlResponse,
  INVALID_LINK_HTML,
  PAGE_STYLE,
} from "@gadgets/gatekeeper-kit/connect-pages";
