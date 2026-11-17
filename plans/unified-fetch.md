# Plan: One fetch policy for webFetch, sandboxes and gatekeepers

Status: planned, not implemented.

## Goal

Agents can fetch web pages with the `webFetch` tool, but `fetch()` in gadget code and in
`executeCode` is blocked outright (`globalOutbound: null`). This plan:

1. Lets gadget server code and `executeCode` make GET and HEAD requests under the policy
   `webFetch` already enforces.
2. Gives gatekeepers a `Fetcher` that implements their caller's current fetch policy. A gatekeeper
   that runs untrusted code somewhere else, such as a container, installs it to filter that code's
   egress.

The policy lives in one place, behind the `Fetcher`. It will grow (a list of hosts known to be
safe, for example), and nothing outside the `Fetcher` should have to change when it does.

## Background

- **The policy today** is `OverseerImpl.authorizeWebFetch()` plus `validateWebFetchUrl()` in
  `web-fetch.ts`. Every URL must be `https:` with no embedded credentials.
  - A workspace that has not observed restricted data may fetch any public host.
  - A workspace that has (`storage.containsRestrictedData`, which latches and is never cleared)
    may fetch only `AdminConfig.restrictedWebFetchHosts`, with no query string and no `/cdn-cgi/`
    path.
  - Where `AdminConfig.restrictedWebFetchApprovals` is on, a URL those hosts refuse posts a
    `webFetchRequest` card to the chat and ends the agent's turn. An approval lasts for the turn,
    covers that exact URL, and covers its redirects.
- **SSRF** is handled by workerd: `global_fetch_strictly_public` on `workshop-backend` rejects
  non-public addresses after DNS resolution.
- **Sandboxes** are dynamic workers loaded with `globalOutbound: null`: `loadGadgetWorker()`,
  `executeCodeMode()` and the restore forger.
- **Gatekeepers** receive an `ApprovalQueue` per session (`Gatekeeper.startSession()`) and per
  hook firing (`HookInitiator.startHook()`). It already carries session context beyond approvals:
  `getGitCache()`, `watchSession()`, `getExecutionId()`. `GatekeeperHookLoopback` is the precedent
  for handing a gatekeeper a loopback stub it can keep.
- **The container gatekeeper is not in this repository.** Here the gatekeeper side is exercised
  through the test gatekeeper fixture (`packages/integration-tests/fixtures/gatekeeper-test`).

## Principles

- **One implementation.** `webFetch`, the sandboxes and gatekeepers all send requests through
  the same loopback entrypoint. There is no second copy of the policy.
- **The `Fetcher` is the whole interface.** Callers never see the policy's shape. A gatekeeper
  gets a `Fetcher` and installs it.
- **A snapshot is only as fresh as its holder's last refresh.** A gatekeeper is called at every
  point where new data can reach what it filters, so it can take a fresh `Fetcher` each time. The
  kernel's own sandboxes cannot: they read data through bindings mid-run, so their `Fetcher`
  resolves the policy on every request.
- **Small kernel diff.** One new entrypoint, one overseer method that replaces
  `authorizeWebFetch()`, one new `ApprovalQueue` method. The `webFetchRequest` card, its approval
  RPCs and the frontend are reused unchanged.

## Design

### `FetchLoopback` (`packages/workshop-backend/src/fetch-loopback.ts`)

A `WorkerEntrypoint` exported from `server.ts` beside the other loopbacks and minted through
`ctx.exports.FetchLoopback({props})`.

```ts
type FetchLoopbackProps = {
  overseerId: string;
  caller: GatekeeperCaller;

  // The executeCode call the fetcher was minted for, for an agent caller.
  executionId?: string;

  // The policy as it stood when the fetcher was minted, which it applies without asking the
  // workspace. Absent: ask the workspace on every request.
  snapshot?: FetchPolicy;
};

type FetchPolicy = {
  // The only hosts reachable, or undefined for any public host.
  allowedHosts?: string[];

  // Whether a user may approve a URL the policy refuses.
  approvals: boolean;
};
```

`fetch(request)` does this:

1. **Check the request.** Only GET and HEAD (anything else is a 405). The URL must pass
   `validateWebFetchUrl()` with no host list: `https:`, no embedded credentials.
2. **Decide.**
   - No snapshot: call `overseer.authorizeFetch()` (below).
   - Snapshot: check the URL against it locally with `validateWebFetchUrl()`. If it passes, allow
     with no round trip. If it fails, the policy allows approvals and the caller is an agent, call
     `overseer.authorizeFetch()`. Otherwise refuse.
3. **Send.** Build a new request from the method, the URL and an allowlist of the caller's
   headers: `accept`, `accept-language`, `range`, `if-range`, `if-none-match`,
   `if-modified-since`. `user-agent` is always `Cloudflare-OS/1.0`. Nothing else is copied, so
   `authorization`, `cookie` and `upgrade` are dropped (no credentials, no WebSockets), and so are
   the request's `cf` options. In a restricted workspace none of the caller's headers are
   forwarded: the request carries only the fixed `user-agent` and the `accept` value `webFetch`
   sends today. A header's value is a channel for the data the policy is holding back, and a
   user's approval names a URL, not what travels with it. The `Fetcher` knows the workspace is
   restricted from its snapshot (`allowedHosts` is set) or from `authorizeFetch()`'s answer.
4. **Redirects.** Fetch with `redirect: "manual"` and return a 3xx to the caller, whose next hop
   comes back through the `Fetcher` and is checked like any other request. The one exception is
   a URL allowed by a user's approval: the `Fetcher` follows that one itself
   (`fetchFollowingRedirects()`), because an approval covers its redirects, and names the URL the
   response came from in a `Cloudflare-OS-Fetch-Url` response header.
5. **Response.** Stream it back unchanged, except that a response with
   `Content-Signal: ai-input=no` is refused, as `webFetch` does today.

A refusal is a synthetic response, not a thrown error, so a container's HTTP client and JS code
see the same thing: status 403 (405 for the method), the reason as a `text/plain` body, and a
`Cloudflare-OS-Fetch-Refused` header whose value is `denied` or `approval-requested`.

Every `Cloudflare-OS-Fetch-*` header is removed from origin responses, so a site can neither fake
a refusal nor name a final URL.

### `OverseerImpl.authorizeFetch()`

Replaces `authorizeWebFetch()`. Takes the caller, its `executionId`, the method and the URL, and
returns allow (saying whether the workspace is restricted, and whether a user's approval is what
allowed it), or refuse with a message (optionally marked as approval requested).

- **Unrestricted workspace:** allow. This path reads only `storage.containsRestrictedData`, so the
  common case costs one Durable Object call and no KV read.
- **Restricted workspace:** read the admin config and apply the host list, as today.
- **Approvals:** only for an agent caller. A `webFetchRequest` already approved in this turn
  (`#webFetchApproved()`) allows. Otherwise the request is captured with
  `#captureDecisionRequest()` and refused as approval-requested, but only while the caller's
  execution is live (`isLiveExecution()`), or for the `webFetch` tool's own call, which has no
  execution. Outside that window nothing would attach the card to a step, so the request is
  simply refused.
- **Ended executions:** an agent caller whose `executionId` is no longer live or was stopped is
  refused, as its gatekeeper sessions are.
- **Audit:** each allowed request records an observation under `BUILTIN_TOOL_GATEKEEPER_ID`
  (`Fetched <host>`, `GET <url>`), attributed to the caller. `recordAgentObservation()` is
  generalised to take a caller. The `webFetch` tool stops recording its own.

A private `#fetchPolicy()` computes the `FetchPolicy` that both `authorizeFetch()` and snapshot
minting use.

### Sandboxes

- `loadGadgetWorker()`: `globalOutbound` becomes a `FetchLoopback` for
  `{from: "gadget", chatId, gadgetId}`, with no snapshot.
- `executeCodeMode()`: `globalOutbound` becomes a `FetchLoopback` for `{from: "agent", chatId}`
  and the call's `executionId`, with no snapshot.
- The restore forger keeps `globalOutbound: null`.
- Gadget client code and views are unchanged: they run in the browser sandbox and still have no
  network.

No snapshot is the point. Code in one `executeCode` call can read restricted data through a
binding and call `fetch()` on the next line, and a gadget's worker is cached across calls, so a
policy captured at load time would be wrong exactly when it matters.

**Ending the turn.** A refused `fetch()` in `executeCode` that asked for approval must end the
turn, as the `webFetch` tool does. pi calls `finishTurn` before `turn_end`, and the captured
decision requests are drained in the `turn_end` handler, which is too late for the stop decision.
So `finishTurn` takes them (`consumeCapturedDecisionRequests()`), latches `decisionRequested` when
there are any, and leaves the list for `turn_end` to persist, as it already does with
`capturedActionsForStep`. That covers `executeCode`, covers a container command the agent ran, and
replaces the special case in the `webFetch` tool. When the user approves, the agent is resumed,
runs its code again, and the same URL now passes `#webFetchApproved()`.

A connection request is captured the same way, and `requestConnection` ends the turn exactly when
it captured one, so its own latch becomes redundant too.

### The `webFetch` tool

`webFetch()` in `web-fetch.ts` takes a `Fetcher` in place of `allowedHosts` and sends each hop
through it, keeping its own redirect loop, timeout, size cap and Markdown conversion. The agent
loop passes it a no-snapshot `FetchLoopback` for the chat. A refused hop becomes the tool's error,
and an approval-requested refusal becomes its ordinary result, as now. Its `finalUrl`, which the
result reports and converted HTML links resolve against, is the last hop its own loop requested,
or the `Cloudflare-OS-Fetch-Url` header's value when the `Fetcher` followed redirects itself.

### Gatekeepers

```ts
export interface ApprovalQueue extends ObservationAuthorizer {
  /**
   * A Fetcher that applies this session's caller's fetch policy as it stands now: which hosts
   * the caller may reach, GET and HEAD only, no credentials. ...
   */
  getFetcher(): Promise<Fetcher>;
}
```

`ApprovalQueueImpl.getFetcher()` mints a `FetchLoopback` with the queue's caller and execution
and a snapshot of the current policy. It throws if the session has ended, as `requireLive()` does.
Hook firings get it through the queue `startHook()` returns, with their `{from: "hook"}` caller.

A snapshot does not expire. What makes a policy too permissive is the workspace observing
restricted data, and that data can reach what the `Fetcher` filters only through a call to the
gatekeeper, which is when the gatekeeper takes a new one. A long-running container that has
received nothing new from the workspace has nothing new to leak, so its `Fetcher` stays correct,
and it keeps working with no round trip to the workspace. An admin's change to the trusted hosts
likewise reaches a gatekeeper at its next call.

It goes on `ApprovalQueue`, not `ObservationAuthorizer`: a slash command's authorizer is for
authorization and audit only, and this is an egress capability.

**The contract, for the doc comment and the `write-gatekeeper` skill:**

- A `Fetcher` reflects the policy at the time it was made and never updates. Keeping it current
  is the gatekeeper's responsibility.
- Call `getFetcher()` on every call the gatekeeper receives, after its own
  `authorizeObservation()` calls and before it hands new data to whatever the `Fetcher` filters,
  and replace the one installed.
- Do those three steps (take the `Fetcher`, install it, deliver the data) as one serialized unit
  for each environment the `Fetcher` filters. Two overlapping calls must not interleave them:
  otherwise one can install the `Fetcher` it took earlier over the newer, stricter one the other
  installed before delivering restricted data. A `Fetcher` must never replace one taken after it.
- Requests the `Fetcher` allows locally are not recorded by the workspace. The gatekeeper audits
  its own work (the command it ran, for a container) through `authorizeObservation()`.
- The `Fetcher` is for code the gatekeeper hosts on the caller's behalf. The gatekeeper's own
  vendor calls keep using its own `fetch()`.

## Decisions

- **One PR, in the commits below.**
- **Headers are an allowlist in every mode.** This keeps `webFetch`'s rule of no credentials and
  blocks WebSocket upgrades. Gadgets cannot call key-authenticated APIs with it; those belong
  behind a gatekeeper. A restricted workspace forwards none of the caller's headers.
- **No approval without a chat turn to end.** A mainline gadget, a hook firing or a user's
  session is refused where an agent would be asked.
- **Workspace-decided requests are audited; snapshot-decided ones are not.**
- **Snapshots do not expire.** A gatekeeper refreshes its `Fetcher` whenever information flows
  into what it filters, and nothing else can make a snapshot too permissive.
- **`Content-Signal: ai-input=no` is enforced for every caller.**
- **The `user-agent` is `Cloudflare-OS/1.0`**, replacing `GadgetsWebFetch/1.0`.

## Behaviour changes to `webFetch`

Routing the tool through the `Fetcher` changes three things:

- **A redirect to a host the policy refuses now asks for approval** where approvals are on. Today
  it fails with "redirected to ..., which is not allowed". The user sees the real destination and
  the agent fetches it directly once approved.
- **The audit record is written when the request is allowed**, one per hop, and no longer carries
  the status, content type or body length.
- **The `user-agent` changes** from `GadgetsWebFetch/1.0` to `Cloudflare-OS/1.0`. The tool's
  other headers are unchanged.

## Commit sequence (one PR)

Ordered so each kernel diff can be read on its own. Every commit builds and passes tests.

1. **`FetchLoopback` and `authorizeFetch()`; `webFetch` goes through them.** `fetch-loopback.ts`,
   the `server.ts` export, `authorizeFetch()` replacing `authorizeWebFetch()`, the generalised
   observation record, `web-fetch.ts` taking a `Fetcher`, and the turn-end latch moved to
   `finishTurn`'s capture of decision requests. Unit tests for the entrypoint; `web-fetch.test.ts`
   and `workshop-restricted-web-fetch.test.ts` updated for the changes above.
2. **Sandbox fetch.** `globalOutbound` in `loadGadgetWorker()` and `executeCodeMode()`, and the
   three prompt passages in `agent.ts` that say `fetch()` does not work (the gadget sandbox
   description, the `webFetch` tool description, the `executeCode` tool description). Integration
   tests.
3. **`ApprovalQueue.getFetcher()`.** The `workshop-shared` method with its doc comment,
   `ApprovalQueueImpl.getFetcher()`, and policy snapshots.
4. **Gatekeeper-side tests.** A session method on the test gatekeeper fixture that fetches through
   `queue.getFetcher()`, its integration test, and `getFetcher()` on the fake queues in
   `gatekeeper-google`'s tests.
5. **Docs.** `docs/unified-fetch.md` describing the design as built, the contract in
   `.agents/skills/write-gatekeeper/SKILL.md`, and the `authorizeWebFetch` references in
   `docs/observers.md` and `docs/testing.md`.

The internal repository's gatekeepers and fake queues need `getFetcher()` too once commit 3 lands
there.

## Runtime assumptions

The design relies on the following workerd behaviour, which Kenton confirmed:

- Worker Loader accepts a `ctx.exports` stub with props as `globalOutbound`.
- A sandbox's redirect hops re-enter `globalOutbound`.
- `connect()` from a sandbox stays blocked when `globalOutbound` is an entrypoint with no
  `connect` handler.
- The entrypoint's own `fetch()` keeps `global_fetch_strictly_public`, since it runs in
  `workshop-backend`.
- The stub survives being passed to a gatekeeper over RPC and stored, as `GatekeeperHookLoopback`
  stubs do.

One assumption is about the test harness, not workerd: the integration tests' `NetworkInterceptor`
must see the fetches `FetchLoopback` makes. It patches the Node process's `fetch()`, which the
harness routes each Worker's outbound `fetch()` through, and it already intercepts the `webFetch`
tool's requests from the Overseer in `workshop-restricted-web-fetch.test.ts`. An entrypoint of the
same Worker should use the same outbound; commit 1's updated `webFetch` tests show whether it
does.

## Testing

- **Unit (`workshop-backend/__tests__`):** method refusal; header allowlist, and no caller
  headers once restricted; `https:` and credential checks; a 3xx returned to the caller; an
  approved URL's redirects followed, with the final URL in `Cloudflare-OS-Fetch-Url`;
  `Cloudflare-OS-Fetch-*` headers stripped from origin responses; `Content-Signal`; a snapshot
  allowing and refusing locally, and asking the workspace where approvals are on.
- **Integration (`packages/integration-tests`):**
  - `executeCode` fetches a page; a POST is refused.
  - `executeCode` reads restricted data and fetches in the same call: refused. This is the case
    the no-snapshot mode exists for.
  - Restricted with a trusted host: allowed without a query string, refused with one.
  - Approvals on: the fetch is refused, the turn ends on a `webFetchRequest` card with no further
    model request, and after approval the resumed turn's fetch succeeds. The same for the
    `webFetch` tool.
  - An approved URL fetched from `executeCode` with caller headers set: the origin receives none
    of them.
  - `webFetch` on an approved URL that redirects to another origin reports the final URL and
    resolves the page's links against it.
  - A gadget's server code fetches; the same gadget is refused once the workspace is restricted.
  - The test gatekeeper fetches through `queue.getFetcher()`, unrestricted and restricted, and a
    `Fetcher` taken before the workspace became restricted is replaced by the next call's.
  - Each allowed request appears in the action log.
- **End to end:** one agent turn through `pnpm cf-os api` against `pnpm dev-server`, fetching from
  `executeCode`.

## Known limitations

- **No rate limit.** A gadget can loop requests from the deployment's addresses.
- **`wrangler dev` reaches private addresses**, as `webFetch` already does there; this now
  extends to gadget code.
- **A polling gadget fills the action log**, one observation per request.
- **A fixed `user-agent`** may be refused by registries a container wants to reach.

## Future work

- Hosts known to be safe in a restricted workspace, added inside `#fetchPolicy()` and
  `validateWebFetchUrl()` with no change to callers.
- Approval for callers with no chat turn, through the action queue.
- Coalescing repeated fetch observations.
