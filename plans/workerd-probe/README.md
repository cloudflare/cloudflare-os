# workerd KV/R2 binding protocol — probe artifacts

Working reference implementations of the server side of workerd's `kvNamespace` and `r2Bucket`
bindings, plus the wire protocol traces they were derived from.

**Why this exists.** `kvNamespace @11` and `r2Bucket @12` are `ServiceDesignator`s in
`workerd.capnp`: workerd ships the *client* half of each binding and no server. Self-hosting
therefore requires implementing the protocol, which is a workerd internal with no public
specification. It was recovered by execution — binding an echo worker and reading what arrived.

Not wired into the build. These are the proof and the reference; the shipped services come with
the Phase 1 work (OZL-215).

## Files

| | |
|---|---|
| `kv.js` | Minimal KV server. **34 lines.** |
| `r2.js` | Minimal R2 server, narrow subset. **87 lines.** |
| `echo.js` | Logs inbound requests verbatim — how the protocol was discovered. Re-run after any workerd upgrade. |
| `config2.capnp` | Wires both behind real bindings, with a test worker. |
| `test2.js` | The 16 round-trip assertions. |

Reproduce (workerd **1.20260801.1**, from the pnpm store):

```sh
workerd serve config2.capnp --experimental &
curl http://127.0.0.1:8812/          # expect 16 PASS lines
```

Verified: 16/16 round-trips, and state surviving a `kill` + fresh-process restart.

## KV protocol

Host is always the literal `https://fake-host`; the key is the URL path.

| Call | Request | Response |
|---|---|---|
| `get(k)` | `GET /k?urlencoded=true` | `200` + raw body |
| miss | — | **`404`** → binding yields `null` (does not throw) |
| `put(k,v)` | `PUT /k?urlencoded=true`, body is the value | `200`, empty |
| `delete(k)` | `DELETE /k?urlencoded=true` | `200`, empty |

`get(k, "arrayBuffer")` needs **no** server change — same GET, decoded client-side.

A `cf-kv-flprod-405` header echoes the URL and is ignorable (the name looks version-coupled).
Non-2xx on put/delete throws, e.g. `KV PUT failed: 404 Not Found`.

## R2 protocol

The operation is **not** the HTTP verb — it rides in a JSON envelope. `put` and `delete` both
arrive as `PUT`.

```
GET  https://fake-host
     cf-r2-request: {"version":1,"method":"get","object":"obj1"}

PUT  https://fake-host
     cf-r2-metadata-size: 100
     body = [JSON metadata][raw value]     # split at metadata-size
```

Responses mirror that framing — `[JSON metadata][raw value]` with `cf-r2-metadata-size` set to the
JSON's byte length. Metadata shape:

```json
{"name":KEY,"version":HEX,"size":N,"etag":HEX,"uploaded":EPOCH_MS,
 "httpFields":{"contentType":"..."},"customFields":[],"checksums":{}}
```

**The one trap.** A miss must return `404` **and** a `cf-r2-error` header:

```
cf-r2-error: {"version":1,"v4code":10007,"message":"The specified key does not exist."}
```

Omit it and `.get()` throws `Error: get: Unspecified error (0)` instead of resolving to `null`,
with workerd logging *"R2 error response does not contain the CF-R2-Error header."* Verified both
ways. This is the single load-bearing R2 detail and the one most likely to cost a debugging day,
since the failure surfaces far from its cause.

## Persistence

Both are **singleton Durable Objects**, not plain workers — a worker's module-global `Map` is
per-isolate and evictable. The DO gives one authoritative instance plus durable storage:

```capnp
durableObjectNamespaces = [ (className = "KvStore", uniqueKey = "kv-store-key") ],
durableObjectStorage = (localDisk = "dodisk"),
bindings = [ (name = "STORE", durableObjectNamespace = "KvStore") ],
```

with `(name = "dodisk", disk = (path = "dodata", writable = true))` as a service. workerd writes
real SQLite files under `dodata/<uniqueKey>/`. A bare `disk` service is **not** sufficient — no
key/value semantics, no atomicity.

## Limits, deliberately

Implemented: `get` / `put` / `delete`, `get(k,"arrayBuffer")`, and R2's
`httpMetadata.contentType`. That is the app's entire measured surface — re-verified against
`packages/*/src`: 12 `put`, 11 `delete`, 9 `get`, and **no** `list`/`head` anywhere.

Not implemented, and they return an explicit `400 unsupported`: `list`, `head`, multipart, ranged
reads, `onlyIf`, `customMetadata`. Failing loudly beats failing subtly if the audit ever misses a
call site.

**Object-size ceiling:** an R2 value is one DO-storage entry, so it is capped at DO's per-value
limit (~2 MB; 300 KB is verified). Chunking across keys is ~20 more lines if blobs get bigger.

**Version-pinned.** These framings are workerd internals, not a public contract, and are valid for
**1.20260801.1** exactly. Re-run `echo.js` after any workerd upgrade and diff — it takes about two
minutes and is the cheapest guard available.
