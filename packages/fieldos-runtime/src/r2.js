// Server side of workerd's `r2Bucket` binding.
//
// Like `kvNamespace`, `r2Bucket @12` is a `ServiceDesignator`: workerd converts binding calls into
// HTTP requests aimed at the named service, and ships no server. This is that service.
//
// Note this is NOT the S3 API. "R2 is S3-compatible" refers to R2's *S3 endpoint*; the *binding*
// speaks a private protocol, which is why MinIO cannot sit behind this binding. The protocol was
// recovered by execution and is documented with traces in `plans/workerd-probe/README.md`:
//
//   get    -> GET,  operation in the `cf-r2-request` header
//   put    -> PUT,  body = [JSON metadata][raw value], split at `cf-r2-metadata-size`
//   delete -> PUT,  same framing as put, with an empty value
//
// The operation is carried in a JSON envelope rather than the HTTP verb, so put and delete both
// arrive as PUT. Responses mirror the framing.

/**
 * SQLite's row limit, measured against workerd 1.20260801.1 by bisection: a put of 2,199,730 bytes
 * fails with `SQLITE_TOOBIG` where 2,199,729 succeeds. It is SQLite's ceiling rather than
 * workerd's, so a runtime built against a differently-configured SQLite could move it.
 *
 * We check it here so a new call site fails with a legible message naming the limit, instead of an
 * opaque `string or blob too big` raised from deep inside storage.
 */
const MAX_VALUE_BYTES = 2_199_729;

const R2_METADATA_SIZE = "cf-r2-metadata-size";

/**
 * The object as the binding expects to receive it.
 *
 * `size` is load-bearing: `server.ts` feeds `r2Object.size` to the blueprint download as the
 * archive's declared content length, so a value disagreeing with the actual bytes would produce a
 * corrupt download with no error. Deriving it from `bytes.byteLength` keeps it correct by
 * construction — do not refactor it into a stored field.
 *
 * `customFields`/`checksums` stay empty because nothing reads them; the binding surfaces them as
 * `customMetadata: {}` and `checksums.md5: undefined`, which is what the app already tolerates.
 *
 * @param {string} key
 * @param {{bytes: Uint8Array, httpFields: object, version: string, etag: string, uploaded: number}} o
 */
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

/**
 * @param {string} key
 * @param {{bytes: Uint8Array, httpFields: object, version: string, etag: string, uploaded: number}} o
 * @param {boolean} withBody
 */
function encodeObject(key, o, withBody) {
  const json = new TextEncoder().encode(JSON.stringify(objectMeta(key, o)));
  const body = withBody ? o.bytes : new Uint8Array(0);
  const out = new Uint8Array(json.byteLength + body.byteLength);
  out.set(json, 0);
  out.set(body, json.byteLength);
  return new Response(out, {
    headers: {
      [R2_METADATA_SIZE]: String(json.byteLength),
      "content-type": "application/json",
    },
  });
}

/**
 * A miss must carry `cf-r2-error` as well as the 404. Without the header the binding throws
 * `get: Unspecified error (0)` instead of resolving to `null`, and workerd logs "R2 error response
 * does not contain the CF-R2-Error header". Verified both ways; this is the single most
 * consequential detail in the protocol, because the failure surfaces far from its cause.
 */
function notFound() {
  return new Response(null, {
    status: 404,
    headers: {
      "cf-r2-error": JSON.stringify({
        version: 1,
        v4code: 10007,
        message: "The specified key does not exist.",
      }),
    },
  });
}

/** Serves one R2 bucket. One instance per bucket, addressed as a singleton. */
export class R2Store {
  /** @param {DurableObjectState} state */
  constructor(state) {
    this.storage = state.storage;
  }

  /** @param {Request} req */
  async fetch(req) {
    /** @type {{method: string, object: string, httpFields?: object}} */
    let meta;
    let value = new Uint8Array(0);

    const header = req.headers.get("cf-r2-request");
    if (header !== null) {
      meta = JSON.parse(header);
    } else {
      const size = Number.parseInt(req.headers.get(R2_METADATA_SIZE) ?? "NaN", 10);
      if (Number.isNaN(size)) return new Response("bad metadata", { status: 400 });
      const all = new Uint8Array(await req.arrayBuffer());
      meta = JSON.parse(new TextDecoder().decode(all.subarray(0, size)));
      value = all.subarray(size);
    }

    // ponytail: the whole object is one storage row, which is what makes metadata and body
    // atomic — a reader can never see one without the other. Chunking for capacity would trade
    // that verified property away; nothing the app stores comes close to the limit.
    const storageKey = `o:${meta.object}`;

    switch (meta.method) {
      case "get": {
        const object = await this.storage.get(storageKey);
        if (object === undefined) return notFound();
        return encodeObject(meta.object, /** @type {any} */ (object), true);
      }
      case "put": {
        if (value.byteLength > MAX_VALUE_BYTES) {
          return new Response(
            `value of ${value.byteLength} bytes exceeds the ${MAX_VALUE_BYTES}-byte storage limit`,
            { status: 400 },
          );
        }
        const object = {
          bytes: value,
          httpFields: meta.httpFields ?? {},
          version: crypto.randomUUID().replaceAll("-", ""),
          // Nothing reads the etag, so a random value is honest about being an opaque token.
          // A content hash would force buffering to hash for no consumer.
          etag: crypto.randomUUID().replaceAll("-", ""),
          uploaded: Date.now(),
        };
        await this.storage.put(storageKey, object);
        return encodeObject(meta.object, object, false);
      }
      case "delete":
        await this.storage.delete(storageKey);
        return new Response(null);
      default:
        // Loud rather than subtle: list/head/multipart/ranged/onlyIf have no call sites today, so
        // an unsupported method means an audit missed one rather than a user doing something odd.
        return new Response(`unsupported: ${meta.method}`, { status: 400 });
    }
  }
}

export default {
  /**
   * @param {Request} req
   * @param {{STORE: DurableObjectNamespace<R2Store>}} env
   */
  fetch(req, env) {
    return env.STORE.get(env.STORE.idFromName("singleton")).fetch(req);
  },
};
