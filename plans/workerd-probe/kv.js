// Minimal KV server for workerd `kvNamespace` bindings.
// Protocol (verified by execution against workerd 1.20260801.1):
//   GET    /:key?urlencoded=true -> 200 + body, or 404 for a miss (binding yields null)
//   PUT    /:key?urlencoded=true -> 200, request body is the value
//   DELETE /:key?urlencoded=true -> 200
// State lives in Durable Object storage, so it survives restart when the
// namespace uses `durableObjectStorage = (localDisk = ...)`.
class KvStore {
  constructor(state) { this.storage = state.storage; }
  async fetch(req) {
    const key = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (req.method === "GET") {
      const v = await this.storage.get(key);
      return v === undefined ? new Response("not found", { status: 404 }) : new Response(v);
    }
    if (req.method === "PUT") {
      await this.storage.put(key, await req.arrayBuffer());
      return new Response(null);
    }
    if (req.method === "DELETE") {
      await this.storage.delete(key);
      return new Response(null);
    }
    return new Response("method not allowed", { status: 405 });
  }
}

export { KvStore };

export default {
  fetch(req, env) {
    return env.STORE.get(env.STORE.idFromName("singleton")).fetch(req);
  }
};
