// Test worker: exercises the three services through REAL workerd bindings and reports results as
// JSON. Running the assertions inside workerd is the point — it is the only way to prove the
// binding client accepts what our services return, which is what a mocked test could never show.

/** @param {string} name @param {unknown} got @param {unknown} want */
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return { name, ok, got: ok ? undefined : got, want: ok ? undefined : want };
}

export default {
  /**
   * @param {Request} req
   * @param {{KV: KVNamespace, R2: R2Bucket, ASSETS: Fetcher}} env
   */
  async fetch(req, env) {
    const mode = new URL(req.url).pathname;
    const results = [];

    // A second process reads these back after a restart, so they must already exist.
    if (mode === "/seed") {
      await env.KV.put("persist-key", "kv-before-restart");
      await env.R2.put("persist-obj", new Uint8Array([9, 8, 7, 6]), {
        httpMetadata: { contentType: "image/png" },
      });
      return Response.json({ seeded: true });
    }

    if (mode === "/verify-restart") {
      results.push(check("kv survived restart", await env.KV.get("persist-key"), "kv-before-restart"));
      const obj = await env.R2.get("persist-obj");
      results.push(check("r2 survived restart", obj ? [...new Uint8Array(await obj.arrayBuffer())] : null, [9, 8, 7, 6]));
      results.push(check("r2 contentType survived", obj?.httpMetadata?.contentType, "image/png"));
      return Response.json(results);
    }

    // --- KV ---
    await env.KV.put("k1", "hello-value");
    results.push(check("kv put/get text", await env.KV.get("k1"), "hello-value"));

    await env.KV.put("k-bin", new Uint8Array([1, 2, 3, 255]));
    const bin = await env.KV.get("k-bin", "arrayBuffer");
    results.push(check("kv arrayBuffer is byte-exact", bin ? [...new Uint8Array(bin)] : null, [1, 2, 3, 255]));

    results.push(check("kv miss is null", await env.KV.get("no-such-key"), null));

    await env.KV.delete("k1");
    results.push(check("kv delete", await env.KV.get("k1"), null));

    // Invalid UTF-8: proves values round-trip as bytes rather than being coerced through text,
    // which is what the avatar path depends on. Read as text these would become U+FFFD.
    const raw = new Uint8Array([0, 255, 254, 128, 195, 40]);
    await env.KV.put("k-raw", raw);
    const rawBack = await env.KV.get("k-raw", "arrayBuffer");
    results.push(check("kv preserves invalid utf-8", rawBack ? [...new Uint8Array(rawBack)] : null, [...raw]));

    // --- R2 ---
    const put = await env.R2.put("o1", new Uint8Array([1, 2, 3, 4, 5]), {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    results.push(check("r2 put returns object", { key: put?.key, size: put?.size }, { key: "o1", size: 5 }));

    const got = await env.R2.get("o1");
    results.push(check("r2 body bytes", got ? [...new Uint8Array(await got.arrayBuffer())] : null, [1, 2, 3, 4, 5]));
    results.push(check("r2 size", got?.size, 5));
    results.push(check("r2 contentType", got?.httpMetadata?.contentType, "application/octet-stream"));

    // The load-bearing one: without the cf-r2-error header this THROWS instead of returning null.
    results.push(check("r2 miss is null", await env.R2.get("no-such-object"), null));

    await env.R2.delete("o1");
    results.push(check("r2 delete", await env.R2.get("o1"), null));

    // The import path streams rather than buffers, so prove a stream body works.
    await env.R2.put("o-stream", new Response("stream-body").body, {
      httpMetadata: { contentType: "text/plain" },
    });
    const streamed = await env.R2.get("o-stream");
    results.push(check("r2 accepts a stream", await streamed?.text(), "stream-body"));

    // 300KB: comfortably above any real asset (blueprints ship at 25-50KB) and well under the
    // ~2.1MB SQLite row ceiling.
    const big = new Uint8Array(300_000).fill(7);
    await env.R2.put("o-big", big);
    const bigBack = await env.R2.get("o-big");
    results.push(check("r2 300KB roundtrip", bigBack?.size, 300_000));

    // --- assets ---
    const index = await env.ASSETS.fetch(new URL("http://a/"));
    results.push(check("assets / serves html", index.headers.get("content-type"), "text/html; charset=utf-8"));

    const spa = await env.ASSETS.fetch(new URL("http://a/deep/client/route"));
    results.push(check("assets SPA fallback is 200", spa.status, 200));
    results.push(check("assets SPA fallback serves html", spa.headers.get("content-type"), "text/html; charset=utf-8"));

    const asset = await env.ASSETS.fetch(new URL("http://a/assets/app.js"));
    results.push(check("assets js content-type", asset.headers.get("content-type"), "text/javascript; charset=utf-8"));
    results.push(check("assets hashed files immutable", asset.headers.get("cache-control"), "public, max-age=31536000, immutable"));

    const shell = await env.ASSETS.fetch(new URL("http://a/index.html"));
    results.push(check("assets index is not cached", shell.headers.get("cache-control"), "no-cache"));

    // A directory listing would enumerate the tree; it must never reach a client.
    const dir = await env.ASSETS.fetch(new URL("http://a/assets"));
    const dirBody = await dir.text();
    results.push(check("assets never leak a listing", dirBody.includes('"type":"file"'), false));

    const traversal = await env.ASSETS.fetch(new URL("http://a/../../etc/passwd"));
    results.push(check("assets refuse traversal", (await traversal.text()).includes("root:"), false));

    return Response.json(results);
  },
};
