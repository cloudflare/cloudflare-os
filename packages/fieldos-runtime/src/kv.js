// Server side of workerd's `kvNamespace` binding.
//
// workerd ships the *client* half of this binding and no server: `kvNamespace @11` is a
// `ServiceDesignator`, documented as "a KV namespace, implemented by the named service. Requests
// to the namespace will be converted into HTTP requests targeting the given service name." This
// is that service.
//
// The protocol is a workerd internal with no public specification. It was recovered by execution
// and is documented, with traces, in `plans/workerd-probe/README.md`:
//
//   GET    /:key?urlencoded=true  -> 200 + raw body, or 404 for a miss
//   PUT    /:key?urlencoded=true  -> 200; the request body is the value
//   DELETE /:key?urlencoded=true  -> 200
//
// A miss MUST be 404 and not an empty 200 — that is what makes the binding resolve to `null`
// rather than an empty value. `get(key, "arrayBuffer")` needs nothing here; workerd decodes the
// same GET response client-side.
//
// State lives in Durable Object storage so it survives a restart, which requires the namespace to
// use `durableObjectStorage = (localDisk = ...)`. A plain worker would not do: its module-global
// state is per-isolate and evictable.

/** Serves one KV namespace. One instance per namespace, addressed as a singleton. */
export class KvStore {
  /** @param {DurableObjectState} state */
  constructor(state) {
    this.storage = state.storage;
  }

  /** @param {Request} req */
  async fetch(req) {
    // The key is the URL path. workerd percent-encodes it, so decode before use; the host is
    // always the literal `https://fake-host` and carries no meaning.
    const key = decodeURIComponent(new URL(req.url).pathname.slice(1));

    switch (req.method) {
      case "GET": {
        const value = await this.storage.get(key);
        if (value === undefined) return new Response("not found", { status: 404 });
        return new Response(/** @type {ArrayBuffer} */ (value));
      }
      case "PUT":
        await this.storage.put(key, await req.arrayBuffer());
        return new Response(null);
      case "DELETE":
        await this.storage.delete(key);
        return new Response(null);
      default:
        return new Response(`unsupported: ${req.method}`, { status: 405 });
    }
  }
}

export default {
  /**
   * @param {Request} req
   * @param {{STORE: DurableObjectNamespace<KvStore>}} env
   */
  fetch(req, env) {
    return env.STORE.get(env.STORE.idFromName("singleton")).fetch(req);
  },
};
