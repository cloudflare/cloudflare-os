# MCP shared

The shared implementation behind the two MCP gatekeepers — `gatekeeper-mcp` (endpoints a user
pastes) and `gatekeeper-mcp-portal` (one admin-configured portal). Not a Worker; a library both
import, holding the MCP client, the OAuth chain, the account DO base, the resource-URL scope grammar,
and the queued-action store. See `README.md` and each connector's README.

- The trust boundary is `tools.ts`, and nothing outside it reads a tool's annotations: a tool the
  server declares `readOnlyHint: true` runs as an observation, everything else is queued for
  approval, and auto-*applying* a write additionally requires a `vetted` endpoint — which only the
  portal can produce, via `MCP_PORTAL_TRUST_ANNOTATIONS`.
- OAuth uses the official `@modelcontextprotocol/client`; always give SDK OAuth operations
  `sdkFetch(...)` so every request and redirect retains endpoint and SSRF checks.
- Every outbound request goes through the calling gatekeeper's kit upstream (`upstream.ts`), with
  `guardedFetch` as its `fetch` and a name from the closed lists there. The library declares no
  upstream of its own; a new kind of request gets a name in those lists and a row in
  `__tests__/upstream.test.ts`.
