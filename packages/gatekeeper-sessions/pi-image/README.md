# Coding-session image validation

`test-image-network-none.sh <image-ref>` performs two local, bounded checks against a built amd64
image:

1. It boots the image's normal `/container-server/sandbox` entrypoint read-only with no network or
   Linux capabilities, then requires the container server startup event and a local TCP response.
2. It runs the host-controlled `smoke-image.sh` read-only with no network, bounded CPU, memory, PIDs,
   and time. This verifies the complete pinned tool contract, both offline pnpm versions, login-shell
   resolution, the Prime kernel, the offline browser editor, and the local real-binary smoke matrix.

The real-binary matrix creates disposable files under the smoke temp directory and starts a loopback-only
fake model/MCP endpoint inside the network-none container. It does not talk to the public internet. The
current deterministic coverage is:

- **OpenCode**: runs the shipped `opencode run` binary against a local OpenAI-compatible fake provider,
  observes the real tool catalog the CLI sends to the model, drives a read tool call, an edit/write tool
  call, and a shell/command tool call, verifies the fixture file changed from `alpha` to `beta`, verifies
  the command marker, and requires the OpenCode MCP client to call `tools/list` on the fake Workshop MCP
  endpoint.
- **Pi**: runs the shipped `pi` binary help path, verifies the Odie Pi runtime extension can be loaded by
  the same Jiti loader baked into the image, verifies the `pi-mcp-adapter` import path, and runs a direct
  MCP lifecycle probe against the fake Workshop endpoint. The probe does not exercise Pi's MCP client.
  The pinned Pi 0.84.2 does expose `--mode rpc` (stdio JSONL). This smoke has not yet
  been extended to drive that protocol and does not prove a prompt-driven Pi tool loop.
- **Prime Agent**: runs the shipped `prime-agent` binary version check and the shipped Prime kernel's
  IPython entrypoint. The kernel-environment smoke imports `rlm.mcp`, reads and edits a fixture file,
  runs a local shell assertion/marker command, and makes a direct HTTP `tools/list` request to the fake
  Workshop MCP endpoint. This does not exercise Prime Agent's own tool bridge or a prompt-driven loop.

## Internal machine adapter

`harness-rpc.mjs` implements the verified Pi 0.84.2 and Prime 0.8.0 stdio RPC
subset. It is a Node stream helper, not an HTTP endpoint, process launcher, or
owner capability. It is not yet copied into the image or imported by the Worker
bridge. Its eventual consumer must either package it or materialize it through
the existing owner-authorized sandbox path. Do not start a second agent against
the same persisted conversation to provide an additional UI.

The owner injects binary `readable`/`writable` streams and a version selector
(`pi@0.84.2` or `prime@0.8.0`). It must check the executable's package version,
keep stderr separate, deliver process death to `close()`, and terminate the peer
on `onClose`. `request(type, fields)` returns the unmodified native response;
events arrive through `onEvent`. This intentionally does not manufacture OpenCode
messages or normalize different harness completion semantics.

- Shared commands: `prompt`, `steer`, `follow_up`, `abort`, `get_state`,
  `get_messages`, `get_session_stats`, `export_html`.
- Pi-only commands: `get_entries` (optional `since`) and `get_tree`. Prime rejects
  these locally without writing a command. `get_messages` is current context,
  not an archival transcript.
- Export requires `exportPath` at transport construction; individual requests
  cannot change it. The owner still validates filesystem containment, symlinks,
  returned paths, and artifact download authorization. HTML is untrusted content.
- Only observed, unexpired extension dialogs can receive explicit
  `respondToDialog(id, {confirmed})`, `{value}`, or `{cancelled: true}`. Select
  values must match the advertised options. No automatic tool approval is added.
- Default bounds: 1 MiB per frame and outstanding write bytes, 32 outstanding
  requests/dialogs, 30-second request timeout/local dialog eligibility. Large
  histories can exceed the frame cap; callers must report the error rather than
  present a partial transcript as complete. Pi cursors help subsequent reads,
  but do not page an initial oversized history.
- Frames are UTF-8 JSONL; fragmented multibyte characters, CRLF, and Unicode line
  separator characters inside JSON strings are handled. Malformed UTF-8/JSON,
  invalid response correlation, EOF, and request timeout close the transport.
  Backpressure rejects a new request rather than queueing without a bound.
- Closing detaches listeners and rejects pending requests; it does not send
  implicit dialog decisions or kill the process. An accepted operation may still
  have run. The owner controls process cleanup and any restart/recovery policy.

`src/runtime.ts:harnessRpcCommand()` removes TUI presentation flags and selects
the actual RPC mode while retaining reviewed resources and existing trust flags.
New conversations default to Astra. `sessionFile` denotes an owner-verified
existing conversation and omits CLI model/provider/cycle overrides unless a
model selection is supplied explicitly; Pi uses `--session`, Prime `--resume`.
For a new Pi conversation at an allocated path, explicitly supply the desired
model as well. Paths are argv elements, never shell interpolation; syntactic
validation does not grant filesystem authority.

Fixture tests live in `__tests__/harness-rpc.test.ts` and
`__tests__/harness-command.test.ts`. They do not execute a real model or kernel.
See [the owner integration contract](../../../docs/session-backbones-contract.md)
for source provenance, completion differences, and remaining integration work.

The local boot check does not exercise the Worker/DO path in `@cloudflare/sandbox`. That SDK obtains
process, interpreter, and terminal handles through a deployed Cloudflare Container binding; it has no
supported direct-local client for `/container-server/sandbox`.

The publish workflow may mirror a successfully checked GHCR image to the Cloudflare registry only as
an **unpromoted candidate**. Before any production Wrangler configuration PR uses that digest, a
separate canary Worker and Durable Object bound to the candidate must prove all of the following:

- `exec()` reports the exact Node version and can collect process output;
- JavaScript and TypeScript interpreter execution succeeds;
- a terminal can start, accept input, and terminate;
- the browser editor starts and becomes ready;
- processes, terminals, editor state, and the sandbox generation clean up successfully.

A Cloudflare candidate digest artifact is a transport receipt, not evidence of this native canary and
not authorization to deploy it. Keep the previous production digest until the canary passes.

Commit tags are intentionally fail-closed and are never reused. If a run pushes its exact commit tag
to GHCR and then fails, do not rerun it blindly. A package administrator must first verify that the
failed run never promoted the recorded digest and that no checked-in Wrangler configuration refers
to it, then delete that exact unpromoted package version through the GHCR package administration
UI or API. Only then may the same immutable commit be rerun. Never delete a prior production digest
or a version referenced by another tag.
