export default {
  async fetch(req, env) {
    const out = [];
    const chk = (name, cond, detail) => out.push(`${cond ? "PASS" : "FAIL"} | ${name} | ${detail}`);
    try {
      // ---- KV ----
      await env.KV.put("k1", "hello-value");
      chk("kv put/get text", (await env.KV.get("k1")) === "hello-value", await env.KV.get("k1"));

      await env.KV.put("k2", new Uint8Array([1, 2, 3, 255]));
      const ab = await env.KV.get("k2", "arrayBuffer");
      const got = ab ? [...new Uint8Array(ab)] : null;
      chk("kv get arrayBuffer", JSON.stringify(got) === "[1,2,3,255]", JSON.stringify(got));

      chk("kv get miss -> null", (await env.KV.get("nope")) === null, String(await env.KV.get("nope")));

      await env.KV.delete("k1");
      chk("kv delete -> null", (await env.KV.get("k1")) === null, String(await env.KV.get("k1")));

      // roundtrip of unicode + big-ish value
      const big = "éü中文".repeat(5000);
      await env.KV.put("k3", big);
      chk("kv unicode roundtrip", (await env.KV.get("k3")) === big, `len=${big.length}`);

      // ---- R2 ----
      const putRes = await env.R2.put("o1", new Uint8Array([1, 2, 3, 4, 5]), { httpMetadata: { contentType: "application/octet-stream" } });
      chk("r2 put returns object", putRes != null && putRes.key === "o1" && putRes.size === 5, JSON.stringify({ key: putRes?.key, size: putRes?.size }));

      const o = await env.R2.get("o1");
      const bytes = o ? [...new Uint8Array(await o.arrayBuffer())] : null;
      chk("r2 get body bytes", JSON.stringify(bytes) === "[1,2,3,4,5]", JSON.stringify(bytes));
      chk("r2 get .size", o?.size === 5, String(o?.size));
      chk("r2 get .httpMetadata.contentType", o?.httpMetadata?.contentType === "application/octet-stream", String(o?.httpMetadata?.contentType));

      // .body is a ReadableStream
      const o2 = await env.R2.get("o1");
      chk("r2 .body is ReadableStream", o2?.body instanceof ReadableStream, String(o2?.body?.constructor?.name));
      const reader = o2.body.getReader();
      let collected = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; collected.push(...value); }
      chk("r2 .body streams bytes", JSON.stringify(collected) === "[1,2,3,4,5]", JSON.stringify(collected));

      chk("r2 get miss -> null", (await env.R2.get("nope")) === null, String(await env.R2.get("nope")));

      // put a ReadableStream with contentType text/plain
      const rs = new Response("stream-body").body;
      await env.R2.put("o2", rs, { httpMetadata: { contentType: "text/plain" } });
      const o3 = await env.R2.get("o2");
      const o3text = await o3?.text();
      chk("r2 put ReadableStream", o3text === "stream-body", o3text);
      chk("r2 stream contentType", o3?.httpMetadata?.contentType === "text/plain", String(o3?.httpMetadata?.contentType));

      await env.R2.delete("o1");
      chk("r2 delete -> null", (await env.R2.get("o1")) === null, String(await env.R2.get("o1")));

      // larger binary body
      const bigBytes = new Uint8Array(300000).map((_, i) => i % 256);
      await env.R2.put("o3", bigBytes, { httpMetadata: { contentType: "application/octet-stream" } });
      const o4 = await env.R2.get("o3");
      const rb = new Uint8Array(await o4.arrayBuffer());
      let same = rb.byteLength === bigBytes.byteLength;
      if (same) for (let i = 0; i < rb.length; i++) if (rb[i] !== bigBytes[i]) { same = false; break; }
      chk("r2 300KB binary roundtrip", same, `size=${o4.size}`);
    } catch (e) {
      out.push("EXCEPTION | " + String(e && e.stack || e));
    }
    return new Response(out.join("\n") + "\n");
  }
};
