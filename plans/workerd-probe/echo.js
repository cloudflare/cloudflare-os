export default {
  async fetch(req) {
    const buf = await req.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const hdrs = {};
    for (const [k, v] of req.headers) hdrs[k] = v;
    console.log("ECHO " + JSON.stringify({
      method: req.method,
      url: req.url,
      cf: req.cf ?? null,
      headers: hdrs,
      bodyLen: bytes.length,
      bodyHex: [...bytes.slice(0, 200)].map(b => b.toString(16).padStart(2, "0")).join(""),
      bodyText: (() => { try { return new TextDecoder().decode(bytes); } catch { return null; } })(),
    }));
    // Deliberately return 404 so .get() sees a miss; test worker catches errors.
    return new Response("echo-miss", { status: 404 });
  }
};
