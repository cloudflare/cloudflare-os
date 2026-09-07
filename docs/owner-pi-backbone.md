# Owner Pi workbench integration

## Frontend API (implemented)

`AuthenticatedApi` exposes:

```ts
connectCodingSessionPi(sessionId: string): Promise<CodingSessionPiConnection>
callCodingSessionPi(sessionId: string, connectionId: string,
  command: CodingSessionPiCommand): Promise<CodingSessionPiResult>
```

Contracts are in `packages/workshop-shared/src/pi-backbone.ts`, re-exported by
`@gadgets/workshop-shared/api`. Kernel delegation is in `server.ts` and `user.ts`;
the service/registry methods are `connectPi` and `callPi`.

Connect returns either `{mode:"rpc", connectionId, expiresAt, version:1}` or
`{mode:"terminal", reason}`. A handle lasts five minutes and belongs to the current
owner registry, sandbox, generation and primary terminal. It is **not** a proxy URL
or standalone authority: every call goes through authenticated kernel checks.
Reconnect to refresh an expired handle, but never automatically repeat an input,
abort, dialog response or export whose outcome is unknown. No RPC stub is returned
or retained by this API, so there is no new frontend stub-disposal obligation.

`callCodingSessionPi` returns `{json:string}`. Parse this bounded JSON as untrusted
data and render text safely. Pi commands return the upstream response's `data`,
not a fabricated OpenCode response or a completion signal:

| Command | Result / semantics |
| --- | --- |
| `{type:"get_state"}` | Pi state, including streaming/session information |
| `{type:"get_messages"}` | Current model context, **not** full history |
| `{type:"get_entries"}` | Full persisted Pi entries, subject to the response byte cap |
| `{type:"get_tree"}` | Pi branch tree |
| `{type:"prompt",message}` | Input accepted/queued; not turn completion |
| `{type:"steer",message}` / `{type:"follow_up",message}` | Explicit streaming input modes |
| `{type:"abort"}` | Cancel current turn; does not destroy session or imply settlement |
| `{type:"events",after:0}` | `{cursor,truncated,events:[{cursor,data}],dialogs,dead}` |
| `{type:"extension_ui_response",id,confirmed:false}` | Explicit confirm dialog reply |
| `{type:"extension_ui_response",id,value:"..."}` | Explicit input/select/editor reply |
| `{type:"extension_ui_response",id,cancelled:true}` | Dismiss a pending extension dialog |
| `{type:"export_html"}` | `{filename:"pi-session.html",mediaType:"text/html",base64}` |

Poll events using the last returned cursor. Events preserve their Pi shapes;
`message_update` is a delta, `message_end.message` is authoritative, and only
`agent_settled` is the verified Pi settlement event. `agent_end` is not settlement.
If `truncated` is true, refresh state/history and display the event gap. `dead`
means explicit restart is necessary; connecting or polling never resurrects Pi.
Pending dialogs are bounded and expire after at most 30 seconds. Expiry sends
`cancelled:true` to Pi before removing eligibility, including dialogs without a
native timeout and editor dialogs, so the upstream waiter is released. Explicit
answers clear the expiry timer. If cancellation cannot be sent, the bridge fails
closed rather than leaving Pi silently waiting. Expired/stale replies fail closed.
The UI must distinguish these dialogs from Workshop approvals.

## Approvals and artifacts

The bridge launches the existing configured Pi command with the same provider,
extension and MCP adapter; only TUI arguments are replaced by `--mode rpc` and a
fixed persisted session path. The existing Workshop MCP policy still records
observations and queues writes. Use existing `listCodingSessionActivity(sessionId)`,
`approveCodingSessionAction(activityId)` and rejection APIs to display/resolve
Workshop actions. Never treat a tool-start event or a Pi confirm dialog as a
Workshop action approval. No new approval bypass or policy scope is introduced.

HTML export allocates a private temporary directory in the sandbox, instructs Pi
to export to that owner-selected path, verifies the real path and no-follow file
handle, bounds the read to 1 MiB, and removes the directory. The caller cannot
select an artifact path. Decode base64 into a Blob and download it using the fixed
filename; **do not iframe, inject, or serve it as trusted same-origin HTML**.
There is no notebook export or host deserialization of runtime snapshots.

## Lifecycle and security

- New clients explicitly request `piWorkbench: true` when creating Pi sessions.
  Omitted requests from older web/native clients retain the terminal interface.
  The selected interface is persisted across restarts; existing terminal sessions
  are not silently upgraded. Structured Pi generations materialize the Node bridge from the Worker and run it as
  the primary terminal's supervisor. Pi itself has pipe stdin/stdout (JSONL),
  separate discarded stderr, and no PTY input. Shell access remains separate.
- Node is already installed by `Dockerfile.pi`. No image change is required for
  the bridge. The bridge rejects installed Pi versions other than 0.84.2.
- Pi's persisted identity is `/workspace/.odie-pi/owner-session.jsonl` in the exact
  generation sandbox. A retained exclusive lock prevents restarting a crashed
  bridge against that history. Explicit session restart destroys that sandbox;
  history is not claimed to survive an existing destructive session restart.
- Startup replay reuses an existing matching terminal. A legacy running TUI
  remains a terminal fallback; creating a new session in an updated client opts into the workbench. No attach path
  creates a terminal, process or conversation. An exited matching process fails
  rather than being silently replaced.
- Existing stop/archive/restart cleanup destroys the whole sandbox and therefore
  the supervisor, Pi and descendants. Bridge shutdown also signals the child and
  escalates after one second. Stale handles fail before and after asynchronous
  policy and transport operations. An in-flight write that wins a race with stop
  may have run; errors do not imply rollback.
- The kernel rechecks required connections, membership and every repository on
  every call. The registry reconfigures the existing policy and fences against
  generation/terminal changes. No caller-supplied owner, executable, session path,
  credential, export destination or HTTP destination is accepted.
- Transport is a fixed internal port, not an expanded OpenCode proxy route. Input
  is limited to 32 KiB UTF-8, JSON responses/frames to 2 MiB, in-flight commands to
  16, retained events to 256 / 1 MiB, and pending dialogs to 64 / 8 KiB each. Worker
  requests time out after 30 seconds; child requests after 25 seconds. A timeout
  means **outcome unknown**, especially for writes. The HTTP/stdin request budget
  allows sixfold JSON escaping of the full 32 KiB input plus envelope overhead.
  Oversized stdout frames are discarded through the next LF using a fixed 2 MiB
  buffer, without terminating Pi. Since correlation cannot be recovered from the
  discarded frame, all outstanding requests fail explicitly (write outcomes are
  unknown); new commands are refused while draining, before being sent. A
  `bridge_frame_omitted` event reports the gap. Draining has an absolute five-second
  deadline from first overflow; incoming bytes do not extend it. LF clears the
  deadline, and state/abort and other commands work normally afterward. Deadline
  expiry or stdout EOF/close/error marks the bridge dead, rejects pending work,
  and kills the child instead of leaving a live but unusable transport. This also
  covers EOF inside an ordinary incomplete frame. Malformed bounded JSON still fails closed. Larger
  history never masquerades as current context or silently kills the agent.
- Prime remains terminal-only in this application: its stdio protocol exists,
  but its full-history storage and whole-tree settlement need a separate owner
  adapter. No claim is made that upstream Prime lacks RPC.

## Verification and remaining release work

`pi-backbone.test.ts` runs a real local Node supervisor with a mocked JSONL child,
never Pi/model/production traffic. `pi-backbone-lifecycle.test.ts` drives the real
policy startup checkpoint and registry methods with mocked sandbox capabilities.
The published-protocol verification remains in `session-backbones-contract.md`.
Frontend integration is implemented in `PiWorkbench.tsx`, with focused component
and route tests using mocked owner APIs. Control polling commits events, dialogs
and state independently of bounded full-history/tree reads; a large-read failure
is explicitly unavailable, never complete, and does not disable healthy cancel or
dialog controls. Before local input, observed `agent_settled` status survives
unrelated batches, resets on `agent_start`, and becomes unknown on event gaps
(including `bridge_frame_omitted`). After any local input/steer/follow-up attempt,
settlement remains unknown for the rest of the mounted session, including read
reconnects. There is no authoritative input-to-event correlation: even an unread
`agent_start` followed by `agent_settled` can belong to a prior turn. The UI does
not infer correlation from polling order or acknowledgement. Actual streaming
state and raw historical events remain available; streaming state never displays
verified settlement. `agent_end` is not settlement. Writes are never automatically
retried. The route retains separate Workshop approvals and explicit terminal-mode
fallback; HTML export is download-only.

These tests are not a live model/MCP/image/deployed end-to-end test. Independent
security review and any authorized release/canary work remain separate.
