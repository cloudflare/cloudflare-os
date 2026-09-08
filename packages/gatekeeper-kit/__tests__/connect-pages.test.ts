import { describe, expect, it } from "vitest";
import { CONNECT_HANDOFF_MESSAGE_TYPE } from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml,
  connectMutationError,
  errorPageHtml,
  escapeHtml,
  htmlResponse,
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
  // Pulls the envelope and target origin the page's script posts out of its two literals.
  function postMessageArgs(html: string): [unknown, string] {
    const envelope = /var envelope = (.*);\n/.exec(html);
    const target = /var target = (".*?");\n/.exec(html);
    expect(envelope).not.toBeNull();
    expect(target).not.toBeNull();
    // The literals are JSON with `<`, `>` and `&` written as \uXXXX escapes, which JSON accepts.
    return [JSON.parse(envelope![1]), JSON.parse(target![1])];
  }

  it("posts the versioned envelope to exactly the Workshop origin", () => {
    const html = connectHandoffPageHtml(HANDOFF);
    const [envelope, target] = postMessageArgs(html);

    expect(envelope).toEqual({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: HANDOFF.ticket });
    expect(target).toBe("https://workshop.example");
    expect(html).toContain("opener.postMessage(envelope, target)");
  });

  it("falls back to a same-origin BroadcastChannel named after the message type", () => {
    // A disowned connect popup has no opener; only when the page is on the Workshop's own origin
    // may it broadcast, and the channel name is the versioned message type so the listener and the
    // page cannot drift apart.
    const html = connectHandoffPageHtml(HANDOFF);

    expect(html).toContain(
      `else if (window.location.origin === target && "BroadcastChannel" in window)`);
    expect(html).toContain(
      `new BroadcastChannel(${JSON.stringify(CONNECT_HANDOFF_MESSAGE_TYPE)}).postMessage(envelope)`);
    // The opener wins when there is one: sign-in and the dev server rely on it.
    expect(html.indexOf("opener.postMessage")).toBeLessThan(html.indexOf("new BroadcastChannel"));
  });

  it("cannot be broken out of by the ticket or origin it embeds", () => {
    const hostile = { targetOrigin: "https://workshop.example", ticket: `</script><img src=x onerror=alert(1)>&'"` };
    const html = connectHandoffPageHtml(hostile);

    expect(html).not.toContain("</script><img");
    expect(html.split("<script>")).toHaveLength(2);
    expect(html.split("</script>")).toHaveLength(2);
    expect(postMessageArgs(html)[0]).toEqual({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: hostile.ticket });
  });

  it("refuses a targetOrigin that is not exactly an origin", () => {
    // A path or trailing slash would make the browser drop the message; an unparsable value or an
    // opaque origin would be far worse — `postMessage(…, "*")` style delivery to anyone.
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

  it("tells the user when it can reach no Workshop, and only closes when it could", () => {
    const html = connectHandoffPageHtml(HANDOFF);

    expect(html).toContain("if (opener && !opener.closed)");
    expect(html).toContain("window.close()");
    // The "couldn't reach" branch returns before the close timer, so the message stays readable.
    expect(html.indexOf("return;")).toBeLessThan(html.indexOf("window.close()"));
    expect(html).toContain("couldn't reach the Workshop");
    expect(html).toContain("start the connection again");
    expect(html).toContain(`<meta name="referrer" content="strict-origin-when-cross-origin">`);
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
