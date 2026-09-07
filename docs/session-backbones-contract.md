# Session backbone integration contract

## Integration blocker

At the start of this lane, the existing runtime state, server process, and browser proxy in
`packages/gatekeeper-sessions/src/sessions.ts` are OpenCode-specific. Pi and Prime
must not be attached to that server or exposed by expanding its route allowlist.
This lane owns only runtime helpers, image helpers, and disjoint tests/docs. It
does not change session authority, frontend, or shared APIs.

Concrete handoff: `src/runtime.ts:harnessRpcCommand()` generates verified stdio
launches. `pi-image/harness-rpc.mjs:createHarnessRpc()` consumes injected Node
binary streams with version-specific command allowlists, bounded framing,
request correlation, dialog replies, and owner-allocated HTML export paths.
The helper has no listener, authority, process creation, or automatic approval.
It is not yet packaged by Dockerfile.pi or consumed by the independently owned
Worker bridge; do not assume the fixture-tested helper protects another bridge's
separate parser. That integration and image packaging remain with the owner.

The session owner must supply a generation-fenced process/stdin/stdout transport
for the selected runtime, terminate it on session cleanup, and authorize each
operation using the existing owner/session capability. A helper is not a new
capability. Never accept caller-provided owner IDs, executable paths, environment
credentials, session file paths, or proxy destinations as authority.

## Verified release protocols

Inspected the actual published release archives on 2026-09-07, not an installed
container. The image lock pins Pi `@earendil-works/pi-coding-agent@0.84.2` and Prime
Agent `0.8.0`; `pi-image/node_modules` is absent in this checkout.

- Pi archive: <https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.2.tgz>
- Prime archive: <https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.8.0/prime-agent-0.8.0.tgz>
- Pi SHA-256: `95b899cd7b1a0c1f0174c7bf33ab427435e3553a7d1f4756661aa9c7f1a68ffa`
- Prime SHA-256: `f5b0093c7e0fddb73f94773d74383585456adfa84f12a4082d3098f23bb8fab6`

Both implement `--mode rpc`: LF-delimited UTF-8 JSON with `{id,type,...}` commands
and `{id,type:"response",command,success,data?,error?}` responses. Neither uses
JSON-RPC 2.0 for this mode. Keep stderr separate. Context7 was unavailable due to
quota; bundled official docs and executable code were used instead.

| Operation | Pi 0.84.2 | Prime 0.8.0 |
| --- | --- | --- |
| Input | `prompt`, `steer`, `follow_up` | Same |
| Status | `get_state` | Same, different fields |
| Current context | `get_messages` | Same; not full history |
| Full history | `get_entries`, `get_tree` | Not in stdio RPC |
| Stop turn | `abort` | `abort` |
| Dialogs | Extension UI requests/responses | Extension UI requests/responses |
| HTML artifact | `export_html` | `export_html` |
| Resume | `--session <path>` | `--resume <path>` |
| Completion | `agent_settled` | No equivalent stdio event verified |

Pi `message_update` is delta-only; `message_end.message` is authoritative. Its
`agent_end` is not final settlement. Prime retains cumulative updates. A prompt
acknowledgement only means accepted/queued, not completed. Prime `isStreaming`
alone does not establish all subagents have settled; `sessionActions` adds queue
and active-action information but is not a whole-tree completion guarantee.

`extension_ui_request` dialogs can be answered by `extension_ui_response`. This
is not universal tool approval enforcement. Do not auto-confirm dialogs or map
tool-start events to approval requests. Workshop MCP actions retain the existing
Workshop approval boundary. Pi's existing `--no-approve` concerns project
resource trust, not tool-action authorization; do not escalate or reuse it as an
approval mechanism.

HTML export writes a container file and requires a persisted session. The owner
must allocate and constrain artifact destinations, validate reads with its file
capability, and serve HTML as an untrusted download, not trusted application HTML.
Prime full history requires preserving its JSONL and associated session-artifacts
directory; stdio `get_messages` cannot replace that. No notebook export was
verified. Prime kernel snapshots must not be deserialized by the host.

Prime also has ACP and a daemon protocol, but those are separate transports.
Its daemon implementation is protocol 7/schema 22 despite stale v4 documentation.
The adapter must not infer daemon or ACP commands from stdio command names.

## Remaining owner decisions

- Persist the runtime's session identity/path with the sandbox generation and
  distinguish a process reconnect from creation of a new conversation.
- Provide bounded framing, backpressure, cancellation, timeouts, and process-death
  notification. A command timeout does not prove an accepted action did not run.
- Expose distinct current-context/full-history/status/dialog/artifact operations;
  advertise unsupported operations instead of fabricating OpenCode responses.
- Until the machine transport is connected, label Pi/Prime surfaces terminal-only
  in the application. Prime is not terminal-only upstream; this is an application
  integration limit, not lack of a verified protocol.
- Preserve explicit saved model selections. Generated OpenCode `model` and
  `small_model`, and Pi/Prime CLI defaults, already use Astra. Local user config
  and saved settings are outside this lane. Subagents should inherit rather than
  receive an unconditional model override.

The pinned Valhalla OpenCode generator previously embedded Spark in optional
external Baro/AutoAgent delegation instructions. Its supported plugin options
now default those external processes to Astra; they cannot implicitly inherit
an in-process model. No command-level model pin is added and saved settings are
untouched. Prime's `_resolveRlmSubagentModel` inherits the active parent model
when no per-spawn override is supplied. Pi core has no built-in subagents; its
example subagent extension inherits unless agent frontmatter selects a model,
but that example is not loaded by our reviewed extension list. No new subagent
extension or model-policy enforcement is added here.

Release evidence: Pi `docs/rpc.md`, `dist/modes/rpc/rpc-mode.js`,
`dist/modes/json-event.js`, `dist/cli/args.js`, and `docs/security.md`; Prime
`dist/modes/rpc/rpc-mode.js`, `dist/modes/rpc/rpc-extension-ui-context.js`,
`dist/cli/args.js`, and the matching RPC implementation in
`dist/bundle/chunk-ELSMXMAM.js`. Static protocol verification is not an end-to-end
model, MCP, kernel, or deployed sandbox test.

## Validation evidence

- `pnpm --filter @gadgets/gatekeeper-sessions test`: 36 files, 483 tests passed
  after the dialog timeout fix, including concurrently authored owner tests.
- `pnpm --filter @gadgets/gatekeeper-sessions types:check`: passed (package and
  canary TypeScript configurations).
- Targeted Vite+ lint for the owned runtime/helper/generator and new tests: passed.
- Independent review identified the valid zero-timeout dialog case; fixed and
  replay-tested for both releases, then independently re-reviewed.

These results exercise local fixtures/mocks, not actual harness inference. No
production access, provisioning, deployed canary, image build, real prompt,
approval escalation, commit, or deployment was performed in this lane. The image
dependency archive inspection verifies source protocols but not a running image.
