# `sync` — collaboration plumbing

Every collaborative gadget here has the same skeleton: one Durable Object owns the authoritative
state and many browsers edit it live -- a mutation queue in the object, a set of subscriber stubs
it broadcasts to, presence seeded on join and dropped on leave, per-item optimistic concurrency,
and in the browser a debounced save loop with retry, a throttled presence heartbeat and an
`RpcTarget` for the callbacks. This library is that skeleton once, with none of the flesh: it knows
nothing about blocks, cells or slides, and a gadget keeps its own model, protocol, DOM and export
formats on top of it.

## Server (`@gadgets/bundled-blueprints/libraries/sync/server`)

- **`MutationQueue`** -- `run(work)` chains mutations so that each loads the state the previous
  one stored, whatever order their RPCs interleave in; a rejection reaches its caller alone.
- **`SubscriberRegistry<Callbacks, Info>`** -- `add(subscriber, info)` `dup()`s the stub the RPC
  layer delivered, registers `onRpcBroken` cleanup and returns the kept handle; `broadcast(send)`
  delivers to everyone at once and never waits: a failing subscriber is dropped and disposed
  (never failing the mutation), a hung one holds up nothing but itself, and a callback may call back
  into the object -- read the document, queue a mutation -- without deadlocking on the mutation that
  is telling it about the last one; deliveries are issued synchronously in call order, so each
  subscriber hears events in order. `remove(handle)`, `has(handle)`, `members()`, `size`. Given
  `PresenceHooks` -- `join(subscriber, who)` and `leave(subscriber, who)` in the gadget's own
  callback vocabulary -- it seeds a newcomer with everyone already here (all at once; one that
  fails a seed is dropped, and its leave announced, since it was a member from the moment it was
  added), announces the newcomer to all, and announces whoever drops out. A gadget with no presence passes none and gets a fan-out.
- **`applyVersioned(items, batch, options?)`** -- the per-item concurrency rule over any
  `{ id, version }`: an upsert whose `baseVersion` is stale is rejected with the authoritative
  item, one for a deleted item is rejected as `missing` (the client may re-create it with
  `baseVersion` 0), an identical upsert is no change, deletions are version-checked, and accepted
  items take the next version. Returns the new item map, `accepted`, `deletedIds`, `conflicts`,
  `changed` and a `status`; `operationStatus(changed, conflicts)` recomputes the status for a
  gadget whose batch also carries ordering or a title. `normalizeBaseVersion` reads a base version
  off the wire.
- **`normalizeCollaborator`** bounds what a client says about itself before it is repeated.

The entry imports nothing from `cloudflare:workers`: the stubs are whatever the gadget's own
`subscribe` receives, seen through the structural `SubscriberStub` (`dup`, `onRpcBroken`, the
disposer).

## Client (`@gadgets/bundled-blueprints/libraries/sync/client`)

- **`SaveScheduler`** -- `schedule(delay?)` debounces (`DEBOUNCE_MS`), `flush()` serializes and
  a flush during a save folds into one more. The gadget supplies `save()`, which sends what is
  dirty and answers `"saved"`, `"conflict"` (rebased, re-sent at once) or `"pending"` (a draft
  waits on something else; the gadget schedules again), and `isDirty()`. A failed save is retried
  after `retryDelay(failures)`: `RETRY_BASE_MS` doubling to `RETRY_MAX_MS`, reset by a success,
  with the failure left on the status line until the retry starts. Statuses (`SaveStatus`) are
  `saving`, `saved`, `conflict`, `offline`, with `synced` left for the gadget to report on a live
  update. `readOnly` makes it a no-op.
- **`PresenceRoster<Cursor>`** -- `apply(event)` takes join, cursor and leave events (ignoring the
  client's own), keeping a position through a re-join; `people()`, `entries()`, `get(clientId)`;
  `expire(now?)` drops anyone silent for `STALE_MS`. `Cursor` is the gadget's position type,
  carried unread.
- **`PresenceReporter<Update>`** -- `schedule()` sends at most once per `THROTTLE_MS`, `sendNow()`
  sends at once, `startHeartbeat(onBeat?)` re-sends every `HEARTBEAT_MS` and then runs the
  gadget's tick (expire the roster, redraw), returning the stop function.
- **`createSubscriber(RpcTarget, callbacks)`** -- an instance of the host's `RpcTarget` whose
  prototype carries each callback, since the RPC layer exposes prototype methods and never own
  properties. The class comes from the gadget's bootstrap, which a library cannot import, so the
  gadget passes it in the way it passes its `gadget` stub.
- **`collaboratorFor(clientId)`** -- the guest identity a tab declares for itself.

Nothing on the client side touches the DOM; every module runs in Node under its tests.

## Using it

A gadget keeps its RPC surface and its stored shape; the library implements the loop. On the
server, every mutation runs through `queue.run`, one registry with hooks that build the gadget's own
`presence` events holds the subscribers and broadcasts to them, and `applyVersioned` applies the
upsert/delete rule with the gadget's sanitizer in front and its ordering after. In the browser, a
`SaveScheduler` whose `save()` is the gadget's payload builder drives saving, a roster holds the
collaborators, a reporter sends presence and the heartbeat, and `createSubscriber` builds the
callbacks class. Each part stands alone; a gadget may use any subset.

## Tests

`__tests__/` runs in Node (`// @vitest-environment node`): one suite per module, plus
`server.test.ts`, which assembles the server entry into the smallest gadget and drives it with
stubs shaped like the RPC layer's.
