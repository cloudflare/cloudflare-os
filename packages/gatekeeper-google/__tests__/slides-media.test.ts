// The pictures and fonts a drawing of a slide needs are fetched for a frame that has no network.
// A picture's address is a bearer URL and a font's name comes from the presentation, so what is
// fetched, from where, and how much of it is kept are all bounded here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadFont, downloadPicture, isFontRequest, MAX_CACHED_FONT_BYTES, MAX_PICTURE_BYTES, picturePixels,
} from "../src/slides-media";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PICTURE = "https://lh3.googleusercontent.com/picture";
const FONT_FILE = "https://fonts.gstatic.com/s/font.ttf";

let requests: { url: string; redirect?: string; authorization: string | null }[];
let answer: (url: URL) => Response;

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    requests.push({ url: request.url, redirect: init?.redirect, authorization: request.headers.get("Authorization") });
    return answer(new URL(request.url));
  });
});
afterEach(() => vi.unstubAllGlobals());

const bytes = (start: number[], length = start.length) => {
  let all = new Uint8Array(length);
  all.set(start);
  return all;
};
const fails = async (run: Promise<unknown>) => run.then(() => "no error", (error: Error) => error.message);

describe("how large a picture is fetched", () => {
  it.each([
    [240, 720, 600], // a third of the slide, to the next hundred pixels
    [720, 720, 1600],
    [10, 720, 200], // never smaller than a thumbnail
    [2000, 720, 2048], // never larger than the image host serves quickly
    [Infinity, 720, 1600], // a background, drawn across the slide
  ])("fetches one whose longer side is %i points on a slide %i wide at %i pixels", (side, slideWidth, pixels) => {
    expect(picturePixels(side, slideWidth)).toBe(pixels);
  });
});

describe("a picture's download", () => {
  it("fetches the picture at the size asked, with no credentials and no redirect followed", async () => {
    answer = () => new Response(bytes(PNG));

    let picture = await downloadPicture(`${PICTURE}=s4000`, 800);

    expect(picture?.mimeType).toBe("image/png");
    expect(new Uint8Array(await new Response(picture!.content).arrayBuffer())).toEqual(bytes(PNG));
    expect(requests).toEqual([{ url: `${PICTURE}=s800`, redirect: "manual", authorization: null }]);
  });

  it.each([
    "https://example.com/picture=s100",
    "https://googleusercontent.com.example.com/picture",
    "https://evilgoogleusercontent.com/picture",
    "http://lh3.googleusercontent.com/picture",
    "not a url",
  ])("refuses the address %s, which is not on Google's hosts, without fetching it", async address => {
    expect(await fails(downloadPicture(address, 800))).toBe("Google Slides returned a picture address outside Google");
    expect(requests).toEqual([]);
  });

  it("follows the one redirect Docs makes to the image host, as it is", async () => {
    answer = url => url.hostname === "docs.google.com"
      ? new Response(null, { status: 302, headers: { location: `${PICTURE}=s4000` } })
      : new Response(bytes(PNG));

    let picture = await downloadPicture("https://docs.google.com/drawings/image?id=1", 800);

    expect(picture?.mimeType).toBe("image/png");
    expect(requests.map(request => request.url))
      .toEqual(["https://docs.google.com/drawings/image?id=1", `${PICTURE}=s800`]);
  });

  it("refuses a redirect that leaves Google's hosts", async () => {
    answer = () => new Response(null, { status: 302, headers: { location: "https://example.com/picture" } });

    expect(await fails(downloadPicture("https://docs.google.com/drawings/image?id=1", 800)))
      .toBe("Google Slides returned a picture address outside Google");
    expect(requests).toHaveLength(1);
  });

  it("follows no redirect from the image host, nor a second one", async () => {
    answer = () => new Response(null, { status: 302, headers: { location: `${PICTURE}=s1` } });

    expect(await fails(downloadPicture(`${PICTURE}=s4000`, 800))).toContain("[http=302]");
    expect(await fails(downloadPicture("https://docs.google.com/drawings/image?id=1", 800))).toContain("[http=302]");
    expect(requests).toHaveLength(3);
  });

  it.each([400, 403, 404, 410])("returns nothing for the %i of an address that has lapsed", async status => {
    answer = () => new Response(null, { status });

    expect(await downloadPicture(`${PICTURE}=s4000`, 800)).toBeUndefined();
  });

  it.each([429, 500, 503])("fails on a %i, which a new address would not mend", async status => {
    answer = () => new Response(null, { status });

    expect(await fails(downloadPicture(`${PICTURE}=s4000`, 800)))
      .toBe(`readPicture: Google did not serve this picture [http=${status}].`);
  });

  it("hands a picture on as it is read, whole", async () => {
    answer = () => new Response(bytes(PNG, 100_000));

    let picture = await downloadPicture(`${PICTURE}=s4000`, 800);

    expect(new Uint8Array(await new Response(picture!.content).arrayBuffer())).toEqual(bytes(PNG, 100_000));
  });

  it("refuses a picture Google says is larger than a session returns", async () => {
    answer = () => new Response(bytes(PNG), { headers: { "Content-Length": String(MAX_PICTURE_BYTES + 1) } });

    expect(await fails(downloadPicture(`${PICTURE}=s4000`, 800))).toBe("readPicture: this picture is larger than 6 MB.");
  });

  it("fails the read of a picture that turns out larger than a session returns", async () => {
    // A body of no stated length, as one Google sends in pieces.
    answer = () => new Response(bytes(PNG, MAX_PICTURE_BYTES + 1));

    let picture = await downloadPicture(`${PICTURE}=s4000`, 800);

    expect(await fails(new Response(picture!.content).arrayBuffer())).toBe("readPicture: this picture is larger than 6 MB.");
  });

  it.each([
    ["an SVG", [..."<svg xmlns"].map(c => c.charCodeAt(0))],
    ["a page", [..."<!doctype html>"].map(c => c.charCodeAt(0))],
    ["nothing", []],
  ])("refuses %s, which is no picture a frame can be handed", async (_, start) => {
    answer = () => new Response(bytes(start), { headers: { "Content-Type": "image/png" } });

    expect(await fails(downloadPicture(`${PICTURE}=s4000`, 800))).toBe("readPicture: this picture's format cannot be read.");
  });

  it.each([
    ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
  ])("names a picture %s by how its bytes start, whatever Google calls it", async (mimeType, start) => {
    answer = () => new Response(bytes(start), { headers: { "Content-Type": "text/plain" } });

    expect((await downloadPicture(`${PICTURE}=s4000`, 800))?.mimeType).toBe(mimeType);
  });
});

describe("a font's download", () => {
  const TRUETYPE = [0, 1, 0, 0];
  let sheet = (file: string) => new Response(`@font-face { font-family: 'F'; src: url(${file}) format('truetype'); }`);
  let serving = (file: string, font: () => Response) => {
    answer = url => url.hostname === "fonts.googleapis.com" ? sheet(file) : font();
  };

  it.each([
    ["Open Sans", 400, true], ["Oxygen", 900, true],
    ["Oxygen&family=Lobster", 400, false], ["Oxygen:wght@100", 400, false], ["../Oxygen", 400, false],
    ["", 400, false], ["Oxygen", 450, false], ["Oxygen", 0, false], ["Oxygen", 1000, false],
  ])("says whether Google Fonts could have a family named %j at weight %i", (family, weight, possible) => {
    expect(isFontRequest(family, weight)).toBe(possible);
  });

  it("asks Google Fonts for the one font by its name, and fetches its file from the fonts host", async () => {
    serving(FONT_FILE, () => new Response(bytes(TRUETYPE, 64)));

    let font = await downloadFont("First Family", 700, true);

    expect(font.byteLength).toBe(64);
    expect(requests.map(request => new URL(request.url))).toMatchObject([
      { origin: "https://fonts.googleapis.com", pathname: "/css2" }, { href: FONT_FILE },
    ]);
    expect(new URL(requests[0].url).searchParams.get("family")).toBe("First Family:ital,wght@1,700");
    expect(requests.every(request => request.redirect === "manual")).toBe(true);
  });

  it.each([
    "https://example.com/font.ttf", "http://fonts.gstatic.com/s/font.ttf", "https://fonts.gstatic.com.example.com/font.ttf",
  ])("refuses a font file at %s, which is not the fonts host, without fetching it", async file => {
    serving(file, () => new Response(bytes(TRUETYPE, 64)));

    expect(await fails(downloadFont("Elsewhere", 400, false))).toBe("readFont: Google Fonts returned no font file.");
    expect(requests).toHaveLength(1);
  });

  it("refuses bytes that are no font, a font too large, and a family Google Fonts does not serve", async () => {
    serving(FONT_FILE, () => new Response("<!doctype html>"));
    expect(await fails(downloadFont("No Font", 400, false))).toBe("readFont: Google Fonts returned no font file.");

    serving(FONT_FILE, () => new Response(bytes(TRUETYPE, 3 * 1024 * 1024 + 1)));
    expect(await fails(downloadFont("Vast", 400, false))).toMatch(/too large|exceed/i);

    answer = () => new Response(null, { status: 400 });
    expect(await fails(downloadFont("Unknown", 400, true)))
      .toBe('readFont: Google Fonts does not serve "Unknown" at weight 400 italic.');
  });

  it("fetches a font once for every session, and one that failed again", async () => {
    answer = () => new Response(null, { status: 503 });
    await fails(downloadFont("Shared", 400, false));
    serving(FONT_FILE, () => new Response(bytes(TRUETYPE, 64)));

    await downloadFont("Shared", 400, false);
    await downloadFont("Shared", 400, false);

    expect(requests).toHaveLength(3);
  });

  it("keeps no more bytes of fonts than its bound, letting the oldest go first", async () => {
    let size = 2 * 1024 * 1024;
    serving(FONT_FILE, () => new Response(bytes(TRUETYPE, size)));
    let count = Math.floor(MAX_CACHED_FONT_BYTES / size) + 1;
    for (let i = 0; i < count; i++) await downloadFont(`Kept ${i}`, 400, false);
    requests = [];

    await downloadFont(`Kept ${count - 1}`, 400, false);
    expect(requests).toHaveLength(0);
    await downloadFont("Kept 0", 400, false);
    expect(requests).toHaveLength(2);
  });
});
