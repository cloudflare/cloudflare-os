import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unguardedNativeRead, type NativeRead } from "../../src/drive-session";
import { GoogleSlidesApi } from "../../src/slides-api";
import { GooglePresentationSessionImpl } from "../../src/slides";
import { presentation, shape, slide, text } from "../slides-fixture";

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(_action: number, _description: ActionDescription): Promise<void> {
    throw new Error("Unexpected action submission");
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

const IMAGE_URL = "https://lh7-us.googleusercontent.com/slidesz/thumb-token";

let providerFetches: URL[];
let imageRequests: Request[];
let thumbnailContentUrl: string;

/** The 24 bytes of a PNG that carry its dimensions: the signature and the IHDR chunk's start. */
function png(width: number, height: number): Uint8Array {
  let bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  let view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const SMALL_DECK = presentation([
  slide("s1", [shape("t1", text(["Intro"]), { placeholder: "TITLE" })]),
  slide("s2", [shape("b2", text(["Body"]))], { notes: text(["Say hello"]) }),
]);
let deck: typeof SMALL_DECK;

beforeEach(() => {
  providerFetches = [];
  deck = SMALL_DECK;
  imageRequests = [];
  thumbnailContentUrl = IMAGE_URL;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    providerFetches.push(url);
    if (url.href === IMAGE_URL) {
      imageRequests.push(request);
      return new Response(png(800, 450), { headers: { "Content-Type": "image/png" } });
    }
    if (url.hostname !== "slides.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
    }
    if (url.pathname.endsWith("/thumbnail")) {
      // Google's reported height is not trusted: a live 200-wide render reported 113 for 112.
      return Response.json({ width: 800, height: 451, contentUrl: thumbnailContentUrl });
    }
    let pageId = url.pathname.match(/\/pages\/([^/]+)$/)?.[1];
    if (pageId === undefined) return Response.json(deck);
    let page = deck.slides!.find(s => s.objectId === pageId);
    return page ? Response.json(page) : new Response(null, { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** `wrap` stands in for a scope-checking read, such as a Drive folder binding's, around the base. */
function newSession(wrap: (read: NativeRead) => NativeRead = read => read) {
  let queue = new TestApprovalQueue();
  let queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  let session = new RpcStub(new GooglePresentationSessionImpl(
    new GoogleSlidesApi(async () => "access-token"), "deck-1", queueStub,
    wrap(unguardedNativeRead(description => queueStub.authorizeObservation(description))),
  ));
  return { queue, session };
}

describe("Google Slides presentation session", () => {
  it("reads only the requested slides, in request order, after authorizing the read", async () => {
    let { queue, session } = newSession();
    using _session = session;

    let slides = await session.getSlides(["s2", "s1"]);

    expect(slides.map(s => [s.id, s.index, s.speakerNotes]))
      .toEqual([["s2", 1, "Say hello"], ["s1", 0, ""]]);
    expect(queue.observations).toHaveLength(1);
    let [outline, ...pages] = providerFetches;
    expect(outline.searchParams.get("fields")).not.toContain("pageElements");
    expect(pages.map(url => url.pathname).toSorted()).toEqual(
      ["/v1/presentations/deck-1/pages/s1", "/v1/presentations/deck-1/pages/s2"]);
  });

  // The error says which IDs are not slides, which is itself something read from the deck.
  it("authorizes the read before reporting an unknown slide ID", async () => {
    let { queue, session } = newSession();
    using _session = session;

    await expect(Promise.resolve(session.getSlides(["s1", "missing"])))
      .rejects.toThrow(/No slide with ID "missing"/);
    expect(queue.observations).toHaveLength(1);
  });

  it.each([[[]], [Array.from({ length: 21 }, (_, i) => `s${i}`)]])(
    "refuses %# out-of-bounds slide counts without reading the deck",
    async ids => {
      let { queue, session } = newSession();
      using _session = session;

      await expect(Promise.resolve(session.getSlides(ids)))
        .rejects.toThrow("between 1 and 20 slides");
      expect(providerFetches).toEqual([]);
      expect(queue.observations).toEqual([]);
    },
  );

  // Each 1.8 MB page is within the 2 MiB page cap; five together exceed what one call returns.
  it("refuses slides too large to return together, which read in smaller batches", async () => {
    let body = text(["x".repeat(1_800_000)]);
    deck = presentation(Array.from({ length: 5 }, (_, i) => slide(`big${i}`, [shape("b", body)])));
    let ids = deck.slides!.map(s => s.objectId!);
    let { session } = newSession();
    using _session = session;

    await expect(Promise.resolve(session.getSlides(ids))).rejects.toThrow("Request fewer");
    expect(await session.getSlides(ids.slice(0, 4))).toHaveLength(4);
    expect(await session.getSlides(ids.slice(4))).toHaveLength(1);
  });

  describe("getSlideThumbnail", () => {
    it("returns the rendered PNG, sized by its own header, without sending the token", async () => {
      let { queue, session } = newSession();
      using _session = session;

      let thumbnail = await session.getSlideThumbnail("s2");

      expect(thumbnail).toMatchObject({ mimeType: "image/png", width: 800, height: 450 });
      expect(new Uint8Array(thumbnail.content)).toEqual(png(800, 450));
      expect(queue.observations.map(o => o.description)).toEqual([
        'Render an image of slide 2 in "Quarterly review".',
      ]);
      expect(providerFetches.find(url => url.pathname.endsWith("/thumbnail"))?.searchParams
        .get("thumbnailProperties.thumbnailSize")).toBe("MEDIUM");
      expect(imageRequests.map(request => request.headers.get("Authorization"))).toEqual([null]);
    });

    // A Drive folder binding rechecks scope after the read's fetch; a render outside it escapes.
    it("renders inside the read, where a scope check around it covers the image", async () => {
      let imagesWithinRead: number | undefined;
      let { session } = newSession(read => (fetch, observe) => read(async () => {
        let value = await fetch();
        imagesWithinRead = imageRequests.length;
        return value;
      }, observe));
      using _session = session;

      await session.getSlideThumbnail("s1");

      expect(imagesWithinRead).toBe(1);
    });

    it("authorizes the read before reporting an unknown slide ID, and renders nothing", async () => {
      let { queue, session } = newSession();
      using _session = session;

      await expect(Promise.resolve(session.getSlideThumbnail("missing")))
        .rejects.toThrow(/No slide with ID "missing"/);
      expect(queue.observations).toHaveLength(1);
      expect(providerFetches.some(url => url.pathname.endsWith("/thumbnail"))).toBe(false);
    });

    // The URL is a bearer credential for the image, so it is only ever presented to Google.
    it.each([
      "https://googleusercontent.com.attacker.example/thumb",
      "http://lh7-us.googleusercontent.com/thumb",
    ])("refuses a thumbnail location of %s without fetching it", async location => {
      thumbnailContentUrl = location;
      let { session } = newSession();
      using _session = session;

      await expect(Promise.resolve(session.getSlideThumbnail("s1")))
        .rejects.toThrow("unexpected thumbnail location");
      expect(providerFetches.map(url => url.hostname)).not.toContain(new URL(location).hostname);
    });
  });
});
