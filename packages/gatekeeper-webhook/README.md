# Webhooks

Webhooks is an ambient Gatekeeper that gives each workspace its own inbound HTTP endpoints. A
third-party service POSTs to an endpoint's URL with its bearer token; the request is queued and
delivered to a persistent workspace callback as a `WebhookEvent`. Each account also gets a
management app at `/gatekeepers/webhook`.

Endpoints are **per workspace**. The account coordinates storage and the public URL space, but a
registration made in one workspace is only ever delivered to that workspace, and `list()` never
crosses workspace boundaries.

## User flow

1. Ask the agent to set up a webhook, or open **Webhooks** and choose a starter prompt.
2. Confirm which service will call it and what the workspace should do with each event.
3. The agent registers a persistent callback. Registration returns the URL and a **one-time bearer
   token**, and creates a *disabled* hook.
4. Enable the hook in the Workshop's Connections UI. Until then the URL answers `503`.
5. Paste the URL and token into the third-party service.
6. Use **Webhooks** to see delivery history, rotate a token, or delete an endpoint.

## The endpoint URL

```
POST https://<instance>/gatekeeper/webhook/e/<endpointId>
Authorization: Bearer <token>
```

The response is `202` with a JSON body carrying the `deliveryId`. The request is *queued*, not
handled inline: an agent turn takes far longer than any sender will wait, and most senders retry or
disable an endpoint that answers slowly.

| Status | Meaning |
| --- | --- |
| `202` | Accepted and queued. |
| `401` | Missing or wrong bearer token. Checked before anything else, so an unauthorized caller learns nothing about the endpoint. |
| `404` | No such endpoint, or it was deleted. |
| `405` | A method the endpoint was not registered for. |
| `429` | More than 60 deliveries in the current minute. |
| `503` | Registered, but its hook is not enabled in Connections yet. |

A trailing sub-path (`.../e/<id>/payments`) and any query string are passed through on the event, so
one endpoint can serve several event routes without registering more.

## Agent API

The ambient binding exposes `WebhookSession`. The agent-facing contract and examples live in
[`src/types.d.ts`](src/types.d.ts).

```ts
const callback = await ctx.restore({ type: "webhook" });

const endpoint = await WEBHOOKS.register(callback, {
  title: "Stripe payment events",
  description: "Receives Stripe payment_intent events and files them in the ledger gadget.",
});
// endpoint.url and endpoint.token go to the user. The token is never retrievable again.
```

- `register(callback, options)` mints an endpoint and binds a disabled hook.
- `list()` returns this workspace's endpoints, including ones not enabled yet.
- `rotateToken(endpointId)` mints a replacement token; the URL is unchanged and the old token stops
  working immediately.
- `revoke(endpointId)` deletes the endpoint. The Workshop hook is not ours to delete — it goes inert
  and the user removes it from Connections.
- `deliveries(endpointId?, limit?)` returns recent delivery outcomes. Bodies are not retained.

`ctx.restore()` needs a gadget to exist first — it returns a stub pointing at a gadget's persistent
code, and the workspace resolves *which* gadget itself (its default, or its only one). There is no
gadget id to pass. Create the gadget and its `onWebhook` before registering.

## Two ways to create an endpoint

**From the workspace's Connections panel** — "Connect resource" → **Webhook endpoint**. Name it,
describe what it receives, pick the methods. This binds one endpoint into the workspace under its own
binding name, and is the path to use when a human is setting up an integration.

An endpoint created this way has **no bearer token yet** and answers `401` to everything until one is
generated in the Webhooks app. The configurator cannot show a token: its render pass is synchronous
and the form closes on submit, so there is nowhere to reveal a secret exactly once. The upside is
that creating a connection never mints a live credential nobody copied.

Then, once, in the workspace's chat:

```js
const callback = await ctx.restore({ type: "webhook" });
await ALERTS.onWebhook(callback);   // ALERTS is the binding name you chose
```

**From agent code** — `WEBHOOKS.register(callback, options)` on the ambient binding mints the
endpoint and its token together and binds the hook in one step. Better when an agent is setting
everything up and can hand the user the token immediately.

Both produce the same kind of endpoint in the same registry; they differ only in who creates it and
when the token appears.

## Several endpoints, several flows

Each endpoint binds into the gadget that handles it, and a gadget only ever sees its own bindings.
That is the isolation boundary: bind `deploy-events` to a gadget holding the GitHub connection and
`pod-alerts` to one holding ClickHouse, and neither flow can reach the other's connections even
though both live in the same workspace.

Spawned agents narrow it further. An agent-spawner's `env` is the complete binding set the spawned
agent sees — never the workspace's default list — so a triage agent spawned from the alerts flow can
be given ClickHouse and nothing else. One spawner per flow is the usual arrangement.

An endpoint belongs to whichever workspace first binds it; binding the same endpoint into a second
workspace is refused rather than silently redirecting a live URL's deliveries.

## Reacting with an agent

The common case for alerts is one agent chat per delivery, which `onWebhook` gets by calling an
agent-spawner binding:

```js
async onWebhook(event) {
  if (await this.seen(event.deliveryId)) return;   // delivery is at-least-once
  await this.markSeen(event.deliveryId);
  const p = event.json ?? {};
  await env.AGENT_SPAWNER.spawn(`Service down: ${p.service ?? "unknown"}`, buildPrompt(p));
}
```

Each spawn opens a fresh chat that sees only the spawner's configured bindings — never the
workspace's default binding list — so an alert is triaged in a clean context rather than accumulating
into one long thread.

**The spawner binding is created by a human, not by agent code.** There is no agent-facing API for
it: `newAgentSpawnerGatekeeper()` lives on the Workshop's client interface, and the only caller is
the Connections panel ("Connect resource" → "Agent"), where you pick the model and the bindings
spawned agents may use. Agents asked to wire this up will otherwise spend a long time hunting for a
function that isn't in their environment.

Treat the payload as untrusted when composing the prompt: fence it, label it as data rather than
instructions, and keep the spawner's binding set to the minimum the triage actually needs. Anything
that can POST to the endpoint is writing part of that prompt.

## Sharing a workspace that uses Webhooks

Webhooks is an ambient binding, so it appears in the Share modal's recipient-verification list as
`Webhooks / webhook://endpoints`. That means each collaborator must hold a Webhooks account of their
own before they can open the workspace (see `docs/observers.md`).

Ambient bindings are the exception to account *selection*, not verification: a collaborator who
already has a Webhooks account has it filled in automatically and never sees a prompt. One who does
not gets the configuration modal on open and must connect it — a single click, since the vendor
auto-provisions and needs no OAuth. Declining denies the open. This gatekeeper's `addObserver` is a
permissive no-op (the low-stakes observer policy: an endpoint is a URL this workspace minted for
itself, so its collaborators are the intended audience), so verification always succeeds once an
account exists.

Note what this does *not* change: endpoints stay in the **owner's** account registry. Collaborators
reach them through the shared workspace's agent session, but their own `/gatekeepers/webhook` app
lists only their own account's endpoints, which will be empty. On a workspace meant to be shared,
create it under whichever account should own the URLs — a service account, if the team shares one.

Deployments that share workspaces routinely can set the `webhook` vendor's provisioning mode to
**enabled** in the admin panel, which gives every user an account up front and removes the prompt.

## Tokens

A token is 256 bits of randomness, returned exactly once by the call that mints it. Only its
HMAC-SHA-256 digest is stored, using a fixed domain-separation constant — the same discipline the
Workshop applies to gadget share keys. A storage leak therefore yields no usable tokens, and neither
the agent nor the management app can read an existing token back. Rotation is the only recovery.

Rotation and deletion are available in the management app as well as to the agent: a leaked webhook
token has to be cuttable off immediately, and that should not depend on an agent being available.

## Delivery

Accepted requests are stored and delivered by the account's alarm.

- Delivery is at-least-once. Each event carries a `deliveryId` stable across retries; callbacks
  should use it as an idempotency key.
- Every delivery first passes through `authorizeObservation()`, so the payload enters the workspace
  as an observation. The observation names the source, timestamp, and size only — never the body,
  which is untrusted third-party input that may carry secrets.
- Failures retry up to eight attempts with backoff from 30 seconds to one hour. An endpoint whose
  last delivery exhausted its attempts reports **Needs attention**.
- Disabling a hook drops that endpoint's queued deliveries. It does *not* invalidate the URL or the
  token: unlike a schedule, the URL already lives in a third party's configuration, so a pause has to
  be resumable.

### What reaches the callback

`WebhookEvent` carries the method, sub-path, query, headers, and body. Bodies over 128 KiB are
truncated (and never parsed as JSON, since a truncated body is not valid JSON). `authorization`,
`cookie`, and `proxy-authorization` are stripped; service signature headers such as
`x-hub-signature-256` are deliberately kept, because a gadget that wants to verify a payload needs
them and they carry no access.

## Architecture and security

- **`EndpointRegistry`** — one Durable Object per account. Owns endpoint records, stored hook
  capabilities, the delivery queue, the delivery log, and the rate-limit window.
- **`EndpointIndex`** — one Durable Object per endpoint ID, named by that ID, mapping it to its
  account. This is the only reason an endpoint URL can carry no account identity: two endpoints
  handed to two different services are uncorrelated even when one account owns both.
- **`WebhookGatekeeper`** — the per-workspace facet. Its inherited `ctx.id` *is* the workspace scope;
  callers cannot supply a workspace or account ID.
- **`receiver.ts`** — the public `fetch` handler. It holds no policy: it resolves the ID, hands the
  request to the registry, and renders the registry's decision.

Webhooks is capability-authorized. It does not receive Workshop user identity, assert its own
ambient policy, expose outbound network authority, or implement actions. The Workshop's hook
admission and observation authorization remain the security boundaries.

## Limits

- 50 endpoints per workspace, 200 per account.
- 128 KiB of request body; 64 headers at 1 KiB each; 64 query parameters; 256-character sub-path.
- 60 deliveries per endpoint per minute.
- 8 attempts per delivery; 20 deliveries per alarm pass with four concurrent deliveries.
- 50 retained delivery records per endpoint; 100 endpoints per management page.
- Titles 200 characters, descriptions 2,000.

These are fixed policy limits rather than deployment settings.

## Development

Install and build from the repository root:

```sh
pnpm install
pnpm --filter @gadgets/gatekeeper-webhook test
pnpm --filter @gadgets/gatekeeper-webhook build
pnpm run dev-server
pnpm run dev-client
```

The development server discovers `gatekeeper-*` packages, builds `app/` into the generated
single-file asset, and creates the local `GATEKEEPER_WEBHOOK` service binding. Do not edit generated
local Wrangler configuration.

`BASE_URL` is the origin endpoint URLs are minted under. The committed dev value is
`http://localhost:8787/gatekeeper/webhook`; deployments get `$PUBLIC_BASE_URL/gatekeeper/webhook`
from the release manifest.

`src/types.txt` is a byte-identical copy of `src/types.d.ts`, shipped to the agent as text. Update
both together.

Worker code gets its runtime and `Cloudflare.Env` types from generated
[`worker-configuration.d.ts`](worker-configuration.d.ts). Regenerate with
`pnpm types:generate` from the repository root after changing Worker configuration.

## Deployment

1. Deploy this Worker so its `EndpointRegistry`, `EndpointIndex`, and `WebhookGatekeeper` SQLite
   migration exists.
2. Install it like any gatekeeper, which binds `GATEKEEPER_WEBHOOK` on both the Workshop (for the
   vendor RPC) and the router (which is what exposes `/gatekeeper/webhook/*` publicly). Both come
   from the release manifest; a Workshop-only binding would give working registration and dead URLs.
3. Webhooks declares only that it can auto-provision an account. Workshop provisioning policy
   defaults the `webhook` vendor to **optional**; an administrator can choose disabled, optional, or
   enabled.

The `allow_irrevocable_stub_storage` compatibility flag is required while stored callback
capabilities exist and must not be removed from an existing deployment.

## Troubleshooting

- **The URL returns 503:** registration starts disabled. Enable its hook in the workspace's
  Connections UI.
- **The URL returns 404:** the endpoint was deleted, or the account was disconnected. Register a new
  one.
- **The URL returns 401:** the service is sending the wrong token. Rotate the token in **Webhooks**
  and paste the new one into the service.
- **The service reports timeouts:** it is not reaching this instance at all — the receiver answers
  immediately. Check that `GATEKEEPER_WEBHOOK` is bound on the *router*.
- **An endpoint says Needs attention:** its callback threw or was denied on every attempt. Fix the
  callback, then disable and re-enable the hook.
- **Deliveries arrive twice:** delivery is at-least-once by design. Deduplicate on `deliveryId`.

## Non-goals

V1 does not provide outbound webhooks, per-service signature verification (a gadget can do it from
the forwarded headers), payload replay, response bodies chosen by the workspace, IP allowlists,
per-endpoint rate-limit tuning, or blueprint cloning of endpoints. Hook lifecycle remains in the
Workshop Connections UI.
