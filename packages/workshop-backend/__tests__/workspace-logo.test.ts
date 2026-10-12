import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { workspaceLogoUrl } from "@gadgets/workshop-shared/api";
import {
  deleteWorkspaceLogo, putWorkspaceLogo, sanitizeWorkspaceLogoSvg, serveWorkspaceLogo,
} from "../src/workspace-logo.js";

const ROOT = '<svg xmlns="http://www.w3.org/2000/svg"';
const REDUCED_MOTION =
    "<style>@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }</style>";

// A logo around `inner`, so a case shows only what it is about.
function logo(inner: string, style = ""): string {
  return `<svg viewBox="0 0 64 64">${style}<circle cx="32" cy="32" r="20"/>${inner}</svg>`;
}

describe("sanitizeWorkspaceLogoSvg", () => {
  it("rebuilds a model's answer as the logo alone, behind the reduced-motion rule", () => {
    const written = "Here is your logo:\n```svg\n" +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'viewBox="0 0 64 64">\n' +
      '  <defs><linearGradient id="g"><stop offset="0" stop-color="#f60"/></linearGradient></defs>\n' +
      "  <style><![CDATA[ .a { animation: spin 4s linear infinite; transform-origin: 32px 32px; } " +
      "@keyframes spin { to { transform: rotate(360deg); } } ]]></style>\n" +
      '  <path class="a" d="M10 10 L54 32 Z" fill="url(#g)"/>\n' +
      "</svg>\n```";

    expect(sanitizeWorkspaceLogoSvg(written)).toBe(
      `${ROOT} viewBox="0 0 64 64">${REDUCED_MOTION}` +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f60"/></linearGradient></defs>' +
      "<style> .a { animation: spin 4s linear infinite; transform-origin: 32px 32px; } " +
      "@keyframes spin { to { transform: rotate(360deg); } } </style>" +
      '<path class="a" d="M10 10 L54 32 Z" fill="url(#g)"/></svg>');
  });

  it("drops script, links, foreign content and handlers, with whatever they hold", () => {
    const svg = sanitizeWorkspaceLogoSvg(logo(
      '<script>alert(1)</script><foreignObject><div onclick="x()">hi</div></foreignObject>' +
      '<a href="https://evil.example"><rect width="9" height="9"/></a>' +
      '<image href="https://evil.example/t.png"/><rect width="4" height="4" onload="x()"/>'));

    expect(svg).toBe(`${ROOT} viewBox="0 0 64 64">${REDUCED_MOTION}` +
      '<circle cx="32" cy="32" r="20"/><rect width="4" height="4"/></svg>');
  });

  it("drops every element that renders other content by reference, and every dash pattern", () => {
    // Nested <use> would multiply a few kilobytes into millions of shapes.
    const svg = sanitizeWorkspaceLogoSvg(logo(
      '<defs><g id="b"><use href="#a"/><use href="#a"/></g><symbol id="s"><path d="M0 0"/></symbol>' +
      '<mask id="m"><rect width="9" height="9"/></mask><clipPath id="c"><rect width="1" height="1"/>' +
      '</clipPath></defs><use href="#b"/><g mask="url(#m)" clip-path="url(#c)"/>' +
      // A tiny dash along a long path is millions of segments, drawn again on every frame.
      '<path d="M0 0H1999" stroke-dasharray=".002" stroke-dashoffset="1"/>'));

    expect(svg).toBe(`${ROOT} viewBox="0 0 64 64">${REDUCED_MOTION}` +
      '<circle cx="32" cy="32" r="20"/><defs><g id="b"></g></defs><g/><path d="M0 0H1999"/></svg>');
  });

  it("keeps no reference outside the logo", () => {
    const svg = sanitizeWorkspaceLogoSvg(logo(
      '<rect width="4" height="4" fill="url(https://evil.example/x)" ' +
      "style=\"mask-image:image-set('https://evil.example/t.png' 1x)\"/>" +
      '<rect width="4" height="4" style="fill:url(#g);mask-image:url(https://evil.example/m)"/>' +
      '<rect width="4" height="4" fill="url(&#104;ttps://evil.example/x)"/>'));

    expect(svg).not.toContain("evil");
    expect(svg).toContain('<rect width="4" height="4"/>');
  });

  it("rejects a logo whose stylesheet could load, escape or outrank anything", () => {
    for (const sheet of [
      '@import url(https://evil.example/x.css);',
      "@&#105;mport url(https://evil.example/x.css);",
      ".a { fill: url('https://evil.example/x)'); }",
      ".a { background: image-set(url(https://evil.example/t.png) 1x); }",
      ".a { animation: spin 1s infinite !important; }",
      ".a { content: \\75 rl(x); }",
      "@font-face { src: local(x); }",
      // CSS variables expand into each other, a few bytes to megabytes.
      ".a { --x: 1px 1px; --y: var(--x) var(--x); stroke-width: var(--y); }",
      ".d { stroke-dasharray: .002; animation: o 3s linear infinite; }",
      // CSS reads a no-break space as part of the URL, so this one points at a page.
      ".a { fill: url(\u00A0#g); }",
    ]) {
      expect(sanitizeWorkspaceLogoSvg(logo("", `<style>${sheet}</style>`)), sheet).toBeNull();
    }
    // A URL split across text and CDATA is still checked as the one stylesheet it forms.
    expect(sanitizeWorkspaceLogoSvg(logo("",
      "<style>.a { fill: url<![CDATA[(https://evil.example/x)]]>; }</style>"))).toBeNull();
  });

  it("rejects answers that are not one well-formed, drawn SVG", () => {
    for (const written of [
      "I can't draw that.",
      '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="20"/>',  // cut off mid-answer
      '<svg viewBox="0 0 64 64"><g><circle r="2"/></svg>',
      "<svg viewBox=0><circle r=\"2\"/></svg>",
      '<svg><!DOCTYPE x><circle r="2"/></svg>',
      '<svg/><svg><circle r="2"/></svg>',
      '<svg><circle r="2" fill="&#1;"/></svg>',
      '<svg><circle r="2" fill="&nbsp;"/></svg>',
      '<svg viewBox="0 0 64 64"><rect width="64" height="64" fill="#000">',
      '<svg viewBox="0 0 64 64"></svg>',
      '<svg viewBox="0 0 64 64"><defs><circle r="2"/></defs></svg>',
      '<svg viewBox="0 0 64 64"><linearGradient id="g"><circle r="2"/></linearGradient></svg>',
      logo(`<path d="${"M1 1 ".repeat(1700)}"/>`),
    ]) {
      expect(sanitizeWorkspaceLogoSvg(written), written.slice(0, 60)).toBeNull();
    }
  });
});

describe("workspace logo storage", () => {
  const GADGET = "a".repeat(64);
  const svg = sanitizeWorkspaceLogoSvg(logo(""));
  const url = (hash: string) => `https://workshop.example${workspaceLogoUrl({ id: GADGET, logo: hash })}`;

  it("serves a stored logo from its listing URL until it is deleted", async () => {
    if (svg === null) throw new Error("the fixture logo was rejected");
    const hash = await putWorkspaceLogo(env.BLUEPRINT_CONTENT, GADGET, svg);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);

    const response = await serveWorkspaceLogo(new Request(url(hash)), env.BLUEPRINT_CONTENT,
        new URL(url(hash)).pathname);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/svg+xml",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    expect(await response.text()).toBe(svg);

    const head = await serveWorkspaceLogo(new Request(url(hash), { method: "HEAD" }),
        env.BLUEPRINT_CONTENT, new URL(url(hash)).pathname);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    await deleteWorkspaceLogo(env.BLUEPRINT_CONTENT, GADGET, hash);
    const gone = await serveWorkspaceLogo(new Request(url(hash)), env.BLUEPRINT_CONTENT,
        new URL(url(hash)).pathname);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toBe("no-store");
  });

  it("answers only the exact path of a stored logo", async () => {
    if (svg === null) throw new Error("the fixture logo was rejected");
    const hash = await putWorkspaceLogo(env.BLUEPRINT_CONTENT, GADGET, svg);
    const path = new URL(url(hash)).pathname;

    for (const other of [`${path}/x`, path.replace(hash, "0".repeat(32)), path.toUpperCase()]) {
      const response = await serveWorkspaceLogo(new Request(`https://workshop.example${other}`),
          env.BLUEPRINT_CONTENT, other);
      expect(response.status, other).toBe(404);
    }
    const post = await serveWorkspaceLogo(new Request(url(hash), { method: "POST" }),
        env.BLUEPRINT_CONTENT, path);
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});
