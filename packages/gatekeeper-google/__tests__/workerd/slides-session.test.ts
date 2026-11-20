import { env } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { buildDeck, drawnShape, transform } from "@gadgets/office-content/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unguardedNativeRead, type NativeRead } from "../../src/drive-session";
import { officeFileError } from "../../src/office-conversion";
import { GoogleSlidesApi, type RestPageElement } from "../../src/slides-api";
import { MAX_EXPORT_BYTES, PPTX_MIME_TYPE } from "../../src/slides-export";
import { THEME_FIELDS } from "../../src/slides-fields";
import { GooglePresentationSessionImpl } from "../../src/slides";
import type { QueuedChange } from "../../src/slides-simulation";
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

  // The session never ends in this test.
  async requireLive(): Promise<void> {}

  async watchSession(): Promise<RpcStub<RpcTarget>> {
    return new RpcStub(new (class extends RpcTarget {})());
  }

  async getExecutionId(): Promise<string | undefined> {
    return undefined;
  }
}

const IMAGE_URL = "https://lh7-us.googleusercontent.com/slidesz/thumb-token";

// A picture's address, ending in the width its host serves it at.
const PICTURE_URL = "https://lh3.googleusercontent.com/picture-token";
const FONT_URL = "https://fonts.gstatic.com/s/oxygen/v15/regular.ttf";
/** How a TrueType file starts. */
const FONT = new Uint8Array([0, 1, 0, 0, 0, 12]);

let pictureRequests: Request[];
/** What Google answers for the picture before it serves it: 403 once its address has lapsed. */
let pictureFailures: number[];
let fontRequests: string[];
let providerFetches: URL[];
let imageRequests: Request[];
let thumbnailContentUrl: string;
/** What Drive answers a request for the presentation as a PowerPoint file. */
let exportOf: () => Response | Promise<Response>;
let exportRequests: Request[];

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
  pictureRequests = [];
  pictureFailures = [];
  fontRequests = [];
  thumbnailContentUrl = IMAGE_URL;
  exportOf = () => new Response(null, { status: 403 });
  exportRequests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    providerFetches.push(url);
    if (url.href === IMAGE_URL) {
      imageRequests.push(request);
      return new Response(png(800, 450), { headers: { "Content-Type": "image/png" } });
    }
    if (url.href.startsWith(PICTURE_URL)) {
      pictureRequests.push(request);
      let status = pictureFailures.shift();
      return status ? new Response(null, { status }) : new Response(png(64, 64));
    }
    if (url.hostname === "fonts.googleapis.com") {
      fontRequests.push(url.searchParams.get("family")!);
      return url.searchParams.get("family")!.startsWith("Oxygen:")
        ? new Response(`@font-face { font-family: 'Oxygen'; src: url(${FONT_URL}) format('truetype'); }`)
        : new Response(null, { status: 400 });
    }
    if (url.href === FONT_URL) return new Response(FONT);
    if (url.href.startsWith("https://www.googleapis.com/drive/v3/files/deck-1/export?")) {
      exportRequests.push(request);
      return exportOf();
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * `wrap` stands in for a scope-checking read, such as a Drive folder binding's, around the base;
 * `pending` are the changes reads show as queued.
 */
function newSession(wrap: (read: NativeRead) => NativeRead = read => read, pending: QueuedChange[] = []) {
  let queue = new TestApprovalQueue();
  let queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  let session = new RpcStub(new GooglePresentationSessionImpl(
    new GoogleSlidesApi(async () => "access-token"), "deck-1", queueStub,
    wrap(unguardedNativeRead(
      description => queueStub.authorizeObservation(description),
      [{ kind: "presentation", fileId: "deck-1" }],
    )),
    { snapshot: read => read(pending), queue: () => Promise.reject(new Error("Unexpected change")) },
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
    expect(queue.observations.map(o => o.subresources)).toEqual([["slides/presentation/deck-1"]]);
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

  it("reads a queued new slide from replay alone, skips it as queued, and does not render it", async () => {
    let { session } = newSession(undefined, [
      { id: 1, action: { kind: "createSlide", payload: {
        newSlideId: "new", layoutId: "layout-title", layout: "Title slide", after: "s1",
        placeholders: [{ objectId: "new-title", type: "CENTERED_TITLE", index: 0, parentObjectId: "lt-title" }],
      } } },
      { id: 2, action: { kind: "skipSlides", payload: { slideIds: ["new", "s2"], skipped: true, slides: [] } } },
    ]);
    using _session = session;

    let [created] = await session.getSlides(["new"]);

    expect(created).toMatchObject({
      id: "new", index: 1, layout: "Title slide", skipped: true, speakerNotes: "",
      elements: [{ id: "new-title", placeholder: "CENTERED_TITLE", text: "" }],
    });
    expect(providerFetches.filter(url => url.pathname.includes("/pages/"))).toEqual([]);
    expect((await session.getPresentation()).slides.map(s => [s.id, s.index, s.skipped]))
      .toEqual([["s1", 0, false], ["new", 1, true], ["s2", 2, true]]);
    await expect(Promise.resolve(session.getSlideThumbnail("new")))
      .rejects.toThrow('Slide "new" is a new slide awaiting approval');
  });

  // A picture's `contentUrl` acts as the account that read it for 30 minutes, so no read asks
  // for it, and one Google sent anyway would not be returned.
  it("reads a picture background by its size alone, never asking for its URL", async () => {
    let picture = { stretchedPictureFill: { contentUrl: IMAGE_URL, size: {} } };
    deck = presentation([
      slide("s1", [shape("t1", text(["Intro"]), { placeholder: "TITLE" })], { background: picture }),
      slide("s2", []),
    ]);
    deck.masters![0].pageProperties!.pageBackgroundFill = picture;
    let { session } = newSession();
    using _session = session;

    let info = await session.getPresentation();
    let [read] = await session.getSlides(["s1"]);

    let masks = providerFetches.map(url => url.searchParams.get("fields") ?? "");
    expect(masks).toHaveLength(3);
    for (let mask of masks) {
      expect(mask).toContain("stretchedPictureFill(size)");
      expect(mask).not.toContain("contentUrl");
      // A parent field with no sub-mask returns everything under it, the picture's URL included.
      expect(mask).not.toMatch(/(pageProperties|pageBackgroundFill|stretchedPictureFill)(?!\()/);
      expect(mask.replaceAll("stretchedPictureFill(size)", "")).not.toContain("stretchedPictureFill");
    }
    expect(info.masters.map(m => m.background)).toEqual(["picture"]);
    expect(info.slides.map(s => s.background)).toEqual(["picture", undefined]);
    expect(read.background).toBe("picture");
    expect(JSON.stringify([info, read])).not.toContain("googleusercontent");
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

const SLIDES_PATTERN = "https://docs.google.com/presentation/d/:presentationId/*";
/** Google's own words for refusing an Office file, which nothing of ours may repeat. */
const OFFICE_REFUSAL =
  "This operation is not supported for this document. The document must not be an Office file.";

/**
 * Stands in for Google while a presentation is created and then described: Slides opens it or
 * refuses it as it refuses an Office file, and Drive reports `drive`'s type or fails.
 */
function officeProvider(slides: "opens" | "refuses", drive: { mimeType: string } | "fails") {
  let driveRequests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    if (url.hostname === "slides.googleapis.com" && request.method === "POST") {
      return Response.json({ presentationId: "office-deck" });
    }
    if (url.hostname === "slides.googleapis.com") {
      if (slides === "opens") return Response.json({ presentationId: "office-deck", title: "Pitch" });
      return Response.json(
        { error: { code: 400, status: "FAILED_PRECONDITION", message: OFFICE_REFUSAL } }, { status: 400 });
    }
    if (url.hostname === "www.googleapis.com") {
      driveRequests.push(url);
      if (drive === "fails") return Response.json({ error: { code: 500 } }, { status: 500 });
      return Response.json({ id: "office-deck", name: "Pitch.pptx", mimeType: drive.mimeType });
    }
    throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
  }));
  return driveRequests;
}

/** A presentation binding on the real Slides gatekeeper, reached as the overseer reaches it. */
async function boundPresentation(facet: string) {
  let hooks = env.TEST_HOOKS.getByName("hooks");
  await hooks.createResource(facet, SLIDES_PATTERN, "Pitch");
  await hooks.applyCreation(facet);
  await hooks.adoptCreated(facet);
  return hooks;
}

describe("Google Slides describe() of an Office file", () => {
  it("explains a refusal of a file Drive reports as an Office presentation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let driveRequests = officeProvider("refuses", {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    let hooks = await boundPresentation("slides-office");

    let error = await Promise.resolve(hooks.describe("slides-office")).catch((value: Error) => value);

    expect((error as Error).message).toBe(officeFileError("slides").message);
    expect((error as Error).message).not.toContain(OFFICE_REFUSAL);
    expect(driveRequests.map(url => url.pathname)).toEqual(["/drive/v3/files/office-deck"]);
  });

  it("keeps Google's status for a native presentation, or when Drive cannot say", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    officeProvider("refuses", { mimeType: "application/vnd.google-apps.presentation" });
    let hooks = await boundPresentation("slides-office-native");
    await expect(Promise.resolve(hooks.describe("slides-office-native")))
      .rejects.toThrow("Google Slides get title failed [http=400]");

    officeProvider("refuses", "fails");
    await expect(Promise.resolve(hooks.describe("slides-office-native")))
      .rejects.toThrow("Google Slides get title failed [http=400]");
  });

  it("describes a native presentation without asking Drive", async () => {
    let driveRequests = officeProvider("opens", { mimeType: "application/vnd.google-apps.presentation" });
    let hooks = await boundPresentation("slides-native");

    expect(await hooks.describe("slides-native")).toMatchObject({ title: "Pitch" });
    expect(driveRequests).toEqual([]);
  });
});

// The bytes a drawing of a slide needs beside its model, which reach a frame with no network
// through the session.
describe("Google Slides preview pictures and fonts", () => {
  const PLACED = {
    size: { width: { magnitude: 3_048_000, unit: "EMU" }, height: { magnitude: 1_270_000, unit: "EMU" } },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU" },
  } as const;
  let themeReads = () => providerFetches.filter(url => url.searchParams.get("fields") === THEME_FIELDS).length;
  beforeEach(() => {
    deck = presentation([
      slide("s1", [
        { objectId: "pic", ...PLACED, image: { contentUrl: `${PICTURE_URL}=s4000` } },
        { ...shape("t1", text([{ content: "Title", style: { fontFamily: "Oxygen", bold: true } }])), ...PLACED },
      ]),
    ]);
  });
  let reads = (queue: TestApprovalQueue) => queue.observations.map(({ title }) => title);

  it("reads a picture a drawing named with its longer side as long as it is drawn, with no credentials, as a read of its own", async () => {
    let { queue, session } = newSession();
    using _session = session;
    let { slides: [{ drawing }] } = await session.readSlideDrawings(["s1"]);
    expect(drawing!.elements[0]).toMatchObject({ kind: "picture", pictureId: "pic" });
    expect(JSON.stringify(drawing)).not.toContain("googleusercontent");

    let picture = await session.readPicture("pic", "s1");

    expect(picture.mimeType).toBe("image/png");
    expect(picture.bytes.byteLength).toBe(24);
    // A third of the slide's width, so fetched at a third of the pixels a slide is drawn across.
    expect(pictureRequests.map(request => request.url)).toEqual([`${PICTURE_URL}=s600`]);
    expect(pictureRequests[0].headers.get("Authorization")).toBeNull();
    // The drawing told of the picture, not its bytes: their read is authorized and reported.
    expect(reads(queue)).toEqual(["Read one Google Slides slide as drawn", "Read Google Slides pictures"]);
  });

  // The image host's size bounds the longer side, so a tall picture, or one shown in part, is
  // asked for larger than its box is wide.
  it.each([
    ["taller than wide", { size: { width: { magnitude: 1_270_000, unit: "EMU" }, height: { magnitude: 3_048_000, unit: "EMU" } } }, 600],
    ["cropped to its middle half", { image: { contentUrl: `${PICTURE_URL}=s4000`, imageProperties: { cropProperties: { leftOffset: .25, rightOffset: .25 } } } }, 1100],
  ] as const)("fetches a picture %s large enough for how it is drawn", async (_, change, pixels) => {
    Object.assign(deck.slides![0].pageElements![0], change);
    let { session } = newSession();
    using _session = session;

    await session.readPicture("pic", "s1");

    expect(pictureRequests.map(request => request.url)).toEqual([`${PICTURE_URL}=s${pixels}`]);
  });

  it("reads a picture a master puts behind its slides once named, whichever slide it is asked for", async () => {
    deck = { ...presentation([slide("s1", []), slide("s2", [])]), masters: [{
      objectId: "m", pageElements: [{ objectId: "logo", ...PLACED, image: { contentUrl: `${PICTURE_URL}=s4000` } }],
    }] };
    for (let page of deck.slides!) page.slideProperties = { ...page.slideProperties, masterObjectId: "m" };
    let { queue, session } = newSession();
    using _session = session;
    let { slides, shared } = await session.readSlideDrawings(["s1", "s2"]);
    expect(shared).toHaveLength(1);
    expect(slides.map(({ drawing }) => drawing!.behind)).toEqual([[0], [0]]);
    expect(shared[0][0]).toMatchObject({ kind: "picture", pictureId: "logo", from: "master" });

    await session.readPicture("logo", "s2");

    expect(pictureRequests).toHaveLength(1);
    expect(reads(queue)).toEqual(["Read 2 Google Slides slides as drawn", "Read Google Slides pictures"]);
  });

  // The masters and layouts are some hundreds of KiB, and a deck is drawn a few slides at a time.
  it.each([["an editor", "rev-1"], ["a viewer, who is told no revision", undefined]])(
    "reads the masters and layouts once for the reads that draw a deck for %s", async (_, revisionId) => {
      deck = { ...deck, slides: [...deck.slides!, slide("s2", [])], ...(revisionId ? { revisionId } : {}) };
      let { session } = newSession();
      using _session = session;

      await session.readSlideDrawings(["s1"]);
      await session.readSlideDrawings(["s2"]);

      expect(themeReads()).toBe(1);
    },
  );

  it("reads the masters and layouts again once an editor's presentation has changed", async () => {
    deck = { ...deck, revisionId: "rev-1" };
    let { session } = newSession();
    using _session = session;
    await session.readSlideDrawings(["s1"]);
    deck = { ...deck, revisionId: "rev-2" };

    await session.readSlideDrawings(["s1"]);

    expect(themeReads()).toBe(2);
  });

  it("reads the slide again, as a read, for a picture whose address has lapsed", async () => {
    let { queue, session } = newSession();
    using _session = session;
    await session.readSlideDrawings(["s1"]);
    pictureFailures = [403];

    let picture = await session.readPicture("pic", "s1");

    expect(picture.mimeType).toBe("image/png");
    expect(pictureRequests).toHaveLength(2);
    expect(reads(queue)).toEqual(["Read one Google Slides slide as drawn", "Read Google Slides pictures", "Read Google Slides pictures"]);
  });

  it("fetches a picture's bytes inside its read, so a binding that the file leaves meanwhile refuses them", async () => {
    // As a folder binding's check after the fetch refuses a file moved out during it.
    let { session } = newSession(read => (fetch, observe) => read(async () => {
      let value = await fetch();
      if (pictureRequests.length > 0) throw new Error("The requested file is outside this Drive binding.");
      return value;
    }, observe));
    using _session = session;
    await session.readSlideDrawings(["s1"]);

    await expect(Promise.resolve(session.readPicture("pic", "s1"))).rejects.toThrow("outside this Drive binding");

    expect(pictureRequests).toHaveLength(1);
  });

  it.each([429, 500, 503])("fails a picture Google answers %i for, without reading the slide again", async status => {
    let { queue, session } = newSession();
    using _session = session;
    await session.readSlideDrawings(["s1"]);
    pictureFailures = [status];

    await expect(Promise.resolve(session.readPicture("pic", "s1"))).rejects.toThrow(`Google did not serve this picture [http=${status}]`);

    expect(pictureRequests).toHaveLength(1);
    expect(reads(queue)).toEqual(["Read one Google Slides slide as drawn", "Read Google Slides pictures"]);
  });

  it("reports the read of a picture no drawing named in this session, and refuses one the presentation does not show", async () => {
    let { queue, session } = newSession();
    using _session = session;

    await session.readPicture("pic", "s1");
    await expect(Promise.resolve(session.readPicture("other", "s1"))).rejects.toThrow('names a picture "other"');
    await expect(Promise.resolve(session.readPicture("pic", "missing"))).rejects.toThrow('No slide with ID "missing"');

    expect(reads(queue)).toEqual(["Read Google Slides pictures", "Read Google Slides pictures", "Read Google Slides pictures"]);
    expect(pictureRequests).toHaveLength(1);
  });

  it("lists the fonts the text is set in, and reads one of them from Google Fonts by its name alone", async () => {
    let { queue, session } = newSession();
    using _session = session;

    let fonts = await session.listFonts();
    let font = await session.readFont("Oxygen", 700, false);

    expect(fonts.find(({ family }) => family === "Oxygen")).toMatchObject({ weights: expect.arrayContaining([700]) });
    expect([...font]).toEqual([...FONT]);
    expect(fontRequests).toEqual(["Oxygen:ital,wght@0,700"]);
    expect(reads(queue)).toEqual(["Read Google Slides fonts"]);
  });

  it("refuses a font the presentation does not name, or that is no font's name, without asking Google Fonts", async () => {
    let { session } = newSession();
    using _session = session;

    for (let [family, weight] of [["Lobster", 400], ["Oxygen&family=Lobster", 400], ["Oxygen", 450]] as const) {
      await expect(Promise.resolve(session.readFont(family, weight, false))).rejects
        .toThrow(`the presentation names no font "${family}" that Google Fonts could serve at that weight`);
    }

    expect(fontRequests).toEqual([]);
  });

  it("says so when Google Fonts does not serve the font", async () => {
    deck = presentation([slide("s1", [shape("t1", text([{ content: "T", style: { fontFamily: "Arial" } }]))])]);
    let { session } = newSession();
    using _session = session;

    await expect(Promise.resolve(session.readFont("Arial", 400, false))).rejects.toThrow('Google Fonts does not serve "Arial"');
  });
});

// A freeform's outline and a preset's dragged handles are in no read of the Slides API, so the
// read of a drawing takes them from Drive's PowerPoint export of the same presentation.
describe("Google Slides shapes the API reports no outline for", () => {
  const EMU = 12_700;
  let placed = (objectId: string, shapeType: string, x: number): RestPageElement => ({
    objectId, shape: { shapeType },
    size: { width: { magnitude: 100 * EMU, unit: "EMU" }, height: { magnitude: 50 * EMU, unit: "EMU" } },
    transform: { scaleX: 1, scaleY: 1, translateX: x * EMU, translateY: 20 * EMU, unit: "EMU" },
  });
  let exported = (geometry: string, x: number) =>
    drawnShape({ properties: transform(x * EMU, 20 * EMU, 100 * EMU, 50 * EMU) + geometry });
  const FREEFORM = '<a:custGeom><a:pathLst><a:path w="100" h="50"><a:moveTo><a:pt x="0" y="50"/></a:moveTo>' +
    '<a:lnTo><a:pt x="50" y="0"/></a:lnTo><a:lnTo><a:pt x="100" y="50"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>';
  const ARC = '<a:prstGeom prst="blockArc"><a:avLst><a:gd name="adj1" fmla="val 10800000"/>' +
    '<a:gd name="adj2" fmla="val 5400000"/><a:gd name="adj3" fmla="val 8425"/></a:avLst></a:prstGeom>';
  let pptx = () => buildDeck({ slides: [
    { shapes: exported('<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', 0) + exported(FREEFORM, 120) + exported(ARC, 240) },
    { shapes: "" },
  ] });
  beforeEach(() => {
    deck = { ...presentation([
      slide("s1", [placed("box", "RECTANGLE", 0), placed("free", "CUSTOM", 120), placed("arc", "BLOCK_ARC", 240)]),
      slide("s2", [placed("plain", "ELLIPSE", 0)]),
    ]), revisionId: "rev-1" };
    exportOf = async () => new Response(await pptx());
  });
  let shapesOf = async (session: ReturnType<typeof newSession>["session"], id = "s1") =>
    (await session.readSlideDrawings([id])).slides[0].drawing!.elements;

  it("draws them from Drive's export of the presentation, within the read of the drawing", async () => {
    let { queue, session } = newSession();
    using _session = session;

    let [box, free, arc] = await shapesOf(session);

    expect(free).toMatchObject({ shapeType: "CUSTOM", paths: [{ width: 100, height: 50, ops: "MLLZ", points: [0, 50, 50, 0, 100, 50] }] });
    expect(arc).toMatchObject({ shapeType: "BLOCK_ARC", adjust: [10_800_000, 5_400_000, 8425] });
    expect(box).not.toHaveProperty("adjust");
    expect(exportRequests).toHaveLength(1);
    expect(new URL(exportRequests[0].url).searchParams.get("mimeType")).toBe(PPTX_MIME_TYPE);
    expect(exportRequests[0].headers.get("Authorization")).toBe("Bearer access-token");
    expect(queue.observations.map(({ title }) => title)).toEqual(["Read one Google Slides slide as drawn"]);
  });

  // Each shape is held to where the API puts it now, so the export of a moment ago still serves.
  it("asks Drive for the export once, and not again for each change an editor makes", async () => {
    let { session } = newSession();
    using _session = session;

    await shapesOf(session);
    await shapesOf(session);
    deck = { ...deck, revisionId: "rev-2" };

    expect((await shapesOf(session))[1]).toHaveProperty("paths");
    expect(exportRequests).toHaveLength(1);
  });

  it("asks Drive once, and reads no token again, for an account Drive refuses or a Drive that fails", async () => {
    let tokens: unknown[] = [];
    for (let status of [403, 503]) {
      exportOf = () => new Response(null, { status });
      let queue = new RpcStub(new TestApprovalQueue());
      using session = new RpcStub(new GooglePresentationSessionImpl(
        new GoogleSlidesApi(async request => {
          tokens.push(request);
          return "access-token";
        }), "deck-1", queue,
        unguardedNativeRead(description => queue.authorizeObservation(description), [{ kind: "presentation", fileId: "deck-1" }]),
        { snapshot: read => read([]), queue: () => Promise.reject(new Error("Unexpected change")) },
      ));

      expect((await session.readSlideDrawings(["s1"])).slides[0].drawing!.elements[1]).not.toHaveProperty("paths");
    }

    expect(exportRequests).toHaveLength(2);
    expect(tokens.every(request => request === undefined)).toBe(true);
  });

  it("asks for no export to draw slides that hold no such shape", async () => {
    let { session } = newSession();
    using _session = session;

    expect(await shapesOf(session, "s2")).toHaveLength(1);

    expect(exportRequests).toEqual([]);
  });

  it.each([
    ["Drive refuses it, as it does an account that granted no access to Drive's files", () => new Response(null, { status: 403 })],
    ["it is larger than is read", () => new Response(new Uint8Array(MAX_EXPORT_BYTES + 1))],
    ["it is no PowerPoint file", () => new Response("<!doctype html><title>Sign in</title>")],
    ["it is of another number of slides", async () => new Response(await buildDeck({ slides: [{ shapes: exported(FREEFORM, 120) }] }))],
  ] as const)("still draws the slide, those shapes with no outline, when %s", async (_, answer) => {
    exportOf = answer;
    let { queue, session } = newSession();
    using _session = session;

    let [box, free, arc] = await shapesOf(session);

    expect(box).toMatchObject({ shapeType: "RECTANGLE" });
    expect(free).toMatchObject({ shapeType: "CUSTOM", bounds: { x: 120, y: 20, width: 100, height: 50 } });
    expect(free).not.toHaveProperty("paths");
    expect(arc).not.toHaveProperty("adjust");
    // That is how it will stay: nothing is said to be on its way.
    expect((await session.readSlideDrawings(["s1"])).slides[0]).not.toHaveProperty("outlinesPending");
    // Nor asked for again by the next read.
    await shapesOf(session);
    expect(exportRequests).toHaveLength(1);
    expect(queue.observations).toHaveLength(3);
  });

  it("says which slides' outlines are still on their way when Drive is slow, and has them for a read once it has answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let arrive!: (response: Response) => void;
    exportOf = () => new Promise(resolve => { arrive = resolve; });
    let { session } = newSession(undefined, [{ id: 1, action: { kind: "duplicateSlide", payload: {
      slideId: "s1", newSlideId: "copy", objectIds: { box: "box-2", free: "free-2", arc: "arc-2" }, slide: { number: 1 },
    } } }]);
    using _session = session;

    let state = { done: false };
    let read = Promise.resolve(session.readSlideDrawings(["s1", "s2", "copy"])).finally(() => { state.done = true; });
    while (!state.done) await vi.advanceTimersByTimeAsync(1000);
    let { slides: [first, second, copied] } = await read;

    // The read did not wait for it past its few seconds; the slide with no such shape waits for nothing.
    expect(first).toMatchObject({ slideId: "s1", outlinesPending: true });
    expect(first.drawing!.elements[1]).not.toHaveProperty("paths");
    expect(second).not.toHaveProperty("outlinesPending");
    // A queued copy of the slide holds the same shape, and waits with it.
    expect(copied).toMatchObject({ slideId: "copy", outlinesPending: true });

    arrive(new Response(await pptx()));
    let { slides: [again] } = await session.readSlideDrawings(["s1"]);
    vi.useRealTimers();

    expect(again).not.toHaveProperty("outlinesPending");
    expect(again.drawing!.elements[1]).toHaveProperty("paths");
    expect(again.drawing!.elements[2]).toHaveProperty("adjust");
    expect(exportRequests).toHaveLength(1);
  });
});
