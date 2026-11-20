import { describe, expect, it } from "vitest";
import {
  CONNECT_FORM_NONCE_FIELD,
  connectFormHtml,
  connectHandoffPageHtml,
  connectMutationError,
  errorPageHtml,
  escapeHtml,
  formPageResponse,
  htmlResponse,
  readConnectForm,
  INVALID_LINK_HTML,
} from "../src/connect-pages";

const HANDOFF = { targetOrigin: "https://workshop.example", ticket: "a".repeat(64) };

describe("connect pages", () => {
  it("escapes every character that could break out of markup", () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`))
      .toBe("&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;");
  });

  it("escapes vendor-supplied error text into the page", () => {
    const html = errorPageHtml("Acme <b>Gatekeeper</b>", "Ask an admin & retry");

    expect(html).toContain("<h1>Acme &lt;b&gt;Gatekeeper&lt;/b&gt;</h1>");
    expect(html).toContain("Ask an admin &amp; retry");
    expect(html).not.toContain("<b>");
  });

  it("declares a language and viewport on every page it serves", () => {
    for (const html of [
      connectHandoffPageHtml(HANDOFF), INVALID_LINK_HTML, errorPageHtml("Failed", "Retry"),
    ]) {
      expect(html).toContain(`<html lang="en">`);
      expect(html).toContain(`name="viewport"`);
    }
  });

  it("serves uncached HTML that cannot be framed, sniffed, or leak a nonce", async () => {
    const response = htmlResponse("<p>hi</p>", 400);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("<p>hi</p>");
  });
});

describe("connectHandoffPageHtml", () => {
  // Pulls the ticket and target origin the page's script navigates with out of its two literals.
  function scriptLiterals(html: string): [string, string] {
    const ticket = /var ticket = (".*?");\n/.exec(html);
    const target = /var target = (".*?");\n/.exec(html);
    expect(ticket).not.toBeNull();
    expect(target).not.toBeNull();
    // The literals are JSON with `<`, `>` and `&` written as \uXXXX escapes, which JSON accepts.
    return [JSON.parse(ticket![1]), JSON.parse(target![1])];
  }

  it("navigates the popup to the Workshop's handoff page with the ticket in the fragment", () => {
    const html = connectHandoffPageHtml(HANDOFF);
    const [ticket, target] = scriptLiterals(html);

    expect(ticket).toBe(HANDOFF.ticket);
    expect(target).toBe("https://workshop.example");
    // The path is pinned here and in workshop-frontend's route: the kit must not depend on it.
    expect(html).toContain(
      `window.location.replace(target + "/connect/handoff#" + encodeURIComponent(ticket))`);
  });

  it("cannot be broken out of by the ticket or origin it embeds", () => {
    const hostile = { targetOrigin: "https://workshop.example", ticket: `</script><img src=x onerror=alert(1)>&'"` };
    const html = connectHandoffPageHtml(hostile);

    expect(html).not.toContain("</script><img");
    expect(html.split("<script>")).toHaveLength(2);
    expect(html.split("</script>")).toHaveLength(2);
    expect(scriptLiterals(html)[0]).toBe(hostile.ticket);
  });

  it("refuses a targetOrigin that is not exactly an origin", () => {
    // A trailing slash or path would produce a malformed redirect; an unparsable value or an opaque
    // origin would send the ticket somewhere else.
    for (const targetOrigin of [
      "https://workshop.example/", "https://workshop.example/app", "*", "null", "workshop.example",
      "", "javascript:alert(1)",
    ]) {
      expect(() => connectHandoffPageHtml({ ...HANDOFF, targetOrigin }))
        .toThrow("targetOrigin is not an origin");
    }
    expect(() => connectHandoffPageHtml({ ...HANDOFF, targetOrigin: "http://localhost:3000" }))
      .not.toThrow();
  });

  it("keeps the referrer policy that hides the path from cross-origin requests", () => {
    expect(connectHandoffPageHtml(HANDOFF))
      .toContain(`<meta name="referrer" content="strict-origin-when-cross-origin">`);
  });

  it("carries no channel, opener or message transport", () => {
    const html = connectHandoffPageHtml(HANDOFF);

    for (const transport of [
      "BroadcastChannel", "opener", "postMessage", "setTimeout", "setInterval",
    ]) {
      expect(html).not.toContain(transport);
    }
  });
});

describe("connectMutationError", () => {
  const origin = "https://gatekeeper.example";
  const json = { origin, contentType: "application/json" };
  const mutation = (headers: Record<string, string>) =>
    new Request(`${origin}/connect/capability`, { method: "POST", headers });

  it("accepts a same-origin mutation carrying the required content type", () => {
    expect(connectMutationError(
      mutation({ Origin: origin, "Content-Type": "application/json" }), json,
    )).toBeUndefined();
  });

  it("refuses a mutation whose Origin is absent or foreign", () => {
    // Browsers send Origin on every POST, so an absent one is a non-browser caller that has no
    // business on a browser capability URL.
    expect(connectMutationError(mutation({ "Content-Type": "application/json" }), json))
      .toBe("cross-origin");
    expect(connectMutationError(
      mutation({ Origin: "https://attacker.example", "Content-Type": "application/json" }), json,
    )).toBe("cross-origin");
  });

  it("refuses a mutation whose content type is absent or wrong", () => {
    expect(connectMutationError(mutation({ Origin: origin }), json))
      .toBe("unsupported-content-type");
    expect(connectMutationError(mutation({ Origin: origin, "Content-Type": "text/plain" }), json))
      .toBe("unsupported-content-type");
  });

  it("compares against the configured origin, not the request URL", () => {
    // A fronting proxy may rewrite the host the Worker sees; Origin still names the base URL.
    const rewritten = new Request("https://internal.host/connect/capability", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
    });
    expect(connectMutationError(rewritten, json)).toBeUndefined();
    expect(connectMutationError(rewritten, { ...json, origin: "https://other.example" }))
      .toBe("cross-origin");
  });

  it("accepts a full base URL as the expected origin", () => {
    expect(connectMutationError(
      mutation({ Origin: origin, "Content-Type": "application/json" }),
      { origin: `${origin}/gatekeeper/acme`, contentType: "application/json" },
    )).toBeUndefined();
  });

  it("matches the content type case-insensitively and past its parameters", () => {
    expect(connectMutationError(
      mutation({ Origin: origin, "Content-Type": "APPLICATION/JSON" }), json,
    )).toBeUndefined();
    expect(connectMutationError(
      mutation({ Origin: origin, "Content-Type": "multipart/form-data; boundary=x" }),
      { origin, contentType: "multipart/form-data" },
    )).toBeUndefined();
  });

  it("compares the media type exactly, so no neighbour or parameter can smuggle it", () => {
    // `application/jsonp` contains the required type, and so does the parameter in the second one.
    for (const contentType of [
      "application/jsonp",
      "text/plain; x=application/json",
      "application/json-patch+json",
    ]) {
      expect(connectMutationError(mutation({ Origin: origin, "Content-Type": contentType }), json))
        .toBe("unsupported-content-type");
    }
  });
});

describe("connect forms", () => {
  const ORIGIN = "https://os.example/gatekeeper/vendor";
  const form = (overrides: Partial<Parameters<typeof connectFormHtml>[0]> = {}) => connectFormHtml({
    title: "Connect Vendor", intro: "Paste a key.", action: `${ORIGIN}/abc/key`, nonce: "f".repeat(64),
    fields: [{ name: "key", label: "API key", secret: true }], ...overrides,
  });
  const submission = (body: string, headers: Record<string, string> = {}, method = "POST") =>
    new Request(`${ORIGIN}/abc/key`, {
      method,
      headers: { Origin: "https://os.example", "Content-Type": "application/x-www-form-urlencoded", ...headers },
      ...(method === "POST" ? { body } : {}),
    });

  // Under `no-referrer` a browser posts the page's forms with `Origin: null`, which
  // `connectMutationError` refuses: the form could never be submitted.
  it("serves a form page whose submissions name their origin", () => {
    const response = formPageResponse(form());
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'; form-action 'self'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(htmlResponse(form()).headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("posts the nonce in a hidden field beside the inputs", () => {
    const html = form({ fields: [{ name: "host", label: "Host", placeholder: "https://x" }, { name: "key", label: "Key", secret: true }] });
    expect(html).toContain(`<form method="post" action="${ORIGIN}/abc/key" onsubmit="if(event.submitter)event.submitter.disabled=true">`);
    expect(html).toContain(`<input type="hidden" name="${CONNECT_FORM_NONCE_FIELD}" value="${"f".repeat(64)}">`);
    expect(html).toContain('<input id="host" name="host" type="text" required placeholder="https://x" aria-describedby="form.intro" autofocus>');
    expect(html).toContain('<input id="key" name="key" type="password" required autocomplete="new-password" data-1p-ignore data-lpignore="true">');
    expect(html).toContain('<button type="submit">Connect</button>');
  });

  it("escapes everything it is given", () => {
    const hostile = '"><script>alert(1)</script>';
    const html = form({
      title: hostile, intro: hostile, action: hostile, nonce: hostile, submitLabel: hostile,
      fields: [{ name: "key", label: hostile, placeholder: hostile }],
    });
    expect(html).not.toContain("<script>");
  });

  it("says why the last submission was refused, when given an error, and ties it to the inputs", () => {
    expect(form()).not.toContain('class="err"');
    expect(form()).not.toContain("aria-invalid");
    expect(form()).not.toContain("form.error");
    const html = form({ error: "Vendor refused <that> key." });
    expect(html).toContain('<p class="err" id="form.error" role="alert">Vendor refused &lt;that&gt; key.</p>');
    expect(html).toContain('data-lpignore="true" aria-invalid="true" aria-describedby="form.error form.intro" autofocus>');
    const second = form({ error: "No.", fields: [{ name: "host", label: "Host" }, { name: "key", label: "Key" }] });
    expect(second).toContain('<input id="key" name="key" type="text" required aria-invalid="true" aria-describedby="form.error">');
  });

  // A quote with no `<` or `>` after it: what closes an attribute and opens another.
  it("escapes quotes in attribute values", () => {
    const hostile = 'x" onfocus="alert(1)';
    const html = form({
      title: "t", intro: "i", action: hostile, nonce: hostile,
      fields: [{ name: "key", label: "l", placeholder: hostile }],
    });
    expect(html).not.toContain('" onfocus="');
    expect(html.split("x&quot; onfocus=&quot;alert(1)")).toHaveLength(4);
  });

  it.each([
    [[]],
    [[{ name: "nonce", label: "x" }]],
    [[{ name: "a b", label: "x" }]],
    [[{ name: 'a"', label: "x" }]],
    [[{ name: "key", label: "x" }, { name: "key", label: "y" }]],
  ])("refuses the fields %j", fields => {
    expect(() => form({ fields })).toThrow("connect form needs fields");
  });

  it("reads a submission from the gatekeeper's own page", async () => {
    const read = await readConnectForm(submission("nonce=abc&key=s%20k"), { origin: ORIGIN });
    expect(read).toBeInstanceOf(URLSearchParams);
    expect((read as URLSearchParams).get(CONNECT_FORM_NONCE_FIELD)).toBe("abc");
    expect((read as URLSearchParams).get("key")).toBe("s k");
  });

  it.each([
    ["from another site", { Origin: "https://evil.example" }, "POST", 403],
    ["from a page that sends no referrer", { Origin: "null" }, "POST", 403],
    ["in another encoding", { "Content-Type": "text/plain" }, "POST", 415],
    ["by another method", {}, "GET", 405],
  ])("refuses a submission %s", async (_name, headers, method, status) => {
    const read = await readConnectForm(submission("nonce=abc&key=k", headers, method), { origin: ORIGIN });
    expect(read).toBeInstanceOf(Response);
    expect((read as Response).status).toBe(status);
    expect((read as Response).headers.get("Cache-Control")).toBe("no-store");
  });

  it("names the method a submission must use", async () => {
    const read = await readConnectForm(submission("", {}, "GET"), { origin: ORIGIN });
    expect((read as Response).headers.get("Allow")).toBe("POST");
  });

  it("accepts a body of exactly the cap and refuses one byte more", async () => {
    const body = `key=${"k".repeat(60)}`;
    expect(await readConnectForm(submission(body), { origin: ORIGIN, maxBytes: 64 })).toBeInstanceOf(URLSearchParams);
    const read = await readConnectForm(submission(`${body}k`), { origin: ORIGIN, maxBytes: 64 });
    expect((read as Response).status).toBe(413);
  });

  it("refuses a submission whose body cannot be read", async () => {
    const body = new ReadableStream({ start: controller => controller.error(new TypeError("client went away")) });
    const req = new Request(`${ORIGIN}/abc/key`, {
      method: "POST", body, duplex: "half",
      headers: { Origin: "https://os.example", "Content-Type": "application/x-www-form-urlencoded" },
    } as RequestInit);
    const read = await readConnectForm(req, { origin: ORIGIN });
    expect((read as Response).status).toBe(400);
  });

  it("does not read the body of a submission it refuses", async () => {
    const req = submission("nonce=abc&key=k", { Origin: "https://evil.example" });
    await readConnectForm(req, { origin: ORIGIN });
    expect(req.bodyUsed).toBe(false);
  });

  it("throws on a cap that is not a positive integer", async () => {
    await expect(readConnectForm(submission("key=k"), { origin: ORIGIN, maxBytes: 0 })).rejects.toThrow("maxBytes");
    await expect(readConnectForm(submission("", {}, "GET"), { origin: ORIGIN, maxBytes: 0 })).rejects.toThrow("maxBytes");
  });

});
