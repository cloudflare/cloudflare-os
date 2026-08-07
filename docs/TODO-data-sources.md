# TODO: connecting data sources

Parked 2026-08-07. Context gathered during the seat-proxy work; nothing here is started.

## Why this is the important one

Cloudflare OS has **no vector search and no embeddings anywhere**. The Context gatekeeper is not a
RAG system: `createContextCollection` accepts only `web` or `git` sources, and the agent finds
things by reading document descriptions, not by similarity. Any retrieval capability has to come
from outside.

The original motivation for this whole project was that an existing harness "isn't answering as
well as I'd want". Swapping the chat UI does not fix that — retrieval quality lives in the layer
being kept. This item is the one most likely to actually improve answers.

## Three sources, three different problems

### 1. Private Google (Gmail, Docs, Sheets, Calendar) — configuration, not code

`packages/gatekeeper-google` already covers these. It needs a Google Cloud OAuth client:

- Enable Gmail, Docs, Drive, Sheets, Calendar APIs
- OAuth consent screen → External; **add yourself as a Test User** (while in Testing mode only
  listed users can authorise — the usual cause of an unexplained failure)
- Credentials → OAuth client ID → Web application, redirect URI exactly
  `http://localhost:8787/gatekeeper/google/oauth`
- Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the root `.dev.vars` (already stubbed there).
  `run-dev-server.js`'s `SHARED_GATEKEEPER_CREDS` maps them into the gatekeeper's
  `CLIENT_ID`/`CLIENT_SECRET`, so the per-package `.env` the README describes is unnecessary.

**Known limits, verified in the README, not assumed:**
- **Drive is metadata-only** — used solely so the resource pickers can search Docs/Sheets by title.
  A PDF or image in Drive is not readable. Native Docs and Sheets are, via their own APIs.
- Resources attach **one at a time**, with scopes requested per resource. There is no
  "index my whole account".

### 2. Work policy documents (DB + blob) — needs diagnosis before wiring

A search layer already exists in front of them, and **it is the one that answers badly**. Connecting
it unchanged moves the weakness into Cloudflare OS rather than fixing it.

So the first task is diagnosis, not integration. Likely suspects, in rough order of how often they
are the cause: chunking strategy, no reranking, embedding model mismatch, retrieval mode
(pure vector where hybrid is needed), and metadata filtering that silently excludes documents.

Once retrieval is worth exposing, the integration options are:

| Option | Shape | Trade |
|---|---|---|
| Custom gatekeeper | A small Worker exposing typed methods (`hybridSearch`, `fetchBlob`) that call the existing services over HTTPS | Gains the audit log, approval queue and sandboxing; the data plane never moves |
| `gatekeeper-mcp` | Point it at a **remote HTTP** MCP server wrapping the retrieval layer | Least Cloudflare OS code; needs an HTTP transport, and Odysseus's `mcp_servers/rag_server.py` is **stdio**, so it would need a shim |
| Re-index into Cloudflare | Vectorize / R2 / D1 | Largest lift, and Cloudflare OS has no vector layer today, so it means building one |

### 3. Folder on the local PC — a bridge service

Cloudflare OS runs on workerd and cannot read a local filesystem. This needs a small local service
exposing the directory over HTTP — the same shape as `seat-proxy/`, which is a working precedent
for the pattern. Only ever works on that machine, so it is a home-instance feature, not a work one.

## Order agreed

1. Google (fastest real value, and exercises the gatekeeper path end to end)
2. Work policy documents (highest value, needs design)
3. Local folder bridge

## Related open items from the seat-proxy work

- Deleting a model in Cloudflare OS does not revoke the seat handle at the proxy — `revokeSeat`
  exists and is wired to no caller, so handles leak.
- The proxy's pending-enrollment map is in-process and never expires: a restart loses in-flight
  enrollments, and entries holding live PKCE verifiers accumulate.
- Usernames containing `+`, spaces, non-ASCII, or over 64 characters fail as an opaque
  "Seat sign-in failed (400)".
- Both file-permission tests skip on Windows, so the `0600` guarantee protecting refresh tokens is
  unverified on a Windows dev machine. It only holds if CI or the deployment target is POSIX.
- No backend test covers the `newChat` → `startAgent` chain, so the new-chat thinking-level path is
  verified by inspection rather than execution.
