// Minimal R2 server for workerd `r2Bucket` bindings.
// Protocol (verified against workerd 1.20260801.1):
//   GET  : cf-r2-request header = {"version":1,"method":"get","object":KEY}
//   PUT  : body = [JSON metadata][value]; cf-r2-metadata-size = JSON byte length
//          metadata = {"version":1,"method":"put","object":KEY,"httpFields":{"contentType":...}}
//   DELETE: sent as a PUT with method:"delete" in the metadata prefix, empty value.
// Responses: body = [JSON object-metadata][value], cf-r2-metadata-size = JSON length.
//   A miss is 404 + cf-r2-error {"version":1,"v4code":10007,"message":...}

const R2_METADATA_SIZE = "cf-r2-metadata-size";

function objectMeta(key, o) {
  return {
    name: key,
    version: o.version,
    size: o.bytes.byteLength,
    etag: o.etag,
    uploaded: o.uploaded,
    httpFields: o.httpFields,
    customFields: [],
    checksums: {},
  };
}

function encodeObject(key, o, withBody) {
  const json = new TextEncoder().encode(JSON.stringify(objectMeta(key, o)));
  const body = withBody ? o.bytes : new Uint8Array(0);
  const out = new Uint8Array(json.byteLength + body.byteLength);
  out.set(json, 0);
  out.set(body, json.byteLength);
  return new Response(out, {
    headers: { [R2_METADATA_SIZE]: String(json.byteLength), "content-type": "application/json" },
  });
}

function notFound() {
  return new Response(null, {
    status: 404,
    headers: { "cf-r2-error": JSON.stringify({ version: 1, v4code: 10007, message: "The specified key does not exist." }) },
  });
}

class R2Store {
  constructor(state) { this.storage = state.storage; }
  async fetch(req) {
    let meta, value = new Uint8Array(0);
    const hdr = req.headers.get("cf-r2-request");
    if (hdr !== null) {
      meta = JSON.parse(hdr);
    } else {
      const size = parseInt(req.headers.get(R2_METADATA_SIZE) ?? "NaN");
      if (Number.isNaN(size)) return new Response("bad metadata", { status: 400 });
      const all = new Uint8Array(await req.arrayBuffer());
      meta = JSON.parse(new TextDecoder().decode(all.subarray(0, size)));
      value = all.subarray(size);
    }

    if (meta.method === "get") {
      const o = await this.storage.get("o:" + meta.object);
      return o === undefined ? notFound() : encodeObject(meta.object, o, true);
    }
    if (meta.method === "put") {
      const o = {
        bytes: value,
        httpFields: meta.httpFields ?? {},
        version: crypto.randomUUID().replace(/-/g, ""),
        etag: crypto.randomUUID().replace(/-/g, ""),
        uploaded: Date.now(),
      };
      await this.storage.put("o:" + meta.object, o);
      return encodeObject(meta.object, o, false);
    }
    if (meta.method === "delete") {
      await this.storage.delete("o:" + meta.object);
      return new Response(null);
    }
    return new Response("unsupported: " + meta.method, { status: 400 });
  }
}

export { R2Store };

export default {
  fetch(req, env) {
    return env.STORE.get(env.STORE.idFromName("singleton")).fetch(req);
  }
};
