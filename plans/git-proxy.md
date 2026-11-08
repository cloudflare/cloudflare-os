# Plan: Serving native Git fetches from a mounted worktree

Status: planned, not implemented. Builds on the worktree replica API
([`docs/worktree-replicas.md`](../docs/worktree-replicas.md)).

## Goal

A container gatekeeper that mounts a worktree runs builds and tests against it, and some of those
run Git themselves. For example, `packages/integration-tests/scripts/build-upgrade-base.ts` runs
`git fetch --depth=1 origin <UPGRADE_BASE>` and then checks that commit out. The container's `origin`
points at `ReplicableWorktree.gitPull()`, so every fetch the container makes arrives there, and the
kernel must answer it correctly, whatever mix of local and remote history it asks for.

## Policy

Mounting a worktree into a container permits fetching the entire history of the worktree's head
commit. Commit IDs hash their whole history, so when several connections can provide part of it,
it doesn't matter which one serves it.

- A worktree is not tied to a remote. Its head is often a workspace-created commit that no remote
  has. The relevant remote history begins at the history's *boundary*: walking back from the head
  through locally stored commits, the first commits with recorded provenance
  (`gitObjectMetadata.onRemote`/`pullableFrom` naming a live connection).
- Whether a remote commit is in the head's history is decided by asking a connection with
  provenance for the boundary: a commit-only fetch (`filter tree:0`) of the wanted commits with a
  `have` line per boundary commit. An empty pack means yes. The connection's answer is trusted,
  since the data it protects is its own repository. A connection only knows about some boundary
  commits, so a "no" from one connection moves on to the next; the fetch is refused only if some
  connection answered and none confirmed.
- Nothing is looked up in the agent's environment. Other refs of the origin (e.g. `main`) and other
  repositories are out of scope. If they are needed later, the agent should pass them to the
  gatekeeper as objects.

## Current state

Implemented on the `ddr/split-worktree-replicas` branch (see `worktreeGitPull` in
`packages/workshop-backend/src/worktree-git.ts` and the overseer's `worktreeGitPull`):

- Ref discovery (GET `info/refs`, `ls-refs`) is answered by the kernel and advertises only the
  worktree's head.
- A `fetch` whose wants are all local (worktree heads, blobs referenced by pending edits) is served
  by the kernel. For a remote-backed worktree this already merges two packs: the upstream base pack
  (a kernel-composed depth-1 fetch of the base commit) and a pack of the workspace's own objects,
  with base-tree objects excluded from the local half so there are no duplicates.
- A `fetch` whose wants are all non-local runs the ancestry probe, then forwards the container's
  request body verbatim to the confirming connection. `want-ref` lines are refused, because only
  `want <oid>` lines are checked.
- A `fetch` mixing local and non-local wants is refused.
- `Gatekeeper.gitPull(request: Request): Promise<Response>` is a smart-HTTP passthrough. Every call
  the kernel makes is a POST `fetch`; GET forwarding, URL checks and header handling in providers
  are unused.

Gaps this plan addresses:

1. Mixed requests are refused, but the container cannot know which commits are local. The same
   problem appears with a single local want: `git fetch --deepen=N` or `--unshallow` wants only
   `HEAD`, the local path ignores `deepen`, and the clone silently stays shallow.
2. The passthrough forwards the container's own bytes, so safety depends on denylisting lines the
   kernel doesn't check (as with `want-ref`).
3. The local path ignores the container's `have` and `shallow` lines, so every fetch after the
   initial mount resends the head's history back to the boundary.
4. The subscriber is never told the worktree's Git head. `setBaseCommit()` passes the file base
   (`pinBase`) in a field called `head`, and ref discovery advertises `headCommit` as `HEAD`, but
   nothing tells the container to move its HEAD there, or that it moved later.

## Subscriber: deliver the file base and the Git head

`setBaseCommit()` carries both commits and is called whenever either changes:

```ts
setBaseCommit(state: {revision: WorktreeRevision; base: GitOid | null; head: GitOid | null;
  shallowCommit: GitOid | null}): Promise<void>;
```

- `base` (`pinBase`): what the following changes apply to. It changes when the user accepts the
  chat's changes, and the container's files already include it.
- `head` (`headCommit`): the Git HEAD. When it changes, the container fetches it (an all-local
  fetch) and runs `git reset --mixed <head>`, leaving its files alone.
- On a fresh start the container fetches both (one fetch, two local wants), checks out `base`,
  applies the pending changes, and resets to `head`.

The kernel side is small: the drain loop already compares the last delivered base with the current
one, and tracks the head the same way (the subscription record stores both). `headCommit` advances
in the step barrier (`worktreeCommits`), which already wakes subscribers, so the notification is
ordered with the changes around it. Both commits are already in `localHeads`.

Applying each head notification as it arrives keeps the container's object store holding every
workspace-only object of the head's history. That is what makes the request handling below work:
a later fetch is missing only remote history. The container's `.git` rules (not synced; the
gatekeeper owns HEAD and the index; Git state changes come from the workspace) are in
[`docs/worktree-replicas.md`](../docs/worktree-replicas.md#git-in-the-container).

## RPC shape: extend `GitPullHints`

Return to main's structured shape, `Gatekeeper.gitPull(oids, hints): Promise<GitPullTransfer>`,
implemented by providers with `startGitPull` from `gatekeeper-kit/git-pull-transfer`. `GitPullHints`
was designed as a semantic description of a Git fetch, meant to be extended. The kit converts it
to the protocol-v2 request, so a provider stays "add my credentials and POST to my repository's
`git-upload-pack`". Most of the branch's GitHub/GitLab `gitPull` changes revert.

Additions:

- `haves?: GitOid[]`: commits the requester already has, so the remote leaves out their history.
  Packs stay self-contained: a server only sends deltas against objects the client has when the
  client asks for thin packs, and the kit never does. The kit's module doc records "no `have`s
  ever" as a locked decision; it was made for cache fills, which keep sending none, so the
  decision needs updating.
- `shallow?: GitOid[]`: the requester's current shallow boundary, which the remote needs to answer
  a deepen correctly.
- `commitHistory: {kind: "relative", depth: number}`, for `--deepen=N`. `full`, `depth` and `since`
  already exist.
- Shallow information in the result. For a passthrough, the container needs the server's
  `shallow`/`unshallow` lines along with the pack, but `demuxGitFetchResponse` drops those
  sections and the raw pack doesn't carry them. `GitPullTransfer` gains an accessor for them,
  captured while the response's leading sections are parsed, next to `status()`. Keeping them
  beside the stream preserves the `status()` design, which exists because Workers RPC can replace
  a stream's error with a generic disconnect.

`type` and `referencedBy` remain cache hints; the passthrough uses `type: "commit"`.

The ancestry probe becomes an ordinary `gitPull(wants, {type: "commit", commitHistory: {kind:
"full"}, filterTreeDepth: 0, haves: boundaries})` whose pack header the kernel inspects.

## Request handling

The kernel parses every request from the container. Ref discovery stays local. For `fetch`, it
extracts the fields it understands (`want`, `have`, `shallow`, `deepen`, `deepen-since`,
`deepen-relative`, `filter`, `done`, and harmless capabilities such as `ofs-delta`, `no-progress`
and `include-tag`) and refuses anything else. Nothing the container sends is forwarded verbatim:
an upstream request is always re-encoded from these checked fields, which replaces the `want-ref`
denylist with an allowlist.

The kernel classifies a fetch by what the container is missing, not by its `want` lines. The
container's `have` and `shallow` lines say what it already has. For example, `git fetch --deepen=N`
sends `want <head>`, `have <head>`, `shallow <boundary>` and `deepen N`. The head is local, but the
container already has it; what it lacks is history beyond the boundary, which is purely remote.

Then, in order:

1. **All local.** Everything the container lacks is stored in the workspace, possibly together with
   the upstream base pack as today. Serve it locally, honouring the container's `have` and
   `shallow` lines so that only what's new is sent. With head notifications this is the common
   case for fetching a new head, so local negotiation is required, not an optimization.
2. **All remote.** Everything the container lacks is remote history that passes the ancestry probe.
   Proxy it: send the confirming connection a structured request built from the checked fields.
   For a deepen of a local head, that is `want <boundary>` with the container's `shallow`, the
   relative depth, and the `have` lines the remote knows. Frame the remote's pack and shallow
   information for the container.
3. **Spans both.** The container lacks workspace-only objects *and* remote history. With head
   notifications this only happens if the head moves while a command is running Git. Refuse it with
   a clear error ("the worktree's head moved; fetch again"), rather than building the slow path
   first. If real usage hits this, add the cache fill described below.

### Why spanning requests need storage

A pack can't contain the same object twice: native Git rejects it ("The same object %s appears
twice in the pack"). Pack entries carry content, not object IDs. An ID is the hash of the full
object, and an entry may be a delta against an earlier one, so learning a proxied pack's IDs means
decoding it and keeping delta bases around. Workspace-created trees and blobs can coincide with
remote ones (a reverted file, an unchanged subdirectory), so a local half and a proxied remote half
can't be merged blindly once the remote half is "history down to whatever the client has".

Protocol v2's `packfile-uris` does allow several packs in one fetch, and duplicates across packs
are fine. But each URI line carries the pack's checksum, and those lines come before the client
downloads anything. The kernel can't know a proxied pack's checksum until it has streamed through,
so this doesn't help.

## Later

- **Cache fill for spanning requests.** Fill the workspace's Git cache from the remote until it can
  answer the whole request, then serve it locally. Request exactly the remote part: the remote
  wants, the container's depth, and its haves. This stores remote content in the DO, unlike the
  mount path, and reuses the cache's existing pull and ingestion, including its object and pack
  size limits, so a request too large to cache fails with a clear error instead of filling
  storage.
- **Metadata-only merging for spanning requests.** Cache only the remote range's commits and trees
  (`filter blob:none`), compute exactly which tree and blob IDs the remote pack will contain,
  exclude them from the local half, and stream the remote pack (blobs included) through
  `mergePackStreams`. Storage is then metadata only. The prediction must match upload-pack's object
  selection exactly, including how `have`, `shallow` and depth interact: if the local half leaves
  out an object the remote doesn't send, the client's connectivity check fails. Only worth doing if
  spanning requests turn out to be common.
- **Other refs and repositories**, passed to the gatekeeper as objects by the agent.

## Testing

- Native Git against workerd (`__tests__/native/worktree-git.test.ts`) with a real `git
  upload-pack` upstream (with `uploadpack.allowFilter` on, as GitHub and GitLab have), covering:
  - an ancestor fetch (proxied);
  - a non-ancestor fetch (refused);
  - `--deepen` and `--unshallow` of a local head (proxied);
  - a fetch after the head moved, sending only the new commits;
  - a request spanning both (refused with the "head moved" error);
  - the fresh-start sequence (check out `base`, apply changes, `git reset --mixed <head>`), with
    `git status` showing exactly the pending changes.
- Backend tests for request parsing (unknown lines refused), classification by `have`/`shallow`,
  the probe moving on after a negative answer, head notifications (ordering with changes, delivery
  when only the head or only the base changes), and stream revocation when a connection is removed.
- Kit tests for the new hint encodings and for capturing shallow information.
