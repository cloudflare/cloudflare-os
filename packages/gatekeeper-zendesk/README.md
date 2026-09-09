# Zendesk connector: chat ticket actions

The account session (`ZENDESK`) supports ticket creation. A single-ticket binding
(`ZENDESK_TICKET`) still only reads and updates its ticket; it cannot create others.
Agent sessions never expose the management UI's direct-write methods.

## Create, then edit

Native API:

```ts
const ticket = await ZENDESK.createTicket({
  subject: "Investigate login failures",
  comment: { body: "Customer reports intermittent failures.", visibility: "internal" },
  requesterId: 12345, // optional existing user ID; omitted means Zendesk's default
  fields: { priority: "high", tags: ["login"], custom_456: "enterprise" },
});
```

Retain this ticket capability. Until creation completes, its operations throw a
pending-creation error promptly. Retry the same capability after the decision;
do not call `createTicket` again. Once created, it supports the existing `read`,
`addComment`, `updateFields`, `readAttachment`, and `mediaCapabilities` methods.
Dispose the capability when finished.

Edit the title through the same approved field-update path:

```ts
await ticket.updateFields({ fields: { subject: "Login failures — investigation underway" } });
```

`subject` must be a nonblank string of 1–300 characters without NUL bytes. The
approval preview shows the entire new value, and `read()` overlays the pending
title until it is applied or rejected. Creation accepts the subject **only** at
the top level; supplying `fields.subject` is rejected rather than overwritten.

Coding sessions discover `zendesk_create_ticket` through `listTools()`, with the
same input shape. `callTool()` returns `{status: "pending", actionId, message}`.
Poll `getActionResult(actionId)` (or `getCodingSessionActionResult`) for `pending`,
`rejected`, `failed`, or `ok`. On success, `structuredContent` contains
`{source: "zendesk", id, key, url}` with the real provider ID, not a placeholder.
Use that ID with `zendesk_read_ticket`, `zendesk_update_fields`, or
`zendesk_add_comment`.

## Approval and duplicate safety

- Creation is staged without provider requests. Only `applyAction` sends the POST.
- It is explicitly non-auto-approvable and sets `awaitDecision`; the approval
  description includes the destination, comment visibility, notification warning,
  and complete outbound ticket JSON, including custom fields and comment body.
- A durable claim is stored before the first await. Duplicate successful applies
  are no-ops; in-flight and failed claims cannot be replayed. Late rejection cannot
  erase a claimed creation. Results survive a lost submission acknowledgement.
- After restart, a persisted `applying` action has no active local execution.
  Polling or attempting to apply it records an explicit `failed` result stating
  that its outcome is unknown and requires verification in Zendesk. Live local
  executions still poll as pending. Recovery never reissues the write; it cannot
  determine remotely whether an interrupted POST succeeded. This also covers
  legacy claims without timestamps, and does not rely on a timeout or alarm.
- Each creation stores a unique Zendesk idempotency key. Its two-hour lifetime is
  **not** permission to retry indefinitely: ambiguous failures remain failed and
  require inspecting Zendesk before submitting a new creation. A new action has
  a new key and can duplicate an earlier ticket if the caller ignores this advice.
- No post-create history fetch can turn a successful POST into a failed action.

## Limits

Subject: 1–300 characters. Initial comment: 1–12,000 characters, internal by
default; public must be explicit. Optional fields use the existing ten-field
creation allowlist (status, priority, type, assignee/group IDs, tags, `custom_<id>`), with
bounded values and positive safe-integer IDs. Discovery lists supported values.
Invalid or oversized input is rejected rather than silently truncated.

This extension does not add new requester creation, CCs/followers, attachments at
creation, author impersonation, ticket forms/brands, deletion,
or bulk/asynchronous creation. Tenant-required fields and Zendesk permissions
still apply. Pending tickets are not simulated in search. Existing comment and
field-update behavior, privacy rules, OAuth grants, and management UI remain
unchanged. The separate kernel change is required for manually approved agent
actions after private reads; this package does not relax that policy.

## Official API references

Verified against current Zendesk documentation via Context7 and the official web
docs:

- [Create/update tickets and custom fields](https://developer.zendesk.com/documentation/ticketing/managing-tickets/creating-and-updating-tickets/)
- [Ticket comments: nested comment bodies](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/)
- [Ticketing idempotency](https://developer.zendesk.com/api-reference/ticketing/introduction/#idempotency)

Creation uses synchronous `POST /api/v2/tickets.json` with `{ticket: {...}}` and
`Idempotency-Key`. Existing updates keep `safe_update` and `updated_stamp`.

## Verification

```sh
pnpm --filter @gadgets/gatekeeper-zendesk test:run
pnpm exec vp run --no-cache -F @gadgets/gatekeeper-zendesk build
```

Tests mock Zendesk HTTP, including the workerd integration tests. They do not
create tickets in a live tenant or verify the full Workshop chat/kernel flow.
