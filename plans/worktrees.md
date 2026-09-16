# Plan: Worktrees — git-backed file workpieces pulled through gatekeepers

## Goal

Let agents naturally operate on files pulled from remote git repositories, through
gatekeepers. A **worktree** is a new kind of workpiece/binding — like a gadget
workpiece containing only code, with no ability to execute it as a gadget. An agent
creates a worktree from a git commit id (obtained from a gatekeeper API, e.g. GitHub),
reads and edits the files with its regular file tools, creates commits, and passes the
resulting commit ids back into the gatekeeper (e.g. to push a branch or open a PR).

Supporting cast:

- A **git cache** layer over the workspace's existing git object store, with
  **provenance tracking** (which gatekeeper each object can be pulled from), lazy
  **pull-on-fault** plumbing (`Gatekeeper.gitPull()`), and **push authorization**
  (`ActionDescription.pushedCommits`, verified and marked at `submitAction`).
- **GitHub gatekeeper git operations**: enumerate branches/tags, look up commits
  (including truncated ids), enumerate commit histories and PR commits, push commits
  to a branch, create PRs from pushed commits — every returned commit id advertised
  via `GitCache.advertiseCommit()`, every push declaring
  `ActionDescription.pushedCommits`.

The starting point is the sketch in commit 34ebecd, encompassing changes in
`workshop-shared/src/gatekeeper.ts` (`GitOid`/`GitObjectType`/`GitCache`/
`GitPullHints`, `Gatekeeper.gitPull?()`, `ObservationAuthorizer.getGitCache()`)
and `workshop-shared/src/worktree.d.ts` (the
agent-facing `Worktree` binding API).

## Locked decisions

- **Chat-scoped.** A worktree belongs to the chat that created it and is deleted with
  the chat. Fresh agents create their own worktrees. Nothing structural forbids
  workspace-scoped worktrees later (worktrees get ordinary `WorkpieceId`s from the
  shared counter), but no cross-chat visibility ships now.
- **No UI — worktree *content* is stripped from client deliveries.** Worktrees do
  not appear in the workshop UI at all; a future change can add a `WorkpieceSummary`
  variant when the UI is ready for large repos. This takes more than filtering
  `subscribeToWorkpieces`: the frontend's OT client consumes the same chat change
  stream the agent writes, and when a row touches a pinned workpiece it fetches the
  entire base commit (`otClient.ts` → `getCodeAtCommit`) — for a worktree that would
  be a whole repo, materialized on both ends of the wire. So the server strips
  worktree entries from **every client delivery**: `changeApplied` events and
  subscribe-replay rows (worktree entries removed; revision numbers preserved, so a
  stripped row may carry an empty change but the revision stream stays gapless),
  delivered `"changes"`/`"merge"` messages' change payloads and pins, and `codeBase`
  metadata pins. This is sound because `CodeChange` transform is per-workpiece: ids
  are disjoint, so a client's gadget edits transform identically against a stripped
  row and the original. Two deliberate non-goals sharpen what "no UI" means:
  - **Worktree *ids* are not hidden from clients.** The delivered `createWorktree`
    tool call carries `worktreeId`, and the transcript renders the creation (§4) —
    both intentional, and a follow-up intends to expose worktrees to clients
    outright. Stripping only guarantees that nothing in delivered traffic makes
    the *existing* client fetch worktree content: no worktree `CodeChange`
    entries, no worktree pins (a pin is what triggers `otClient.ts`'s
    `getCodeAtCommit` base fetch), no commit content.
  - **Client-submitted worktree changes are not rejected.** `submitCodeChange`
    accepts arbitrary workpiece ids from the client, and this plan deliberately
    leaves that alone: a hand-rolled client that targets its own chat's worktree
    gets its change applied like any other (and the agent sees it), while
    stripping means such a client operates blind — its own rows echo back empty.
    That is acceptable: client worktree editing is intended follow-up work anyway,
    a worktree change conveys no authority the chat's client doesn't already have
    (same chat, same edit rights the agent's file tools exercise), and
    per-workpiece transform keeps such rows from perturbing anyone's gadget
    edits. "No UI" is a statement about what the shipped frontend does, not a
    server-enforced invariant. "Like any other" does still mean the same content
    rules the agent's file tools enforce: ingestion applies the tree-entry-mode
    write checks to the submitted change (a `set` or `remove` whose path still
    has a live symlink, gitlink, or directory base entry is rejected with the
    descriptive read errors; an `edit`'s base seeding throws them on its own), at
    submit time only — recorded rows are never re-checked, so folds stay
    deterministic.
  (Frontend-side "ignore unknown ids" was rejected: the client's workpiece list
  arrives on a different subscription than the change stream, so classification
  would race.)
- **Edits ride the existing chat OT stream.** `CodeChange` is already keyed by
  `WorkpieceId` and pins are `{gadgetId, baseCommit}`; a worktree is *born pinned* at
  its base commit, so readFile/writeFile/editFile, the read-before-edit gate,
  `chatChanges` rows, replay, and compaction all work unchanged. Agent-authored rows
  are born at the step persistence barrier per plans/step-transactionality.md — a
  prerequisite of this plan — so worktree edits and `commit()` head advancements
  inherit its transactional crash semantics. (The alternative — a worktree-local
  overlay — was rejected: agent replay needs content-at-each-point history, which is
  most of the OT stream rebuilt.)
- **One workpiece table.** Worktrees are stored in the existing `gadgets` collection,
  which generalizes: `GadgetRecord` becomes a `WorkpieceRecord` with a `type`
  discriminator. This avoids a second lookup to resolve what a `WorkpieceId` refers
  to and lets code handling gadget code vs. worktrees be shared. (Folding
  `GatekeeperRecord` into the same table may make sense eventually but is out of
  scope here.)
- **Worktrees have no `bindingName`.** The only purpose of `bindingName` on the
  record is to seed new chats' binding sets; worktrees are chat-private and never
  participate. Like the obsolete `GatekeeperRecord.bindingName`, the name a worktree
  was created under lives only in its chat's binding list. `bindingName` therefore
  becomes optional on the unified record (unset for chat-private workpieces), and
  worktree rows opt out of the `byBindingName` unique index by returning null (the
  pattern the gatekeepers table already uses) — so two chats can each have a worktree
  named `repo` without conflict.
- **The chat's pin moves only at epoch boundaries; explicit `commit()` moves only
  `headCommit`.** This is what keeps the OT stream coherent: the pin (and record
  `pinBase`) is the base the epoch's OT rows compose on, and those rows remain the
  single durable record of the overlay — if `commit()` also advanced the pin to a
  commit already containing the overlay, replaying the still-active rows on top
  would apply every edit twice. So `commit()` changes nothing about how chat
  content is computed; it just snapshots it.
- **Epoch resets auto-commit dirty worktrees, and auto-commits are squashed away.**
  `mergeChanges`' epoch reset evaporates all pins, so accept writes a local
  **auto-commit** per dirty worktree and re-pins at it in the new generation — content
  is never lost. But the worktree API never reveals auto-commits: reported HEAD is the
  last *explicit* commit, and a new explicit `commit()` parents on the last explicit
  commit (auto-commits become dangling objects; there is no GC, and dangling loose
  objects are cheap).
- **Transport: custom smart-HTTP fetch client, not isomorphic-git's high-level fetch.**
  Protocol v2, pkt-line composed by hand, `want`s by SHA, **no `have`s ever** —
  an empty have list and an immediate `done` on every fetch (no negotiation; the
  same noop stance git itself takes for partial-clone lazy fetches).
  The gatekeeper handles only protocol framing (pkt-line, sideband demux) and streams
  the raw pack body into `GitCache.consumePack()` — the pull-side symmetric of
  `buildPack()` — which unpacks it overseer-side (reusing isomorphic-git's packfile
  parsing / delta resolution where its internals allow), so no gatekeeper ever
  re-implements pack decoding. Packfiles are unpacked wholesale into the `GitCache`
  and never stored or indexed
  long-term: eviction + re-fetch replaces pack-based history storage. The
  no-`have`s rule is correctness, not laziness: a `have` asserts full
  reachability, but every pull here is filtered or tree-limited, so possessing a
  commit never implies possessing its blobs and trees — advertising one as a
  `have` would make upload-pack exclude exactly the omitted objects a later
  exact-object fault explicitly `want`s. Since all pulls are shallow and
  filtered, the cost is only a modest over-fetch (a repeat creation from the
  same repo re-downloads its shallow filtered pack); completeness-graded
  `have`s are listed future work. Git sync is generally simplified by the
  assumption that intermediate changes were not synced through some path the
  gatekeeper didn't see.
- **Push is native send-pack, not REST git-data — required, not preferred.** REST
  git-data re-creates objects server-side from JSON; any serialization difference
  yields a different SHA than the commit id the agent holds, silently breaking the
  "push the commit I made" contract. Sending our exact bytes in a pack guarantees oid
  fidelity. The pack bytes themselves are composed overseer-side
  (`GitCache.buildPack()`, §1); the gatekeeper contributes only send-pack framing
  and the ref-update command.
- **Push authorization is declared on the action and enforced at `submitAction` —
  there are no read-time rules and no gatekeeper-induced pulls.**
  `ActionDescription.pushedCommits` names the commits an action will push; before
  queuing, the overseer verifies that their ancestry reaches commits *proven* on
  that gatekeeper's remote and marks the push closure "pending push" (§1). The
  gatekeeper's whole cache view is then trivial: `get()`/`has()`/`stat()` answer
  for objects proven on its remote plus objects pending push to it, and nothing
  else. Proof means hash-verified bytes — a `put()` from that gatekeeper or a
  successful push to it; an advertisement is just an assertion and never
  qualifies (§1's metadata grades). One content-free predicate deliberately
  sits outside the scoped view: `GitCache.isAncestor()` (§1), which lets the
  gatekeeper run its fast-forward policy check *before* queuing — the commits
  aren't in view until `submitAction()` marks them — at the cost of one bit of
  ancestry between oids the caller already holds (nothing, under the
  trust-model watch-for). The design serves two purposes, and neither
  is defense against a hostile gatekeeper (see the trust-model watch-for): the
  ancestry rule is a **safeguard against agent and user mistakes** — an
  accidental push to an unrelated remote fails closed at queue time with an
  agent-visible error (relatedness is proven by first pulling a shared ancestor
  from the destination, which is also what keeps pushes from ever needing to
  un-shallow the cache) — and the pending-push view is exactly what the
  gatekeeper needs to **simulate a not-yet-approved push**. Beyond those two,
  the tight view is least-authority hygiene rather than a security boundary.
  Versus the read-time-rules and `GitCache.ensure()` designs this replaced:
  repo *copying* stays structurally out of scope (cross-remote transfer moves
  only a verified push closure, batched at apply), and everything happens at
  the same chokepoint every other gatekeeper effect already flows through.
- **Trees eager; blobs eager under a modest size limit.** Any pull of a worktree base
  fetches the commit, its full tree structure, and all blobs under `EAGER_BLOB_LIMIT`
  in one round trip (`filter blob:limit=…`). This shape is a property of the *pull*,
  not of creation as an event: creating a worktree on a gatekeeper-known commit issues
  it up front, while creating one on an already-local commit pulls nothing — and if
  that commit's trees were never fetched, the first base read faults with the same
  eager shape (one round trip, never a serial per-segment walk-and-fetch).
  Larger blobs fault in on first access (GitHub is slow;
  over-laziness costs agent latency, so only genuinely large files pay it). Files over
  `MAX_WORKTREE_FILE_SIZE` (~1MB, aligned with the existing `MAX_FILE_TEXT_LENGTH` /
  2MB-record constraints) are unsupported for now: reads error cleanly, grep skips
  them. Batch operations (grep over a directory) fill **all** missing blobs in a
  single fetch — never a serial walk-and-fetch.
- **Text only, like the rest of git-store.** Binary files are not editable; treat
  binary blobs like oversized ones (clean error on read, skipped by grep). Blob bytes
  still land in the cache unmodified, so push round-trips binaries that came from a
  pull untouched.
- **All five tree-entry modes are parsed; only regular files are operable;
  existing modes are preserved.** A real repo's trees contain `100644`,
  `100755` (executable), `040000`, `120000` (symlink), and `160000` (gitlink),
  so every tree-reading path (lazy walker, `listFiles`, marking walk) handles
  all five — unlike today's gadget-only paths, which reject what they never
  write (`readCommitFiles`) and write `100644` unconditionally
  (`#writeTreeNode`; that gadget path stays as-is). Operable content is
  regular files of *either* mode: editing an executable preserves its
  `100755` — `writeChangedFilesAsCommit` carries the base entry's mode into
  the rebuilt tree, and only genuinely *new* files default to `100644`. No
  API creates an executable or changes a mode for now (future work). Symlinks
  and gitlinks are **inert, and touching one throws**: `listFiles` surfaces
  them with their kind, but readFile/writeFile/editFile/deleteFile on such a
  path throws a descriptive error — for a symlink, `"<path> is a symlink to
  <target>"` (the target *is* the blob's content, so the message tells the
  agent everything it needs); for a gitlink, `"<path> is a submodule
  (gitlink) pointing at commit <oid>"` — and grep skips them with a note,
  like binaries. Untouched entries of every kind ride through commits
  unchanged (tree rebuilds copy mode + oid verbatim), and symlink blobs
  travel in push closures like any blob; gitlink target *commits* are still
  never pulled, walked, or pushed (§1).
- **Paths are strict UTF-8; a non-UTF-8 tree entry name throws.** Git permits
  arbitrary non-NUL bytes in entry names, but every layer above the object
  store here speaks string paths, and a *lossy* decode (replacement
  characters) could alias two distinct byte names to one string path —
  making an edit silently target or overwrite the wrong entry. So the tree
  parser decodes entry names with a fatal `TextDecoder`: parsing a tree that
  contains an invalid name fails with an error naming the tree oid and the
  offending bytes (hex-escaped). Strict decode is reversible — re-encoding
  yields the exact original bytes — so names that pass can never alias, and
  the write side (already UTF-8) round-trips them byte-identically,
  preserving oids. Non-UTF-8 names are vanishingly rare in practice; if one
  is ever actually hit, decide the accommodation then rather than designing
  an escaping scheme now. (Gadget trees are unaffected — always our own
  UTF-8 writes.)
- **Lazy reads are a hand-rolled walker, not isomorphic-git.** The new
  read-on-demand paths (per-path tree walk, entry listing, commit header reads) parse
  git objects themselves and call `ensureObject(oid, {type, referencedBy})` before
  each step, so pull hints fall out of the walk naturally.
  isomorphic-git's fs shim only ever sees a bare oid path — it knows neither the
  expected type nor the `referencedBy` chain that `GitPullHints` wants — and the
  parsing is genuinely trivial (blob = raw bytes; tree = repeated
  `<mode> <name>\0<20-byte oid>`; commit = text headers) on top of the raw
  loose-object codec `GitCacheImpl` needs anyway. isomorphic-git remains the engine
  for the existing full-materialization paths and for **all writes** (which never
  fault), keeping the write side single-sourced; tests cross-verify the two codecs
  over the same store.
- **No eviction yet.** The `GitCache` contract *permits* eviction (that's why
  provenance exists — evicted objects are re-pullable), but v1 implements none.
  The metadata rows (`onRemote`/`pullableFrom`, §1) are the future re-pull index;
  gadget-history objects remain rooted by records/pins as documented in
  git-store.ts.

## Current-state anchors (for orientation)

- Object store: `git-store.ts` — SHA-1 zlib loose objects in the `gitObjects`
  collection keyed by 40-hex oid, isomorphic-git plumbing only, nested trees
  supported, text-only content, no refs, no GC (roots enumerated in its header).
- Chat code model (post git-storage.md Part 3): OT `chatChanges` rows
  (`CodeChange` keyed by `WorkpieceId`), lazy pins `{gadgetId, baseCommit}` +
  `mergedCommit`, epochs bounded by `mergeChanges`' reset, `buildChatContent` folding
  the log, agent session content as `Map<WorkpieceId, Map<path, string>>`.
- Step barrier (post step-transactionality.md, this plan's prerequisite): agent
  tool effects buffer in memory per model step and persist transactionally with
  the step's tool-call message at the `turn_end` barrier — agent rows are born
  and retired in one storage transaction, live `chatChanges` rows are
  user-authored only, and a mid-step crash leaves no durable trace of the step.
- Workpiece dispatch seams (the four places that know gadget-vs-gatekeeper):
  `resolveWorkpieceRoot`, `getEnvForAgent`/`makeBindingLoopback`, `describeBinding`,
  and the pinned/unpinned split in the agent file tools.
- Observations: `OverseerImpl.authorizeObservation(gatekeeperId, description, caller)`
  is the single chokepoint where every gatekeeper observation is recorded (via
  `ApprovalQueueImpl`); `recordAgentObservation` covers built-in tools.
- GitHub gatekeeper: REST-only today; `GitHubRepo` session has the
  "TODO: Add methods to access code" comment; observer verification is strategy B
  (repo-level ACL via `GitHubVerifier.hasRepoAccess`), which covers git data too —
  git objects inherit the repo ACL.
- Precedent for the protocol work: `gatekeeper-context/src/artifact-sync.ts` proves
  isomorphic-git 1.40 smart-HTTP fetch works in workerd (`consumePack` reuses its
  pack-parsing internals, not its high-level fetch).

## Design

### 1. Git cache + provenance + push authorization (workshop-backend)

- **`GitCacheImpl`** implements the shared `GitCache` interface over the existing
  `gitObjects` collection. The cache API speaks `(type, headerless payload)`;
  storage stays zlib'd whole loose objects. The stub is minted **per-gatekeeper**
  — it identifies the writer for metadata recording and scopes the read view:
  - `put()` computes the SHA-1 of `<type> <size>\0` + payload itself and stores
    under that oid — poison-proof by construction; a gatekeeper that gets back an
    unexpected oid should probably throw. A verified `put()` doubles as the
    system's **proof of possession**: it is what earns the putter an `onRemote`
    mark (below). No `putMany` batch method: the cache stub a gatekeeper holds is
    a facet-to-parent stub (always local), and callers are free to issue many
    `put()`s in parallel rather than awaiting each serially — doc-comment this on
    `put()`.
  - `advertiseCommit(commitId)` writes the caller's `pullableFrom` mark (below):
    the assertion-grade "my remote has this commit; pull it from me on demand".
    Commits only — trees and blobs enter pull routing implicitly as `put()`
    referents — and no observation is involved: an advertisement is
    workspace-internal pull-routing metadata, not a read, and a gatekeeper can
    already `put()` content with no observation, so the weaker
    declare-without-providing takes the same path. Same no-batch,
    parallel-calls stance as `put()`.
  - `get(oid, hints?)` — and `has()`/`stat()` identically; the view is uniform
    across all three — answers **exactly** `onRemote(G) ∪ pendingPush(G)` for
    the calling gatekeeper G, null for everything else. Null is deliberately
    uniform: "not something this gatekeeper is involved with" and "on your own
    remote — ask it yourself, that's your job" look the same, and the fallback
    behaves correctly either way. A `pendingPush(G)` object that is locally
    absent is **pulled through** from its recorded source on demand — this is
    what lets the gatekeeper simulate a queued cross-remote push as if it had
    already landed; an absent `onRemote(G)` object is *not* pulled (null). The
    optional `hints: GitPullHints` are advisory prefetch for that pull-through,
    so a gatekeeper walking objects by hand doesn't fault once per `get()`
    (defaults: exact-object, type from metadata). Doc-comment the simulation
    contract: a returned commit that is pending push should be treated, for
    simulation purposes, as already pushed.
  - `buildPack()` returns a `ReadableStream` of an undeltified packfile (SHA-1
    trailer) carrying the applying action's full pending-push closure. It takes
    **no arguments**: the commit list is the action's own
    `ActionDescription.pushedCommits`, and the method exists only on the
    **action-scoped** stub passed to `applyAction()` (which carries the action
    id; a session-time stub has no action and throws) — that binding is what
    disambiguates overlapping queued pushes, duplicate heads, and multiple
    actions marking the same oids. Composed overseer-side from the `pushMarks`
    index (below), so apply needs no per-object RPC. `buildPack()` is
    responsible for **completing the closure**: any marked object absent from
    cache is faulted in from its recorded sources (batched), and a faulted
    tree's arrival propagates marks to its children (the ordinary lazy
    propagation), which may fault in turn — repeating until no marked object
    is absent. A mid-stream source-pull failure (provenance loss) fails the
    apply with the actionable "reconnect X" error. The stream rides
    facet-to-parent Workers RPC, which carries `ReadableStream` natively; the
    API deliberately leaves room for a future implementation that streams a
    source gatekeeper's pack straight through without staging every object.
  - `consumePack(pack)` — the pull-side symmetric of `buildPack()`: decodes a
    standard packfile stream (including ofs/ref delta resolution), stores every
    contained object, and returns the inserted oids (which a `gitPull`
    implementation should check its requested oids against). Behaves exactly
    like the equivalent sequence of `put()`s — same hash verification (so still
    poison-proof by construction), same `onRemote`/referent metadata recording,
    same size-cap handling. This is what keeps pack decoding out of individual
    gatekeepers: `gitPull` strips protocol framing and pipes the pack body here.
    The pack decoder is hostile-input parsing (see watch-fors).
  - `isAncestor(ancestor, descendant)` (added with commit 7) — whether `ancestor`
    is reachable from `descendant` (inclusive) over *locally cached* commits:
    the walk never pulls, a parent chain that leaves the cache simply stops
    (false = "not verifiable over cached history" — the right grade for a
    queue-time fast-forward check), and an unknown descendant throws so callers
    can distinguish "verified not an ancestor" from "history not available".
    Deliberately **not** restricted to the gatekeeper's scoped view: the caller
    names both oids, and oids are capabilities (trust-model watch-for), so one
    bit of ancestry between oids it already holds reveals nothing new. This is
    what lets a gatekeeper validate a push's fast-forward requirement *before*
    `submitAction()` — the commits to be pushed enter its scoped view only when
    the action is queued, so without this method the check could only run
    post-queue, and a failure would strand an already-queued action with no way
    to withdraw it.
- **`gitObjectMetadata` collection**: one row per oid — `{oid, type, size?,
  onRemote: WorkpieceId[], pullableFrom: WorkpieceId[], pendingPush:
  {gatekeeperId: WorkpieceId, actionId}[]}` (arrays rather than one row per pair,
  the idiomatic typed-storage shape). Gatekeeper ids are the `GatekeeperRecord`'s
  `WorkpieceId` (the gatekeeper DO is per-resource, so it identifies the repo
  too); multiple gatekeepers may appear on the same oid. Kept separate from
  `gitObjects` for two reasons: reading a `gitObjects` row means reading the
  whole object content, which is wasteful when only metadata is wanted; and
  metadata routinely exists for objects we *don't* hold — advertised commits,
  filtered-out tree entries, and oversized blobs we declined to store.
  `size` is recorded **only from bytes we actually measured**: a normal
  `put()`, or a `put()` rejected for exceeding the size cap (we had the
  content in hand; the measurement is proof-grade, and it lets later
  reads/greps of that blob fail fast instead of re-downloading it). Nothing
  is ever inferred from a blob's *absence* — an omitted blob's size is
  unknowable (tree entries carry no sizes, upload-pack reports nothing about
  what a filter suppressed), and any absence-based record would durably
  trust a gatekeeper's behavior as if it were a measurement: a buggy
  omission must produce a retryable error, never a permanently wrong
  fail-fast row. This costs nothing, because a fetch whose filter suppressed
  a blob is inherently cheap to repeat — the expensive bytes were never
  sent. Blobs too large for the transfer limiter itself never complete a
  `put()`, so they also record nothing and error (agent-visibly) on each
  attempt — accepted for such an extreme case.
  `type` is **required** — every write knows one: *measured* from bytes in
  hand (put/consumePack, including oversize rejections), or *asserted* by the
  context that introduced the oid (a tree entry's mode, a commit's
  tree/parent headers, `advertiseCommit`'s commits-only scope). The grade is
  read off `size` (present iff the bytes were measured — measured writers
  always record both together), and conflicting claims — always a forged
  object or a gatekeeper bug — reconcile as: measured wins unconditionally
  (two measurements can never conflict; the oid covers the type header), an
  assertion never overrides a measured type, and among assertions **"commit"
  wins**, otherwise first claim kept. The commit bias fails toward attempting
  the pull: commit-ness is what unlocks operations (worktree creation, push
  heads), so a false non-commit tag could steer a reader into refusing
  without pulling, while a false commit tag just makes us pull and discover
  the truth. Every conflict is logged at warn (truncated oid — full oids are
  capabilities) and none is fatal: a wrong type only mis-shapes advisory pull
  hints until measured bytes correct it. Corollary, the **reader rule**:
  never hard-reject an operation on an assertion-grade type — decode local
  bytes or pull first (`verifyPushAncestry` prefers decoded local bytes over
  the recorded type for exactly this reason: marks converted after an applied
  push carry walk-stamped types). The two
  gatekeeper sets differ in **evidentiary grade** — proof versus assertion —
  which is what keeps the mistake-safeguard reliable:
  - `onRemote` — *proof* that the gatekeeper's remote possesses the object.
    Entered only by a hash-verified `put()` from that gatekeeper (during
    `gitPull`, or opportunistically — a gatekeeper may `put()` a commit's
    bytes in addition to advertising it, upgrading the advertisement to
    proof) or by a successful push to it. This is what
    `get()` serves, what ancestry verification terminates on, and what the
    marking walk skips.
  - `pullableFrom` — unproven *hints*: `GitCache.advertiseCommit()`
    advertisements, plus the referent oids
    recorded whenever a gatekeeper `put()`s a tree or commit (each entry / tree
    pointer / parent, type derived from the entry mode or header — this is what
    creates rows for objects never fetched, and the sketch's "referenced by
    another object populated by this gatekeeper" and "populated in the past,
    since evicted" pull cases). Every `pullableFrom` write thus flows through
    the per-gatekeeper-minted cache stub (`advertiseCommit` or `put()`
    referents), so attribution is inherent in the capability. Used for pull
    routing (which gatekeeper to try)
    and for the marking walk's remote-known exclusion; grants no reads. A wrong
    or stale claim only misroutes a pull (which fails, and the next recorded
    source is tried) or under-fills the claimant's own packs (its own remote
    then rejects them for missing objects).
  - `pendingPush` — written by the marking walk (below); the read grant for
    queued pushes, keyed to the action so it can be cleaned up.
- **Pull driver** `ensureGitObjects(oids, hints)` in the overseer: look up
  `onRemote ∪ pullableFrom` in `gitObjectMetadata` (trying each recorded
  gatekeeper on failure), reach the gatekeeper through `getGatekeeperFacet(id)` —
  the same instantiated-facet path every other invocation of an existing
  gatekeeper uses (observations, actions, hooks; overseer.ts:4261) — call
  `gitPull(oids, cache, hints)`, verify the requested oids are now present —
  where "present" admits one deliberate exception: a requested *blob* still
  absent after a success return, when the hints carried a blob filter, is
  read as "unavailable at the supported size" and surfaces the ordinary
  too-large read error rather than "pull failed". Nothing is recorded for it
  (see the metadata bullet), so a next read simply retries — a gatekeeper
  bug that wrongly omits a blob self-heals instead of wedging the file.
  A deleted gatekeeper record → clear error to the agent ("reconnect X to pull
  this commit"). Reachable only from overseer-initiated paths — agent-side
  faults (worktree creation and lazy reads) and the `get()`/`buildPack()`
  pull-through of `pendingPush`-marked objects — so a gatekeeper can never direct
  a pull of anything outside a verified queued push.
- **Lazy walker** (`ensureObject` + hand-rolled parsers, per the locked decision):
  the read-side codec — loose-object header/inflate helpers shared with
  `GitCacheImpl`, plus tree/commit parsers — powering the new lazy read paths.
  `ensureObject(oid, {type, referencedBy})` checks presence, pulls via
  `ensureGitObjects` on a miss (routed by the `pullableFrom` rows that
  `put()`-time referent recording already wrote; `referencedBy` shapes the pull
  hints), then parses. Gadget-history reads never fault (their objects are
  always local) and keep using isomorphic-git untouched.
- **Push authorization at `submitAction`** (resolves the sketch's `pull()` TODO
  by *deleting* it, along with the `GitCache.ensure()` design that briefly
  succeeded it): when an `ActionDescription` carries `pushedCommits`, the
  overseer, before queuing:
  1. **Verifies ancestry.** Every parent chain from each declared head must
     reach a commit `onRemote` for this gatekeeper, walking cached commit
     objects only. An absent ancestor commit is an immediate, agent-visible
     error ("pull the branch history first" / "pull a shared ancestor from the
     destination"), and so is a parentless commit that isn't itself `onRemote` —
     **no vacuous pass for roots**. Pushing derived work back to its origin
     trivially passes (the worktree's base was pulled from there); pushing to a
     *related* remote requires first pulling a shared ancestor commit from it,
     which both proves the repos are related and makes the accidental
     push-to-the-wrong-remote mistake fail closed at queue time. Verification
     never needs ancestors *beyond* the proven commits, so shallow pulls stay
     shallow. The practical v1 bound this implies, stated plainly: the commit
     chain from head to proven ancestor must already be cached, which in
     practice means agent-authored commits atop a destination-proven base.
     Pushing a *pre-existing* branch whose head sits N commits above the shared
     ancestor requires those N commit objects — a history-deepening pull v1
     doesn't offer (deep-history pulls are punted) — so the error message
     should state the limitation plainly rather than send the agent hunting.
  2. **Marks the push closure.** Walks from the heads to the proven ancestors
     and through containment (commit → tree → entries), marking every visited
     object `pendingPush {gatekeeperId, actionId}` — skipping, without
     descending, objects the remote already has (`onRemote ∪ pullableFrom`;
     remotes are closed under containment, so nothing beneath a remote-known
     object needs pushing), and skipping gitlink entries (mode 160000) entirely
     (submodule commits are never part of a push, and following one would mark a
     foreign repo's commit). An absent tree/blob that isn't remote-known is
     still marked; when its bytes later arrive (any `put()`), the mark
     **propagates lazily** to its referents under the same rules and action id.
     Marks land on the metadata rows *and* in a non-unique `pushMarks`
     action-id index, so cleanup and conversion iterate the action's oids
     without re-walking.
- **Mark lifecycle.** Applied successfully → the action's marks convert to
  `onRemote` (the remote provably has them now; they also become re-pullable),
  idempotently and in the same durable step as the queue's completion record, so
  a crash between the push and the conversion strands nothing *locally* — the
  remote side of that same window is the gatekeeper's `applyAction` idempotency
  responsibility (§3/§4). Rejected /
  expired / terminally failed → marks removed via the index. Reverting an
  applied push keeps `onRemote`: the remote genuinely received the objects (the
  ref rolls back; they go dangling), and the gatekeeper already held the pack.
  Gatekeeper-record deletion with pushes still queued cleans up like rejection.
- **`Gatekeeper.applyAction()` gains a `GitCache` parameter.** Approval can happen
  hours after the session that queued the action, so a stub obtained via
  `getGitCache()` at queue time is long gone when the action applies; the overseer
  passes a fresh cache stub with the apply call, scoped to the gatekeeper **and to
  the applying action** — the binding `buildPack()` consumes. The read view is
  unchanged by action scoping (`get`/`has`/`stat` still answer the per-gatekeeper
  `onRemote ∪ pendingPush` union); the action binding only adds `buildPack`.
  Existing gatekeepers simply ignore the extra parameter: the workspace pins
  capnweb-validate 0.3.0, whose Schema Evolution contract explicitly allows this
  — "Extra arguments to a validated method are dropped before it runs" (verified
  against the vendored 0.3.0 README; an implementation declaring fewer parameters
  validates and runs unchanged). The stale pre-0.3.0 comment at
  gatekeeper-email/src/email.ts:592 claimed the opposite and has been corrected
  alongside this plan. The parameter is **required, not optional** (decided): an
  optional `cache?` would only protect the opposite rolling-upgrade direction —
  a new gatekeeper receiving `applyAction(id)` from an older overseer — but all
  gatekeepers deploy together with workshop-backend today, a brief disruption
  mid-rolling-update is acceptable in beta, and the required form keeps the code
  simpler. Revisit if gatekeepers ever version independently.
- **git-store extensions**:
  - Raw object read/write helpers used by the cache impl and walker
    (inflate/deflate + header split), private to git-store + cache.
  - Pack writer for `buildPack`: undeltified entries + SHA-1 trailer, streamed
    over the raw loose objects (deltification/thin packs are future internals).
  - `readFileAtCommit(oid, path)` — per-path tree walk via the lazy walker, no
    full-tree materialization.
  - `listTreeEntries(oid, path?)` / walk helpers for `listFiles` and grep
    enumeration (tree objects are always local — trees are eager).
  - `writeChangedFilesAsCommit({treeBase, parents}, changes: Map<path, string |
    null>)` — builds the new tree by reusing unchanged subtree oids from
    `treeBase`, so committing at repo scale never materializes the full file map
    (`null` = delete). `treeBase` and `parents` are separate parameters: an
    explicit worktree commit builds its tree from `pinBase` but parents on
    `headCommit` (squash semantics). Writes go through isomorphic-git plumbing.
    Rebuilt directories copy every untouched entry through with mode and oid
    intact (symlinks and gitlinks included), and a changed file keeps its base
    entry's mode — editing an executable must not clear `100755`; only new
    files default to `100644` (the modes locked decision).
- `ApprovalQueueImpl` (and `SlashCommandAuthorizerImpl`) implement `getGitCache()`;
  the queue's `submitAction` chokepoint runs the `pushedCommits` ancestry
  verification + marking walk, and its rejection/expiry paths run the mark
  cleanup.

### 2. Worktree workpiece (workshop-backend + workshop-shared)

- **Unified workpiece table**: `GadgetRecord` generalizes to a `WorkpieceRecord`
  with a `type` discriminator (`"gadget"` | `"worktree"`); worktree rows add
  `{chatId, sourceGatekeeperId?, baseCommit, headCommit, pinBase}` and omit
  gadget-only fields (`output`, `bindings`).
  - `id` from the shared workpiece counter (`allocateWorkpieceId`) — facet names and
    `CodeChange` keys can never collide with gadgets/gatekeepers.
  - `bindingName` becomes **optional** and is unset for worktrees; worktree rows
    return null from the `byBindingName` index (see locked decision). The creation
    name lives only in the chat's binding list.
  - `chatId` is a permanent field (never cleared) — it is what makes the worktree
    chat-private, independent of the pending lifecycle below.
  - `headCommit` = last **explicit** commit (initially `baseCommit`); what the
    worktree API reports and what explicit commits parent on.
  - `pinBase` = the commit the chat's current pin is rooted at (initially
    `baseCommit`), advanced **only by epoch resets** — never by explicit commits
    (see the locked decision: the epoch's OT rows compose on it, so moving it
    mid-epoch would double-apply them). After an explicit `commit()`, `headCommit`
    runs ahead of `pinBase` until the next reset. Internal bookkeeping only, never
    surfaced.
  - **Lifecycle mirrors pending gadgets**: the record is born with
    `pending: {chatId, sequence}`, stamped by the same machinery, reaped by
    `reconcilePendingGadgets` on crash, and deleted if the creating change is
    reverted. Accept's promotion sweep clears `pending` (the creation is durable)
    but performs **no head-commit work** for worktrees — their head lifecycle is
    their own — and `chatId` keeps them chat-private forever.
  - Deleted when their chat is deleted (extend chat deletion cleanup).
  - **Consumer audit**: every reader of the `gadgets` collection must be checked to
    filter by type — `subscribeToWorkpieces` (else worktrees leak to the UI),
    `defaultBindingList` (worktrees never seed chats), promotion/reconciliation
    sweeps (no head-commit work), blueprint enumeration/creation, ambient
    reconciliation, and the loader paths.
  - **Storage migration — version 3 → 4, stamping existing rows.** `type` is a
    *required* field on the unified record (an optional absent-means-gadget
    default was rejected: it would push `undefined`-handling into every consumer
    the audit touches, forever, to save a one-time rewrite of a small registry),
    so gadget rows written before this change must be stamped `type: "gadget"`.
    Follow the version-3 pattern (`#migrateToActionIndexes` in overseer.ts): a
    synchronous constructor migration gated on `version.get() !== 3`, chained
    after `#migrateToActionIndexes` in both constructor branches (so a v1
    workspace runs 1→2, 2→3, 3→4 in one wake), one `transactionSync` re-putting
    every `gadgets` row with `type: "gadget"` and writing `version.put(4)` last
    inside it — atomic, so a crash mid-rewrite retries whole — and the guard
    keeps never-initialized DOs write-free. `#initializeNewWorkspace` stamps 4,
    and the `version` singleton's doc comment gains the `4 = ...` line. No
    `byBindingName` rebuild is needed: every pre-existing row carries a
    `bindingName`, so the keys the index already holds are exactly what the
    `?? null` function computes for them — only new worktree rows hit the null
    branch. Nothing else in this plan needs migration: `gitObjectMetadata` and
    the `pushMarks` index are new (born empty), worktree rows are new, and the
    new message fields (`createdWorktrees`, `worktreeCommits`, `worktreePins`)
    and the `createWorktree` tool-call variant are optional additions that old
    chat logs simply lack.
- **`createWorktree` agent tool**, mirroring `createGadget`'s shape: validate the
  binding name against the chat's own binding map (the only namespace it occupies);
  resolve the commit id — full oid or unambiguous prefix — against the **local store
  and known metadata** (`gitObjects` ∪ `gitObjectMetadata`; ambiguous → error
  listing candidates; unknown → "look it up via the gatekeeper first"). Filtering
  prefix candidates by the metadata `type` tag is fine under §1's commit-bias
  policy (any commit id an agent obtained from a gatekeeper was advertised,
  forcing its tag to "commit"), but per §1's reader rule an assertion-grade
  non-commit tag on an explicitly named oid must not refuse the creation without
  pulling — attempt the pull and let the decoded bytes decide. There is no
  requirement that the commit came from a gatekeeper: any locally-present commit
  works (a gadget's history, another worktree's commit). Then: create the record (pending, like
  `createGadget` — stamped at the step barrier); add the chat binding; record
  `{worktreeId, changeId}` as the tool output so replay never re-creates. For gatekeeper-known commits, creation performs the **initial
  pull**: `gitPull([commit], cache, {type: "commit", commitHistory: {kind: "depth",
  depth: 1}, filterBlobSize: EAGER_BLOB_LIMIT})` — one fetch for commit + all trees
  + small blobs. The pull covers only what's missing: a commit already present locally
  pulls nothing at creation, and any trees it lacks fault in later with the same eager
  shape on the first base read (see the trees-eager locked decision).
- **Pin at birth**: creation declares the pin `{gadgetId: worktreeId, baseCommit}` on
  the same `"changes"` batch that records the creation (which rides the new
  `createdWorktrees` message field — deliberately separate from `createdGadgets` so
  the frontend can't mistake worktrees for gadget creations; see §4), so
  `buildChatContent` reconstruction works from the log alone.
- **File-tool dispatch** — extend the four seams:
  - `resolveWorkpieceRoot`: accept worktree ids for the chat that owns them (other
    chats' worktrees are invisible, like other chats' pending gadgets).
  - Agent tools: worktrees are always pinned, so reads are session-content reads
    (unstamped — the `observedCommit`/elision matrix never applies), and the
    read-before-edit gate works as-is. `writeFile`/`editFile` emit ordinary OT rows.
  - **System prompt: worktrees are never mentioned.** The prompt aims to be
    byte-stable across a chat's turns for prompt caching (the seed binding layer is
    frozen per chat for exactly this reason, agent.ts:1332-1341; mid-chat
    acquisitions are announced via chat history, not the prompt). Since worktrees
    are created mid-chat by the agent itself, the `createWorktree` call and tool
    result in the chat history *are* the announcement; adding a prompt line would
    self-inflict a cache miss on every turn after a creation. Post-compaction,
    knowledge of the worktree rides the handoff summary like every other mid-chat
    acquisition (the checkpoint's `chatBindings` keep the binding functional, and
    `describeBinding`/`listFiles` let the agent re-orient). File lists obviously
    don't belong in the prompt either — discovery goes through the binding API
    (and grep).
  - `getEnvForAgent`/`makeBindingLoopback`: third loopback type minting the
    `Worktree` RpcTarget.
  - `describeBinding`: returns the agent-API section of `worktree.d.ts` (the
    `---- BEGIN AGENT API ----` marker), following the `agent-spawner-binding.txt`
    pattern for shipping the text.
- **Lazy content in the OT machinery**: `buildChatContent` / session content for
  worktree roots must not materialize the whole tree. Applying a `CodeChange` needs
  base text only for *touched* paths; reads resolve through
  `readFileAtCommit(pinBase, path)` (fault-pulling the blob if missing).   Content maps
  for worktree ids hold only touched/read files over a lazy base resolver.
  Oversized/binary base files: clean tool error on read; a `set` (whole-file write)
  is still allowed on those — but not on symlink/gitlink paths, which reject
  reads *and* writes with the descriptive errors from the modes locked decision.
  A path naming a base *directory* also rejects writes and deletes (`"<path> is a
  directory"`; reads report "no such file"): a git tree cannot hold a file and a
  directory of one name, so such a write could never commit, and failing at the
  write keeps the error next to its cause rather than surfacing at a far-away
  `commit()` or accept-time auto-commit. The check covers base entries only — a
  conflicting shape the overlay itself creates (`set a/b` then `set a`) is caught
  by commit-time tree building ("conflicting file paths"), the backstop for
  everything write-time checks can't see. Directories are never deleted
  explicitly: git has no empty directories, so deleting a directory's last file
  prunes it (recursively) from the committed tree.
- **Epoch reset in `mergeChanges`**: after commits land and pins reset, **every**
  live worktree re-pins in the new generation, and the re-pins are recorded on the
  merge message itself (a new `worktreePins` field, §4). The durable record is
  required: the epoch boundary is exactly where pins otherwise evaporate — both
  `buildChatContent` and compaction checkpoints (which clear pins at a boundary)
  must be able to re-establish worktree bases from the log alone. Per worktree: if
  the closed epoch left it dirty (flatten ≠ `pinBase` tree), write an auto-commit
  via `writeChangedFilesAsCommit({treeBase: pinBase, parents: [pinBase]},
  touchedFiles)` — or reuse `headCommit` outright when the flatten equals its tree
  (the agent committed and then made no further edits; no new object needed) — and
  set `pinBase` to it; a clean worktree re-pins at its unchanged `pinBase`.
  Auto-commit identity is the accepting user's profile — the same
  `commitIdentityForAuthor(userMeta.profile)` the accept's gadget commits
  already use — which is cosmetic anyway: auto-commits are squashed out of
  explicit history, so this identity never appears in anything pushed.
  `headCommit` is untouched. Worktrees never gate accept (no mainline record, no
  staleness).
- **`Worktree` binding API** (finalize `worktree.d.ts`; the `TODO(now)` file ops):
  - `listFiles(path?, options?: {recursive?: boolean}) → FileMetadata[]` (path +
    entry kind — file/executable/dir/symlink/submodule, per the modes locked
    decision; **no size** — git tree entries carry mode, name, and oid but no
    blob size, and a filtered pull leaves omitted blobs' sizes unknown until
    fetched, so sizes would force fetching every blob).
  - `readFile(path) → string`, `writeFile(path, text)`, `deleteFile(path)` — text
    oriented, regular files only (symlink/gitlink paths throw the descriptive
    errors from the modes locked decision, and writing or deleting a base
    *directory* path throws `"<path> is a directory"` — see the lazy-content
    bullet; deleting a directory's last file prunes the directory at commit);
    writes/deletes are OT rows exactly like the file tools' (they join
    the same step buffer and land through the same barrier, so replay and the
    UI-someday subscription see them). **`writeFile` on an existing, readable file diffs**: the OT row is a
    minimal edit computed via `diffFiles` (fast-diff) against current content, not
    a whole-file `set` — keeping rows and composed changes bounded by changed
    regions. `set` is used only for new files and for bases we can't read
    (oversized/binary). (The gadget `writeFile` *tool* emits whole-file `set`s
    today; adopting the same helper there is a cheap follow-up, out of scope here.)
  - `grep(path, pattern)` / `structuredGrep(path, pattern)` — regex over a file or
    recursively over a directory; **one batched fetch** fills any missing blobs
    before matching; files over the size cap (and binaries, symlinks, and
    submodules) are skipped, with a note
    in the output. (`RegExp` params are fine: the binding is served over Workers RPC
    inside the server, which has always supported RegExp serialization.)
  - `commit(message) → oid` — writes a real git commit capturing the worktree's
    current content. **The new commit's parent is `headCommit`, the last explicit
    commit.** This parent choice is what implements the squash: if accepts have
    advanced `pinBase` through auto-commits since the last explicit commit, those
    auto-commits simply never appear in the new commit's ancestry. The tree is
    built the same way `mergeChanges` builds one — since the current content is by
    definition `pinBase`'s tree with the current epoch's overlay applied,
    `writeChangedFilesAsCommit({treeBase: pinBase, parents: [headCommit]},
    overlayTouchedPaths)` produces it directly, with no diff computation. Then
    **only `headCommit` advances**; `pinBase`, the chat's pin, and the OT rows are
    all untouched, so the rows remain the single record of the overlay and replay
    cannot double-apply it. Right after a commit the content is unchanged and
    `diff()` is empty — exactly git's own behavior after `git commit`. Head
    advancements **ride the step buffer** (plans/step-transactionality.md, a
    prerequisite of this plan): `commit()` writes the git objects eagerly
    (content-addressed and idempotent — a crash orphans them harmlessly) but
    advances only the in-memory head, which later calls in the same execution
    read. The step's persistence barrier then, in the same storage transaction
    that persists the enclosing `executeCode` call's record, advances the
    record's `headCommit` and records the advancements as `worktreeCommits` on
    the step's `"changes"` message (§4) — the durable, sequence-bearing record that revert
    rollback keys on. An advancement is therefore durable iff the call that made
    it is in the transcript: no staging collection, no vouching, and no crash
    window between them. Commit identity is the current agent turn's
    **initiator** — the author of the message that caused the agent to run
    (the `AiChatAuthorInfo` already threaded through every turn, via
    `commitIdentityForAuthor`) — so in a collaborative chat a collaborator's
    work is attributed to the collaborator, matching how accepted commits use
    the acting user's profile. The initiator therefore has to reach the
    `Worktree` loopback, which is minted per agent session anyway. Replay is
    safe: executeCode results are recorded, so the call never re-executes on
    replay.
  - `diff(commitId?) → string` — unified diff of current content vs. the given
    commit (default `headCommit`). Needs a small git-style unified-diff formatter
    (new utility; we have diff engines but no printer). `commitId` may be any local
    commit (e.g. `baseCommit` to see all changes since mount).
  - Punted, recorded in the .d.ts as future work: `merge`, `reset` (hard reset =
    create a new worktree).

### 3. GitHub gatekeeper: git operations (gatekeeper-github)

- **Session API** — extend `GitHubRepo` (this is the `types.d.ts` TODO), all
  observations, every commit id they return advertised via
  `GitCache.advertiseCommit()` (cursor-returning methods advertise per page —
  see below; the session obtains its cache stub once, via
  `ObservationAuthorizer.getGitCache()`) — with one carve-out: a result **served
  from the git cache rather than from GitHub is never advertised**. Such a read
  is either a commit that came from this remote in the first place (provenance
  already recorded; re-advertising is a no-op) or a simulated pending-push
  commit, which is *not* on the remote yet — advertising it would outlive a
  rejection as a permanently wrong `pullableFrom` hint that also makes a future
  push's marking walk skip the object as remote-known, under-filling its pack.
  Concretely: `getCommit` reports cache-served results (the session skips the
  advertisement wholesale, parents included), and `listBranches`' advertising
  callback withholds any head that is a queued push's commit
  (`isCommitPendingPush`, checked live per page):
  - `listBranches(filter?) → Cursor<{name, headCommit, ...}>`
  - `listTags(filter?) → Cursor<{name, commit, ...}>`
  - `getCommit(ref) → CommitDetails` — full/truncated SHA, branch, or tag; REST
    `/repos/{o}/{r}/commits/{ref}` resolves truncated ids natively. This is the
    agent's path for "a code comment mentions abc1234".
  - `listCommits({branch?, path?, since?, ...}) → Cursor<CommitSummary>` — history
    enumeration.
  - `GitHubPullRequest.listCommits() → Cursor<CommitSummary>`.
  - **Cursor methods advertise per page.** The existing cursor pattern authorizes
    once up front and then fetches pages lazily (`github.ts`'s session methods
    authorize, then return a lazy `StreamingCursor`), so at method-call time no
    commit ids exist to advertise. The up-front `authorizeObservation` still
    gates the read exactly as today; the commit ids are
    advertised by the *pages*: the session wraps the returned cursor in an
    advertising cursor holding a `dup()` of the session's cache stub, and each
    `next()` advertises that page's commit ids (parallel `advertiseCommit()`
    calls; a page with no commit ids advertises nothing). An advertisement is
    workspace-internal pull-routing metadata, not a read, so no observation
    accompanies a page fetch and the audit log stays free of per-page noise —
    listings stay lazy, and the cost is bounded by how far the agent actually
    iterates.
  - Advertise the SHAs existing observations already return, too (`readDiff`'s
    base/head SHAs, `getDetails` branch refs). Advertisements are pull-routing
    hints only; a gatekeeper *may* also `put()` a commit's bytes to upgrade the
    hint to `onRemote` proof (§1) — not needed for
    the v1 flows, where worktree creation pulls the base.
  - Observer verification: unchanged — strategy B's repo ACL covers git data.
- **`gitPull(oids, cache, hints)`** on the gatekeeper DO (`GitHubGatekeeperImpl`):
  - Smart-HTTP protocol v2 `fetch` against `https://github.com/{o}/{r}.git`
    (token auth): hand-composed pkt-line; `want` per requested oid; `shallow`/
    `deepen`/`deepen-since` from `hints.commitHistory`; **at most one `filter`
    line per fetch** — upload-pack accepts a single filter-spec, so combining
    is spelled in the filter-spec grammar, not by repeating the line:
    `blob:limit=N` from `filterBlobSize` alone, `tree:<depth>` from
    `filterTreeDepth` alone, and `combine:tree:<depth>+blob:limit=N` when both
    hints are set (spike 1 verifies GitHub accepts the `combine:` grammar; if
    it doesn't, the client sends `tree:<depth>` alone — hints are advisory by
    contract, and the transfer limiter bounds the resulting blob over-fetch).
    In practice no v1 call site sets both: creation pulls use `blob:limit`
    only, and the exact-object pull-through defaults are pure tree filters —
    `tree:0` with a commit want, and `tree:1` with a tree want already
    excludes the entries' blobs, so no blob filter is needed alongside it.
    no `have`s (the transport locked decision — a `have` from a filtered pull
    would exclude exactly the omitted objects a blob/tree fault wants);
    immediate `done`, single round.
  - Strip the response's protocol framing (pkt-line, sideband demux) and stream
    the raw pack body into `GitCache.consumePack()`, which unpacks and stores
    every object overseer-side (delta resolution included — §1), then verify the
    requested oids appear among the returned list. No pack parsing in the
    gatekeeper; nothing is retained locally.
  - Blob faults: individual/batched blob `want`s over the same fetch command
    (partial-clone lazy fetch — this is exactly what git itself does against
    GitHub). Oversize protection per spike 1's outcome: either a
    `blob:limit=MAX_WORKTREE_FILE_SIZE` guard filter (an oversized blob then
    never downloads — the read errors, cheaply, on each attempt) or, if
    explicit wants override filters, no filter plus the transfer limiter and
    `put()`'s size rejection, whose measured size is the one thing metadata
    records (§1: sizes from measured bytes only; omissions and limiter
    aborts record nothing).
- **Push** — queued action `push(branch, commitId, {force?})`:
  - Queue: the `ActionDescription` declares `pushedCommits: [commitId]`, and the
    overseer's `submitAction` verification + marking (§1) *is* the validation —
    an unrelated commit, a missing ancestor, or an unproven root fails right
    there, agent-visible, before anything is queued. **The queue path also
    binds the expected remote ref state**: the DO reads the branch's current
    head (zero-id if the branch doesn't exist), **overlays this repo's earlier
    queued pushes** (the same `#simulateBranchHead` overlay the simulation
    reads use — so stacked pushes compose, the second binding its expectation
    to the first's `newSha`, and approving them in order applies cleanly; a
    push whose target is already at `commitId` is a no-op and queues nothing),
    and stores `{branch, expectedOldSha, newSha, force}` as the per-action
    record — what the user approves is "move `branch` from `expectedOldSha` to
    `newSha`", not "move `branch` from wherever it is by then". A non-force
    push additionally requires `expectedOldSha` to be an ancestor of `newSha`,
    checked at queue time — *before* `submitAction()`, via
    `GitCache.isAncestor()` (§1; added for exactly this, since the commits
    aren't in the gatekeeper's scoped view until the action is queued, and a
    post-queue failure would strand an unwithdrawable action) — over the
    cached commit chain, which is cached by construction in the supported
    flow (agent-authored commits atop a pulled base); a head that isn't in it
    fails queuing with "branch has moved /
    not a fast-forward — pull the new head and rebase, or force". **Branch
    creation (`expectedOldSha` = zero-id) is exempt** from this check — there
    is no old head to fast-forward from, and the zero-id CAS at apply is what
    protects against a branch appearing in the interim — so non-force pushes
    can create branches. `force`
    controls *only* this fast-forward policy check — it does not loosen
    old-SHA matching at apply (below). Description names repo, branch, commit,
    force-ness, and the expected old head. Simulation overlays the pending
    push onto `listBranches`/`getCommit` reads per the write-gatekeeper
    simulation convention — branch at `expectedOldSha` reads as `newSha`,
    exactly the transition apply will enforce — reading pending commits via
    `GitCache.get()`, which serves (pulling through if needed) exactly what is
    queued for push to this remote, to be treated as already pushed. Two
    sharp edges of the overlay: a queued *creation* injects its branch into
    `listBranches` only while the remote still lacks the name (checked against
    the live branch — once a same-named branch appears, the creation's
    expectation is invalidated exactly like a moved head's, and the real row
    is listed rather than hidden); and simulated results are never advertised
    (the cache-served carve-out in the session bullet above).
  - Apply: **no gatekeeper-side object walk at all** — call `buildPack()` on the
    action-scoped `GitCache` stub passed to `applyAction()` (approval can happen
    hours after the session that queued the action, so the cache must arrive
    with the apply call — §1/§4) and stream the pack into a send-pack request
    with the ref-update command (`old-sha new-sha refs/heads/branch`), where
    **old-sha is the queue-time `expectedOldSha`** (zero-id for branch
    creation). Receive-pack's old-SHA compare-and-swap applies to *every*
    update, force or not — the wire protocol has no force bit, and fast-forward
    policy was already enforced at queue time — so a branch that moved between
    approval and apply fails the apply cleanly instead of being clobbered:
    a force push can't stomp work that landed while approval was pending, and
    a branch created in the interim fails the zero-id CAS rather than being
    overwritten. The error tells the agent the branch moved; the recovery is
    to re-observe and queue a fresh push against the new head. The overseer composes the
    pack from the action's pending-push marks, faulting in any absent marked
    objects from their recorded sources — that is the cross-remote
    (pull-from-A-push-to-B) case, batched; a push back to the origin costs
    nothing extra, since the marking walk already excluded everything the remote
    has. An oversized blob in the closure fails a cross-remote push with a clear
    error when the pull-through hits `put()`'s size rejection — accepted for
    now (a same-origin push never meets one: it's remote-known and excluded).
    **Apply is idempotent with deliberately desired-state semantics** (the §4
    `applyAction` contract): apply succeeds iff the branch ends up at `newSha`
    — by our CAS'd push, or by finding it already there. The intended
    transition `{branch, expectedOldSha, newSha}` is durable in the per-action
    record from queue time, and there is **no durable "apply attempted"
    marker** (decided): an apply that finds the branch already at `newSha`
    reports success with `previousSha = expectedOldSha` without knowing
    whether an earlier attempt landed it (the crash window between GitHub
    accepting the push and the overseer persisting the completion — the case
    that matters) or a third party independently pushed the exact same commit
    id before our first attempt (a freak case: same oid = byte-identical
    outcome, so the approved end state holds either way and success is the
    honest report). In that freak case a later revert rolls the branch back
    to `expectedOldSha`, undoing the third party's identical push too —
    accepted: the two histories are indistinguishable without a marker, and
    the revert restores exactly the pre-approval state the user looked at
    when approving. Revert = ref rollback to `previousSha` (or delete, if the
    push created the branch); the pushed objects stay `onRemote` (§1).
  - "Create a PR from a commit" = `push` to a branch + the existing
    `createPullRequest` (document the flow in types.d.ts; add a convenience only if
    it earns its keep).

### 4. Shared API finalization (workshop-shared)

- The `gatekeeper.ts` types from 34ebecd land essentially as sketched, with:
  - `GitCache` finalized as `get(oid, hints?)` / `has` / `stat` / `put` /
    `advertiseCommit()` / `buildPack()` / `consumePack()` /
    `isAncestor()` (§1; `isAncestor` was added with commit 7 — the fast-forward
    check has to run before `submitAction()` puts the commits in view); the
    sketch's `pull()` TODO resolves by
    *deletion* — gatekeepers never trigger pulls. The interface extends
    `RpcTarget`, and `gitPull`/`applyAction` receive it as `RpcStub<GitCache>`.
    Doc-comment the scoped view
    (`onRemote ∪ pendingPush`, null otherwise, uniformly across
    `get`/`has`/`stat`), the simulation contract (a pending commit reads as
    already pushed), `advertiseCommit()`'s assertion-not-proof grade and
    commits-only scope (trees/blobs are advertised implicitly as `put()`
    referents), `buildPack()`'s zero-argument, apply-time-only nature (the
    action-scoped stub supplies the commit list and closure),
    `consumePack()`'s equivalence to a sequence of `put()`s,
    `isAncestor()`'s deliberate unscoping (local-only walk; one bit of
    ancestry between oids the caller already holds — see the trust-model
    watch-for), and the
    parallel-`put` note (no batch method for loose objects — `consumePack` is
    the bulk path for packs; the stub is facet-to-parent, always local).
  - `ActionDescription.pushedCommits?: GitOid[]` — the push declaration
    `submitAction` verifies and marks (§1). Doc-comment the symmetry:
    gatekeepers *advertise* commits (`advertiseCommit()` — unproven pull-routing
    hints), actions *declare* pushes (`pushedCommits` — ancestry-checked as a
    mistake-safeguard, and the source of the pending-push view that simulation
    reads).
  - `Gatekeeper.applyAction()` gains a `GitCache` parameter (§1 — the queue-time
    stub is unavailable at apply time; the apply-time stub is action-scoped and
    carries `buildPack`). Its doc-comment also gains the general contract that
    the overseer may deliver the same apply more than once (crash/retry), so
    implementations must be idempotent — formalizing what crash recovery always
    implied. The comment creates no new obligation: an existing action that
    duplicates its external mutation on a retried apply (e.g. an unguarded
    `createIssue`) is already buggy in the wild today, comment or no comment.
    The new push action honors the contract (§3); making the requirement
    visible is what this plan ships, and remediating existing gatekeepers'
    actions is deliberately out of scope (tracked as future work, not silently
    ignored).
  - `GitPullHints.commitHistory` stays **required** — a default would have to be
    either "full" (which we never intend to request) or an arbitrary depth; better
    to make every caller say what it means. `filterBlobSize`/`filterTreeDepth`
    gain a doc note that both may be set together and that a gatekeeper whose
    transport can't combine them (upload-pack takes one filter-spec; combining
    needs the `combine:` grammar, §3) may honor only the tree filter — sound
    because hints are advisory by contract.
  - `Gatekeeper.gitPull`'s "put each requested object or throw" contract gains
    the filtered-omission carve-out (§1): a requested blob the hints' own
    `filterBlobSize` suppressed is reported by returning successfully without
    it, rather than by throwing — the overseer surfaces that absence as the
    too-large read error (and deliberately records nothing from it; absence
    is a gatekeeper behavior, not a measurement).
  - Doc comments to the kernel review bar on every export; `@validateRpc()` on the
    implementations (per repo convention — it goes on implementations, not
    interfaces).
- `worktree.d.ts` finalized per §2 (file ops filled in, commit-squash semantics
  documented from the *agent's* point of view — i.e. not documented at all: the API
  simply reports the last explicit commit as HEAD; the modes behavior *is*
  documented — `listFiles` kinds, executables keeping their bit, symlinks/
  submodules erroring on touch — since the agent needs it to interpret errors).
- `api.ts` changes are minimal but real (tool calls and chat-log message shapes
  live there):
  - a `createWorktree` `AiToolCall` variant, carrying the recorded
    `{worktreeId, changeId}` output;
  - `createdWorktrees` on `"changes"` messages — separate from `createdGadgets` so
    the frontend never renders a worktree as a gadget creation;
  - `worktreeCommits` on `"changes"` messages — `{worktreeId, commit,
    previousHead}[]`, the durable record of explicit `commit()` head advancements
    (recorded at the step barrier on the step's single `"changes"` message, like
    `createdGadgets` — a step's extras and edits revert together; the revert
    rollback anchor — see the edge case);
  - `worktreePins` on `"merge"` messages — the epoch re-pins (§2), the durable
    record `buildChatContent` and compaction checkpoints re-establish worktree
    bases from.
  Frontend impact is one small diff, not zero: `AiToolCall` is an exhaustive
  union in `ChatInterface.tsx` (`getToolCallSummary`, `describeToolCallCount`,
  `getProvisionalToolVerb` — the last with an explicit `never` check), so the new
  variant needs its rendering cases ("Created worktree …" / "Creating worktree").
  That's desirable anyway: the transcript should show the creation. The new
  message *fields* are ignored by the frontend, and all worktree content is
  stripped from client deliveries (see the delivery-filtering locked decision).

## Constants (tunable, named in one place)

- `EAGER_BLOB_LIMIT` — blob size fetched eagerly when pulling a worktree base
  (64KB); used by both the creation pull and a later base fault.
- `MAX_WORKTREE_FILE_SIZE` — hard per-file support cap (~1MB; must respect the
  existing `MAX_FILE_TEXT_LENGTH` UTF-16 and 2MB-record constraints).

## Verification spikes (early, cheap, before the transport commits)

1. **GitHub upload-pack capabilities** against a live repo: protocol v2 fetch with
   SHA `want`s for commits *and* blobs, `shallow` combined with `filter`,
   `blob:limit` and `tree:<depth>` support — including the exact-object mappings
   the pull-through defaults depend on (`tree:0` alongside a commit want — also
   the "pull a shared ancestor commit alone" flow; `tree:1` alongside a tree
   want, which should exclude the entries' blobs by itself), **and the
   `combine:tree:<depth>+blob:limit=N` filter-spec grammar** — upload-pack
   takes one filter-spec per fetch, so honoring both hints at once depends on
   `combine:` support; §3 defines the fallback (send `tree:<depth>` alone) if
   GitHub rejects it. (Partial-clone lazy fetch implies blob
   wants work; verify rather than assume — the repo's own AGENTS.md pattern.)
   Include: does `filter blob:limit` suppress **explicitly wanted** blobs? This
   decides the oversized-blob fault path — either the wanted blob never
   arrives (→ blob-fault fetches guard with
   `blob:limit=MAX_WORKTREE_FILE_SIZE`; an oversized blob is never
   downloaded, each read of it errors cheaply, and nothing is recorded —
   §1's rule that absence proves nothing) or it
   arrives huge (→ blob-fault fetches send no filter, since one wouldn't be
   honored; the transfer limiter bounds the download, and `put()`'s size
   rejection measures the exact size, which metadata records and later reads
   fail fast on). Both are
   handled with no absence-based bookkeeping; the fetch client just needs to
   know which world it is in.
2. **isomorphic-git pack parsing reusability**: can its pack/delta machinery be
   driven standalone (without its fs/gitdir assumptions), or do we write the
   ~200-line parser ourselves? This informs `GitCacheImpl.consumePack()` in
   workshop-backend (the decoder lives overseer-side, not in gatekeepers), so
   it lands before or with commit 2, not commit 6.

## Known edge cases / watch-fors

- **Provenance loss**: a disconnected/deleted gatekeeper record makes its objects
  unpullable. No eviction in v1 means already-pulled objects keep working; only
  *new* faults fail, with an actionable error — including a `get()`/`buildPack()`
  pull-through mid-simulation or mid-apply ("reconnect X").
- **Trust model: oids are capabilities, and gatekeepers are trusted with them.**
  The scoped cache view is a mistake-safeguard and a simulation aid, **not a
  confinement boundary** — don't document it as one. Assume a gatekeeper can
  read any object whose oid it knows: for a tree/blob it can fabricate a commit
  naming the oid, parent the fabrication on an `onRemote` commit of its own,
  and declare it in `pushedCommits`; and the shared-ancestry rule is not
  security-grade either — obtaining the *content* of any one commit in a
  history (a root commit may even be guessable) and `put()`ing it makes
  everything chaining onto it pushable to, and hence readable by, that
  gatekeeper. This is consistent with the existing trust model: gatekeepers
  already implement their own pre-approval simulation, and nothing stops one
  from skipping the approval flow entirely — users must not connect a
  gatekeeper they don't trust to a workspace holding sensitive data. Least
  authority still applies (don't widen the view casually), but don't contort
  the implementation chasing stronger properties here, or claim guarantees
  stronger than these.
- **A false `advertiseCommit` can mis-tag a pending-push object**: §1's commit
  bias flips an absent marked tree/blob's asserted type to "commit", so
  `buildPack`'s fault for it uses commit-shaped hints; if the transport's
  filter then suppresses the wanted object, the apply fails retryably
  (warn-logged) and self-heals when the bytes arrive by any route. Accepted:
  it requires a forged/buggy advertisement aimed at an oid the same workspace
  has queued for push, and the failure is loud, not silent.
- **Symlinks and submodules (gitlink entries) are inert everywhere** (the modes
  locked decision): the lazy walker and `listFiles` surface them with their
  kind and never walk through a gitlink; file ops on them throw the
  descriptive errors (naming the symlink target / gitlink commit); grep skips
  them with a note. The marking walk skips gitlinks (§1 — following one would
  mark a foreign repo's commit) and pushes never include their target commits,
  while symlink blobs travel in push closures like any other blob. Consistent
  with the text-only scope.
- **Local-root histories are unpushable by design**: a worktree created from a
  purely local commit (gadget history, another worktree) fails ancestry
  verification against every gatekeeper — nothing in its history is proven on
  any remote, and root commits get no vacuous pass. The queue-time error should
  say so plainly; exporting local work to a fresh repo is the punted,
  explicitly-human flow.
- **Prefix resolution** in `createWorktree` is against *local knowledge only*
  (`gitObjects` ∪ `gitObjectMetadata`) — never a remote lookup. Remote
  truncated-id resolution is `getCommit(ref)` on the gatekeeper, which returns
  (and advertises) the full oid.
- **Auto-commit chains**: `pinBase` may advance through several auto-commits across
  several accepts before an explicit `commit()`. This costs nothing at commit time:
  the tree is always built from `pinBase` + the current epoch's overlay (pre-reset
  changes are already inside `pinBase`'s tree), and only the *parent* pointer names
  `headCommit`.
- **`mergeChanges` staleness**: worktree pins must be excluded from the fast-forward
  gate (no mainline head to compare) and from `updateChatFromMainline`'s stale set.
- **Compaction**: checkpoint pins already carry `{gadgetId, baseCommit}`; worktree
  pins ride along unchanged within an epoch. Across an epoch boundary, checkpoints
  clear pins — worktree bases then re-establish from the merge message's
  `worktreePins` (§2/§4), which is why that field is the durable record and not
  just record state. Verify checkpoint `proposedChange` composition handles
  worktree ids (it should — ids are opaque).
- **Chat deletion**: delete worktree records + chat bindings; objects stay (no GC,
  dangling is fine and consistent with gadget history behavior).
- **Turn abort / revert vs. `commit()`**: a `commit()` happens *inside*
  `executeCode`, with no log event of its own, while reverts mark messages, not
  calls. That is why advancements ride the step's `"changes"` message's
  `worktreeCommits` field (§2/§4): the durable record has a chat sequence, like
  pending creations and binding additions. With the step barrier
  (plans/step-transactionality.md) the lifecycle is short:
  - **Revert**: a revert covering a `worktreeCommits`-bearing message rolls each
    affected worktree's `headCommit` back to the earliest reverted advancement's
    `previousHead` (entries are ordered within a message and messages by
    sequence, so multiple commits per step or per reverted range compose).
  - **Turn abort / crash mid-step**: the in-flight step's buffer — edits and
    head advancements alike — simply evaporates; nothing durable exists until
    the barrier. Completed steps' advancements are ordinary message-recorded
    state that abort deliberately keeps (abort stops the agent, it does not
    revert; the user reverts explicitly if they want the work gone).
  - **Accept/merge**: cannot run mid-turn (turns hold the chat), so it never
    observes a mid-step advancement.
  The commit objects themselves always remain — dangling and harmless, like
  auto-commits; a queued push referencing a rolled-back commit's oid stays valid,
  since the object is real. Test: abort after a mid-step commit (buffer dropped,
  `headCommit` unchanged); a user revert spanning a step that committed twice;
  crash-resume mid-step (no durable trace; the re-run's `commit()` parents on
  the unchanged head).
- **Delivery filtering must cover every client path**: live `changeApplied` events,
  subscribe-replay of retained rows, message delivery (`"changes"`/`"merge"`
  payloads and pins), and chat metadata (`codeBase` pins). Miss one and the
  frontend's OT client fetches a repo-sized base commit. Test by subscribing as a
  client to a chat with an active worktree and asserting no worktree `CodeChange`
  entry, pin, or commit content appears anywhere in the received traffic — and
  that the revision stream stays gapless across stripped rows. The assertion is
  deliberately *not* "no worktree id anywhere": the delivered `createWorktree`
  tool call carries `worktreeId` by design (see the delivery-filtering locked
  decision), and a bare id triggers nothing in the existing client — the test
  guards exactly the set of things that would make `otClient.ts` fetch content.
- **`getCodeAtCommit` is client-callable with an arbitrary oid** and materializes
  the full tree server-side. Deliberately left alone (decided): it keeps its
  existing non-faulting read path — a missing object is an immediate error, which
  a filtered/shallow-pulled repo hits almost immediately, and wiring it into the
  lazy walker would be added code for nothing — and it gets **no materialization
  cap**. The RPC layer already bounds a response at 32MB, a client deliberately
  requesting a large fully-local tree is not a concern worth guarding, and the
  whole interface is expected to change in a near-term follow-up — so no
  hardening now.
- **Pack parsing is hostile-input parsing**: `consumePack()` makes the pack
  decoder a kernel-side component whose input stream comes from a gatekeeper
  (for GitHub, bytes it relayed over TLS — but any gatekeeper can feed it
  anything), so parse defensively (bounded allocations, no trust in claimed
  sizes) — hash verification of each decoded object is the backstop for object
  *content*, exactly as with `put()`.
- **Rate/size limits**: one fetch per worktree creation and per batch fault keeps
  request counts trivial; the transfer-size limiter pattern from artifact-sync
  (64MB) should wrap the fetch body.

## Commit sequence

Ordered so kernel diffs are isolated and reviewable apart from the gatekeeper work
(AGENTS.md kernel bar). Each commit keeps the packages it *modifies* building and
testing green; packages that merely depend on a modified one are allowed — and
expected — to be temporarily broken until the later commit that adapts them (e.g.
workshop-backend does not compile between commits 1 and 2). No vacuous stubs just
to keep dependents compiling. PR boundaries to be decided later.

0. **Prerequisite: the step-transactionality refactor**
   (plans/step-transactionality.md) lands first, as its own PR — it fixes a live
   crash bug independently of worktrees, and commits 3–4 assume the per-step
   buffer and transactional barrier it introduces (worktree edits and `commit()`
   head advancements have no crash machinery of their own).
1. **shared: git cache API** (workshop-shared) — finalize changes from 34ebecd:
   `gatekeeper.ts` additions (`GitCache` as scoped `get(oid, hints?)`/`has`/
   `stat`/`put`/`advertiseCommit`/`buildPack`/`consumePack` with the
   parallel-`put` doc note and
   the simulation contract, `GitPullHints` with `commitHistory` required,
   `Gatekeeper.gitPull`, the `RpcStub<GitCache>` parameter on
   `Gatekeeper.applyAction`, `ActionDescription.pushedCommits`,
   `ObservationAuthorizer.getGitCache`),
   fully doc-commented. No implementation yet: workshop-backend is left
   uncompiling until commit 2 (per the per-package rule above). The one
   downstream adaptation shipped here is gatekeeper-cloudflare's, whose
   read-only `applyAction` aligns its signature with the interface so the
   class-typed test facet can pass a stand-in cache.
2. **backend: git cache + provenance + push authorization** — `GitCacheImpl`
   (per-gatekeeper stub minting; scoped `get`/`has`/`stat` incl. pending-push
   pull-through with hints; `put()` with proof-of-possession recording;
   `buildPack` over a new undeltified pack writer; `consumePack` over a new
   pack reader with ofs/ref delta resolution — spike 2 decides isomorphic-git
   reuse vs. the hand-rolled parser), `gitObjectMetadata`
   (type/size/`onRemote`/`pullableFrom`/`pendingPush`) + the `pushMarks` action
   index, metadata recording at `advertiseCommit()` and `put()` (incl.
   tree/commit referent rows), `submitAction` ancestry verification + marking
   walk + lazy propagation + mark lifecycle (apply-converts / reject-cleans /
   revert-keeps), `ensureGitObjects` pull driver, the lazy walker
   (`ensureObject`, hand-rolled tree/commit parsers over the shared raw codec),
   passing the cache to `applyAction` and implementing `getGitCache()` on
   `ApprovalQueueImpl`/`SlashCommandAuthorizerImpl` (this commit returns
   workshop-backend to green), git-store extensions (`readFileAtCommit`,
   `listTreeEntries`, `writeChangedFilesAsCommit` with separate
   treeBase/parents, raw object helpers). Workerd tests: cache round-trips vs
   known-good git hashes, poison rejection, metadata at every write point,
   the type-claim reconciliation matrix (measured bytes correct an asserted
   type; an assertion never overrides a measured one but still records its
   routing hint; commit-bias among assertions, else first claim wins;
   ancestry verification judging a proven object by decoded local bytes over
   its recorded type),
   size recording from measured bytes only (exact `size` from a `put()` incl.
   cap rejection, then fail-fast on later reads; a filtered omission — the
   gitPull carve-out — surfaces the too-large error, records nothing, and
   retries on the next read),
   fault-pull-retry with a mock gatekeeper, ancestry verification (proven-base
   pass; absent-ancestor error; root-commit rejection; `advertiseCommit()`
   alone rejected while `put()` passes), marking-walk matrix
   (remote-known skipped without descent, gitlinks skipped, absent objects
   marked + lazy propagation at `put()`), the `get()`/`has()`/`stat()` view
   matrix (onRemote / pendingPush / other × present / absent, pull-through
   receiving the hints), mark lifecycle
   across apply/reject/revert and a crash between push and conversion,
   `buildPack` completing the closure (absent marked tree faulted → children
   marked and faulted in turn, batched per source; action-scoped stub required,
   session stub throws) with output verified by real `git index-pack` fixtures,
   `consumePack` decoding packs produced by real `git pack-objects` (incl.
   ofs/ref delta objects) with `put()`-equivalent verification and metadata
   (and rejecting corrupt/oversized input defensively),
   walker output
   cross-verified against isomorphic-git over the same store, changed-files
   commits reusing subtree oids and preserving modes (edited `100755` file
   keeps its bit; untouched symlink/gitlink entries copied through verbatim;
   new files default `100644`), walker/`listTreeEntries` parsing all five
   entry modes from a real-git fixture tree, non-UTF-8 entry name → fatal
   decode error naming the tree oid (fixture tree written with raw bytes),
   UTF-8 names round-tripping byte-identically through parse + rebuild
   (unchanged subtree oids preserved).
3. **backend: worktree records + createWorktree + file tools** — `GadgetRecord` →
   `WorkpieceRecord` (`type` discriminator, optional `bindingName`, null-index
   opt-out) with the full consumer audit (`subscribeToWorkpieces`,
   `defaultBindingList`, promotion/reconciliation, blueprint enumeration, loader
   paths), the version 3→4 storage migration stamping existing rows
   `type: "gadget"` (chained after `#migrateToActionIndexes`;
   `#initializeNewWorkspace` and the `version` singleton doc comment move to 4;
   see §2), api.ts additions (`createWorktree` tool-call variant,
   `createdWorktrees` on changes messages) with the frontend's tool-call
   rendering cases (the exhaustive `AiToolCall` switches in `ChatInterface.tsx`),
   `createWorktree` tool (local + metadata prefix resolution, gatekeeper-free
   commits allowed, initial pull, recorded output, birth pin, pending
   lifecycle), the four dispatch seams, lazy
   content for worktree roots in `buildChatContent`/session content (no
   system-prompt changes — worktrees are announced by their own tool results),
   **client delivery filtering** (rows, replay, messages, metadata;
   revision-preserving). Tests: the 3→4 migration (pre-existing rows gain
   `type: "gadget"` with their `byBindingName` entries intact; crash before the
   stamp retries whole; never-initialized DOs stay write-free; chained run from
   an older version), create/replay determinism,
   create-from-local-commit (no gatekeeper), edit-through-OT on a worktree, lazy
   blob fault, oversize/binary read errors, symlink/gitlink touch errors
   (message names the link target / submodule commit; writes rejected too),
   revert-deletes-worktree, chat-deletion
   cleanup, other-chat invisibility, and the client-subscription leak test (no
   worktree `CodeChange` entries, pins, or commit content in delivered traffic —
   bare worktree ids in tool calls are expected; gapless revisions across
   stripped rows).
4. **backend: epochs + Worktree binding API** — auto-commit + re-pin at
   `mergeChanges` reset (`worktreePins` on the merge message, headCommit reuse
   when trees match, squash semantics), the `Worktree` RpcTarget (listFiles/
   readFile/writeFile/deleteFile/grep/structuredGrep/commit/diff, with
   diff-based `writeFile`), buffered `commit()` head advancements landing as
   `worktreeCommits` on the step barrier's `"changes"` message (in-memory until
   the barrier; §2) + the revert rollback rules, unified-diff formatter,
   `describeBinding` text, finalized `worktree.d.ts`. Tests: accept with dirty
   worktree preserves
   content and squashes (explicit commit parents on last explicit head after N
   accepts, tree built from pinBase + overlay only), commit() leaves pins/rows
   untouched (no double-apply on replay; empty diff right after), commit
   identity is the turn initiator (collaborator's turn → collaborator's
   name), `listFiles` entry kinds and executable-edit-keeps-mode end to end,
   boundary re-pin
   replay from `worktreePins` (incl. across a compaction checkpoint), commit
   determinism, `writeFile` emits minimal edits (and `set` for new/unreadable
   files), diff output goldens, grep batch-fill (one pull for a directory of
   missing blobs), abort-after-mid-step-commit (buffer dropped, head unchanged)
   and revert-across-two-commits head rollback, crash-resume mid-step (no
   durable trace; the re-run's commit parents on the unchanged head), multiple
   executeCode calls per turn each advancing the head across separate barriers,
   multiple commits within one step (advancements ordered within the message).
5. **github: session git reads** — `listBranches`/`listTags`/`getCommit`/
   `listCommits`/PR `listCommits`, `advertiseCommit()` calls (on new + existing
   SHA-bearing reads; per-page advertising via the cursor
   wrapper), types.d.ts docs. Pure REST; no protocol code yet. Tests extend
   `github-api.test.ts` patterns; include per-page advertising (every commit id
   a cursor returns is advertised; pages
   never fetched are never advertised; commit-free pages advertise nothing).
6. **github: fetch transport + gitPull** — pkt-line composer/parser, protocol-v2
   fetch client (wants/shallow/filter/done — no `have`s, per the transport
   locked decision), sideband demux streaming the pack body into
   `GitCache.consumePack()` (no pack parsing in the gatekeeper — §1),
   transfer-size limiting, oversized-blob handling per spike 1.
   Tests: pkt-line round-trips, framing demux feeding `consumePack` (against a
   mock cache; real pack decoding is commit 2's test surface), hint mapping —
   including the hints-to-filter-spec matrix (blob
   only, tree only, both → `combine:` or the tree-only fallback per spike 1's
   outcome; never two `filter` lines) — and that no fetch command ever emits a
   `have` line. (Spike 1 lands before or with this commit; spike 2 belongs to
   commit 2.)
7. **github: push + PR-from-commit** — `push` action (queue/simulate/apply/
   revert): `pushedCommits` declaration, simulation overlay reading pending
   commits via `get()`, apply = `buildPack` stream → send-pack framing +
   ref-update command; types.d.ts flow docs for push + createPullRequest.
   Also carries the one kernel addition implementation surfaced (separable for
   review): `GitCache.isAncestor()` in workshop-shared + workshop-backend (§1),
   because the pre-queue fast-forward check has no other read path — the
   commits being pushed enter the gatekeeper's scoped view only when
   `submitAction()` marks them, and a post-queue failure would strand an
   already-queued action the queue offers no way to withdraw.
   Tests: queue-time rejection surfaces to the agent (unrelated commit, missing
   ancestry, unproven root, non-force non-fast-forward against the queue-time
   head), queue-time binding against the simulated head (stacked pushes
   compose; already-at-`newSha` queues nothing), `isAncestor` semantics
   (inclusive; merge parents; chain-leaves-cache → false; unknown descendant
   throws; unscoped stub access), simulation reads pending commits as pushed
   (branch at `expectedOldSha` → `newSha`, injected created branches — and a
   branch that appears remotely un-hides itself, ending the injection,
   `getCommit` synthesis from cached bytes), cache-served reads withheld from
   advertising (`getCommit` `fromCache`; simulated branch heads),
   ref-update encoding, branch-moved-after-approval CAS failure for force and
   non-force alike (and zero-id CAS failure when the branch appeared in the
   interim), desired-state
   apply (remote already at `newSha` → success with
   `previousSha = expectedOldSha`, whether a retry or a first attempt),
   revert to `previousSha`, branch-creation push (non-force — zero-id exempt
   from the fast-forward check),
   cross-remote push end-to-end against two mock remotes (pull shared ancestor
   from B → push A-derived commits to B, absent filtered blobs pulled through
   during `buildPack`; oversized cross-remote failure — the closure-completion
   half of this is covered by workshop-backend's git-cache/git-push-actions
   suites; a combined overseer+gatekeeper two-remote harness remains follow-up
   work).

## Punted / future work (deliberately kept open)

- Eliminate `GitStore` by moving its callers to the new `WorkspaceGitCache`.
  This will require reproducing isomorphic-git's functions for encoding objects
  (commits, trees, blobs), but this would not be very hard and it would even let
  us fix some bugs (isomorphic-git's parsing of trees is lossy when names contain
  invalid UTF-8; we'd rather error).
- Improve packfile decoding to avoid keeping entire unpacked contents in memory;
  instead, read objects back from disk where needed.
- Worktree UI (changes view, diffs) — the OT stream + pins already carry everything
  a future subscription needs.
- Eviction/GC — `gitObjectMetadata` is the re-pull index; the GC-roots enumeration
  in git-store.ts gains "worktree `headCommit`/`pinBase`/`baseCommit`" when it
  happens.
- Binary and >1MB file editing; `putStream()` for large blobs; cross-remote push
  of trees referencing oversized blobs (the apply-time pull-through hits
  `put()`'s size rejection and fails with a clear error until then — same-origin
  pushes are unaffected, the marking walk excludes them as remote-known).
- Repo initialization / exporting local-root histories to a fresh remote — an
  explicit, human-initiated (likely UI-mediated) act, deliberately unavailable to
  agents and gatekeepers (root commits get no vacuous ancestry pass; see the
  watch-fors).
- `buildPack` internals: deltified/thin packs, and streaming a source
  gatekeeper's pack straight through to the destination without staging every
  object in the cache.
- Cross-chat / workspace-scoped worktrees; user editing of worktrees (intended
  follow-up — `submitCodeChange` already accepts worktree-targeted changes, see
  the delivery-filtering locked decision; what's missing is UI and unstripped
  delivery).
- `merge` / `reset` on the Worktree API.
- Unifying `GatekeeperRecord` into the workpiece table.
- Diff-based `writeFile` for the gadget writeFile agent tool (same helper).
- Deep-history pulls (`commitHistory: full/since` are specified but GitHub-side
  usage ships shallow-only defaults) — also the missing piece for cross-remote
  pushes of *pre-existing* diverged branches (§1's ancestry-verification bound:
  the head-to-ancestor commit chain must be cached).
- Fetch negotiation (`have`s): v1 sends none, because every pull is filtered or
  tree-limited and a `have` asserts full reachability — no fetched object here is
  provably complete, and a wrong `have` makes upload-pack withhold omitted
  objects a fault explicitly wants. If repeat-creation bandwidth ever matters,
  `have`s need a completeness grade: remember tips only from creation-style
  pulls (depth-1 + `blob:limit` at the standard limit), advertise them only on
  commit-want creation pulls, never on exact-object faults.
- Other git hosts (the gatekeeper interface is host-neutral by construction).
- Auditing existing gatekeepers' actions for `applyAction` idempotency (the
  contract §4 documents; a pre-existing crash-tolerance requirement, not one
  this plan introduces).
