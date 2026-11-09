import { readBytesCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { readGoogleJson } from "./google-response";
import {
  LAYOUT_PAGE_FIELDS, OUTLINE_FIELDS, PREVIEW_OUTLINE_FIELDS, PREVIEW_SLIDE_FIELDS, SLIDE_FIELDS,
  SUMMARY_FIELDS,
} from "./slides-fields";
import BLANK_RECORDING from "./blank-presentation.json";
import { styledPlaceholder } from "./slides-blank-theme";

const API_BASE = "https://slides.googleapis.com/v1/presentations";
// 10 MiB matches the Docs bound for a document body.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
// A slide is read on its own; a text-heavy live slide is about 50 KiB with all its styles.
const MAX_SLIDE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

// A thumbnail response is a URL and two numbers.
const MAX_THUMBNAIL_RESPONSE_BYTES = 16 * 1024;
// A 1600-pixel PNG of a photo-heavy slide runs to a few MiB; a text slide is about 150 KiB.
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const CONTENT_HOST_SUFFIX = ".googleusercontent.com";
// An uploaded picture's `contentUrl` is on Docs, which redirects it once to the image host.
const IMAGE_REDIRECT_HOST = "docs.google.com";
// The image host's size suffix, ending the path: `=s2048` serves the picture at most 2048 wide.
const IMAGE_SIZE_SUFFIX = /=s\d+$/;
// Asked of the image host with a size: JPEG quality 85, a quarter smaller than its default and no
// different to see on a slide. A PNG is served as it is.
const IMAGE_QUALITY_OPTION = "-l85";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// The picture formats a preview inlines, by their first bytes. Anything else, SVG included, is not.
const IMAGE_SIGNATURES: { mediaType: string; at: number; bytes: number[] }[] = [
  { mediaType: "image/png", at: 0, bytes: PNG_SIGNATURE },
  { mediaType: "image/jpeg", at: 0, bytes: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", at: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: "image/webp", at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
];

/** A `Dimension`; Slides reports sizes in EMU or points. */
export type RestDimension = { magnitude?: number; unit?: "EMU" | "PT" | "UNIT_UNSPECIFIED" };

/** An `AffineTransform`; Google omits each field that is 0. */
export type RestTransform = {
  scaleX?: number; scaleY?: number; shearX?: number; shearY?: number;
  translateX?: number; translateY?: number; unit?: "EMU" | "PT" | "UNIT_UNSPECIFIED";
};

/** An `OpaqueColor`: an RGB colour or a theme colour. */
export type RestOpaqueColor = {
  rgbColor?: { red?: number; green?: number; blue?: number }; themeColor?: string;
};

/** An `OptionalColor`, as text takes it: opaque when it has a colour, transparent when it has none. */
export type RestColor = { opaqueColor?: RestOpaqueColor };

/** A `TextStyle`. A field Google leaves unset is inherited. */
export type RestTextStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  smallCaps?: boolean;
  fontFamily?: string;
  weightedFontFamily?: { fontFamily?: string; weight?: number };
  fontSize?: RestDimension;
  foregroundColor?: RestColor;
  backgroundColor?: RestColor;
  link?: { url?: string; slideIndex?: number; pageObjectId?: string; relativeLink?: string };
  baselineOffset?: string;
};

/** A `ParagraphStyle`. A field Google leaves unset is inherited. */
export type RestParagraphStyle = {
  alignment?: string;
  lineSpacing?: number;
  spaceAbove?: RestDimension;
  spaceBelow?: RestDimension;
  indentStart?: RestDimension;
  indentEnd?: RestDimension;
  indentFirstLine?: RestDimension;
  direction?: string;
  spacingMode?: string;
};

/** A paragraph's `Bullet`, present when the paragraph is in a list. */
export type RestBullet = {
  listId?: string; nestingLevel?: number; glyph?: string; bulletStyle?: RestTextStyle;
};

/** One `TextElement` of a shape's or table cell's `TextContent`. */
export type RestTextElement = {
  startIndex?: number;
  endIndex?: number;
  paragraphMarker?: { style?: RestParagraphStyle; bullet?: RestBullet };
  textRun?: { content?: string; style?: RestTextStyle };
  autoText?: { type?: string; content?: string; style?: RestTextStyle };
};

/** A `TextContent`. `lists` holds the lists its bullets name, which replay carries unread. */
export type RestText = { textElements?: RestTextElement[]; lists?: Record<string, unknown> };

/** A `SolidFill`. */
export type RestSolidFill = { color?: RestOpaqueColor; alpha?: number };

/** A fill or outline Google renders, does not render, or inherits from a placeholder. */
export type RestPropertyState = "RENDERED" | "NOT_RENDERED" | "INHERIT";

/** An `Outline` of a shape or picture. */
export type RestOutline = {
  propertyState?: RestPropertyState;
  outlineFill?: { solidFill?: RestSolidFill };
  weight?: RestDimension;
  dashStyle?: string;
};

/** A `Shadow`: `transform` offsets it, and `color` omits a zero component, so black is `{}`. */
export type RestShadow = {
  propertyState?: RestPropertyState;
  type?: string;
  transform?: RestTransform;
  alignment?: string;
  blurRadius?: RestDimension;
  color?: RestOpaqueColor;
  alpha?: number;
  rotateWithShape?: boolean;
};

/** A picture's `CropProperties`: each offset a fraction of its width or height. */
export type RestCropProperties = {
  leftOffset?: number; rightOffset?: number; topOffset?: number; bottomOffset?: number;
  angle?: number;
};

/** A shape's `ShapeProperties`, as far as the gatekeeper reads them. */
export type RestShapeProperties = {
  shapeBackgroundFill?: { propertyState?: RestPropertyState; solidFill?: RestSolidFill };
  outline?: RestOutline;
  shadow?: RestShadow;
  contentAlignment?: string;
  autofit?: { autofitType?: string; fontScale?: number; lineSpacingReduction?: number };
};

/** A table cell's `TableCellProperties`. */
export type RestTableCellProperties = {
  tableCellBackgroundFill?: { propertyState?: RestPropertyState; solidFill?: RestSolidFill };
  contentAlignment?: string;
};

/** A `TableCellLocation`; Google omits a zero index. */
export type RestCellLocation = { rowIndex?: number; columnIndex?: number };

/** A cell edge's `TableBorderProperties`. */
export type RestBorderProperties = {
  tableBorderFill?: { solidFill?: RestSolidFill }; weight?: RestDimension; dashStyle?: string;
};

/** One row of a table's cell edges: the edges along one line of the grid. */
export type RestBorderRow = {
  tableBorderCells?: { location?: RestCellLocation; tableBorderProperties?: RestBorderProperties }[];
};

/** The end of a line attached to an element's connection site. */
export type RestLineConnection = { connectedObjectId?: string; connectionSiteIndex?: number };

/** A line's `LineProperties`, as far as the gatekeeper reads them. */
export type RestLineProperties = {
  lineFill?: { solidFill?: RestSolidFill };
  weight?: RestDimension;
  dashStyle?: string;
  startArrow?: string;
  endArrow?: string;
  startConnection?: RestLineConnection;
  endConnection?: RestLineConnection;
};

/** A `PageElement`, as far as the gatekeeper reads one. */
export type RestPageElement = {
  objectId?: string;
  size?: { width?: RestDimension; height?: RestDimension };
  transform?: RestTransform;
  title?: string;
  description?: string;
  shape?: {
    shapeType?: string;
    /** Google omits `index` when it is 0; `parentObjectId` is the layout placeholder it inherits from. */
    placeholder?: { type?: string; index?: number; parentObjectId?: string };
    text?: RestText;
    shapeProperties?: RestShapeProperties;
  };
  table?: {
    rows?: number;
    columns?: number;
    tableColumns?: { columnWidth?: RestDimension }[];
    tableRows?: {
      rowHeight?: RestDimension;
      tableCells?: {
        location?: RestCellLocation;
        rowSpan?: number;
        columnSpan?: number;
        text?: RestText;
        tableCellProperties?: RestTableCellProperties;
      }[];
    }[];
    horizontalBorderRows?: RestBorderRow[];
    verticalBorderRows?: RestBorderRow[];
  };
  elementGroup?: { children?: RestPageElement[] };
  /**
   * `contentUrl` is a bearer URL, good for 30 minutes to anyone holding it. Only the approver's
   * preview reads it, to download the picture from Google's image host (`downloadContentImage`);
   * it is never returned or logged. A chart's is never read.
   */
  image?: {
    sourceUrl?: string;
    contentUrl?: string;
    imageProperties?: {
      cropProperties?: RestCropProperties;
      transparency?: number;
      outline?: RestOutline;
      shadow?: RestShadow;
    };
  };
  video?: { source?: string; id?: string; url?: string };
  /** A freehand line has no `lineType`, and nothing a read gives describes its path. */
  line?: { lineType?: string; lineCategory?: string; lineProperties?: RestLineProperties };
  sheetsChart?: { spreadsheetId?: string; chartId?: number };
  wordArt?: { renderedText?: string };
  speakerSpotlight?: unknown;
};

/** A `Page` of any kind, as far as its elements. */
export type RestPage = { objectId?: string; pageElements?: RestPageElement[] };

/**
 * A page's `pageBackgroundFill`. A request sets `contentUrl` to the picture Google downloads; a
 * read carries Google's own copy's, a bearer URL, only if its mask asks for it, as only the
 * approver's preview does.
 */
export type RestPageBackgroundFill = {
  propertyState?: RestPropertyState;
  solidFill?: RestSolidFill;
  stretchedPictureFill?: {
    contentUrl?: string; size?: { width?: RestDimension; height?: RestDimension };
  };
};

/** One of a theme's colours. Google holds it as a bare `RgbColor`, omitting a zero component. */
export type RestThemeColorPair = {
  type?: string; color?: { red?: number; green?: number; blue?: number };
};

/** A page's `PageProperties`. Only a master has a `colorScheme`. */
export type RestPageProperties = {
  pageBackgroundFill?: RestPageBackgroundFill;
  colorScheme?: { colors?: RestThemeColorPair[] };
};

/**
 * A master or layout `Page`. `pageType` is not Google's, which is not requested: it names the
 * list the page came from.
 */
export type RestThemePage = {
  objectId?: string;
  pageType: "MASTER" | "LAYOUT";
  masterProperties?: { displayName?: string };
  layoutProperties?: { displayName?: string; masterObjectId?: string };
  pageProperties?: RestPageProperties;
  pageElements?: RestPageElement[];
};

/** A slide `Page`. */
export type RestSlide = {
  objectId?: string;
  pageProperties?: RestPageProperties;
  pageElements?: RestPageElement[];
  slideProperties?: {
    layoutObjectId?: string;
    masterObjectId?: string;
    isSkipped?: boolean;
    notesPage?: {
      notesProperties?: { speakerNotesObjectId?: string };
      pageElements?: RestPageElement[];
    };
  };
};

/** The fields of a `Presentation` the gatekeeper requests. */
export type RestPresentation = {
  presentationId: string;
  title?: string;
  locale?: string;
  revisionId?: string;
  pageSize?: { width?: RestDimension; height?: RestDimension };
  masters?: Omit<RestThemePage, "pageType">[];
  layouts?: Omit<RestThemePage, "pageType">[];
  slides?: RestSlide[];
};

/** A `batchUpdate` Google answered with a 4xx status, so it applied none of the requests. */
export class SlidesWriteRefused extends Error {
  constructor(readonly status: number) {
    super(`Google Slides refused the update [http=${status}]`);
  }
}

/** A thumbnail size, named by Google for the width it renders: 200, 800 or 1600 pixels. */
export type ThumbnailSize = "SMALL" | "MEDIUM" | "LARGE";

/** A rendered page: PNG bytes and their dimensions in pixels. */
export type PageThumbnail = { width: number; height: number; content: ArrayBuffer };

// `contentUrl` is a bearer URL: anyone holding it sees the image as the account that asked, for
// 30 minutes. So it is fetched only from Google's hosts, and never returned or logged.
function googleContentUrl(contentUrl: string | undefined, what: string, redirectHost?: string): URL {
  let url = URL.parse(contentUrl ?? "");
  let host = url?.hostname ?? "";
  if (url?.protocol !== "https:" || !(host.endsWith(CONTENT_HOST_SUFFIX) || host === redirectHost)) {
    throw new Error(`Google Slides returned an unexpected ${what} location`);
  }
  return url;
}

/**
 * Fetches a `contentUrl` from Google's image host, at most `maxBytes` of it. No credentials: the
 * URL itself is the authority. A redirect is followed only from `IMAGE_REDIRECT_HOST` to the image
 * host, as no other could keep it on Google's; there, `resize` may rewrite the URL first.
 */
async function downloadContent(
  url: URL, maxBytes: number, what: string, resize: (url: URL) => URL = url => url,
): Promise<Uint8Array> {
  let get = (from: URL) => fetch(from, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  let response = await get(url.hostname === IMAGE_REDIRECT_HOST ? url : resize(url));
  if (url.hostname === IMAGE_REDIRECT_HOST && response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    let location = URL.parse(response.headers.get("location") ?? "", url.href);
    response = await get(resize(googleContentUrl(location?.href, what)));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Google Slides ${what} download failed [http=${response.status}]`);
  }
  return readBytesCapped(response, maxBytes);
}

/**
 * Downloads the picture an image element's `contentUrl` names, if it is on Google's hosts, at
 * most `maxBytes` long, and a PNG, JPEG, GIF or WebP by its own first bytes. Throws otherwise.
 * Where the image host can resize it, it is fetched at most `pixels` wide.
 */
export async function downloadContentImage(
  contentUrl: string, maxBytes: number, pixels: number,
): Promise<{ mediaType: string; content: Uint8Array }> {
  let resize = (url: URL) => {
    if (!IMAGE_SIZE_SUFFIX.test(url.pathname)) return url;
    let sized = new URL(url);
    sized.pathname = url.pathname.replace(IMAGE_SIZE_SUFFIX, `=s${Math.round(pixels)}${IMAGE_QUALITY_OPTION}`);
    return sized;
  };
  let content = await downloadContent(
    googleContentUrl(contentUrl, "image", IMAGE_REDIRECT_HOST), maxBytes, "image", resize,
  );
  let format = IMAGE_SIGNATURES.find(({ at, bytes }) =>
    content.byteLength >= at + bytes.length && bytes.every((byte, i) => content[at + i] === byte));
  if (!format) throw new Error("Google Slides returned an image of an unsupported format");
  return { mediaType: format.mediaType, content };
}

// The dimensions come from the image's own header: Google's reported height has been seen to
// differ from the image it serves by a pixel.
function pngDimensions(content: Uint8Array): { width: number; height: number } {
  let view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let isPng = content.byteLength >= 24 &&
    PNG_SIGNATURE.every((byte, i) => content[i] === byte) &&
    new TextDecoder().decode(content.subarray(12, 16)) === "IHDR";
  if (!isPng) throw new Error("Google Slides returned a thumbnail that is not a PNG");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pagePath(presentationId: string, pageId: string): string {
  return `${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageId)}`;
}

export class GoogleSlidesApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #send<T>(url: URL, init: RequestInit, operation: string, maxBytes: number): Promise<T> {
    let response = await fetchWithAuthRetry(
      url.toString(), init, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    return readGoogleJson<T>(response, { provider: "Google Slides", operation, maxBytes });
  }

  async #get<T>(
    path: string, params: Record<string, string>, operation: string, maxBytes = MAX_RESPONSE_BYTES,
  ): Promise<T> {
    let url = new URL(`${API_BASE}/${path}`);
    for (let [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return this.#send<T>(url, {}, operation, maxBytes);
  }

  /** Create a presentation titled `title` in the caller's My Drive, returning its ID. */
  async createPresentation(title: string): Promise<string> {
    let url = new URL(API_BASE);
    url.searchParams.set("fields", "presentationId");
    let { presentationId } = await this.#send<{ presentationId?: unknown }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }, "create presentation", MAX_RESPONSE_BYTES);
    if (typeof presentationId !== "string" || presentationId.length === 0) {
      throw new Error("Google Slides returned no presentation ID");
    }
    return presentationId;
  }

  async #presentation(
    presentationId: string, fields: string, operation: string,
  ): Promise<RestPresentation> {
    let result = await this.#get<RestPresentation>(
      encodeURIComponent(presentationId), { fields }, operation);
    if (result.presentationId !== presentationId) {
      throw new Error("Google Slides returned a different presentation");
    }
    return result;
  }

  /** Fetch what summaries need: the masters, the layouts, and each slide's shape and notes text. */
  getPresentation(presentationId: string): Promise<RestPresentation> {
    return this.#presentation(presentationId, SUMMARY_FIELDS, "get presentation");
  }

  /** Fetch only a presentation's title, which also proves the caller can open it. */
  async getPresentationTitle(presentationId: string): Promise<string | undefined> {
    return (await this.#presentation(presentationId, "presentationId,title", "get title")).title;
  }

  /** Fetch a presentation's title, masters, layouts and slide IDs, but no slide content. */
  getOutline(presentationId: string): Promise<RestPresentation> {
    return this.#presentation(presentationId, OUTLINE_FIELDS, "get outline");
  }

  /**
   * Fetch what the approver's preview draws slides over: the outline, the page size, and every
   * master and layout with its elements.
   */
  getPreviewOutline(presentationId: string): Promise<RestPresentation> {
    return this.#presentation(presentationId, PREVIEW_OUTLINE_FIELDS, "get preview outline");
  }

  /** Fetch one slide's content, whatever the size of the rest of the presentation. */
  async getSlide(presentationId: string, slideId: string, fields = SLIDE_FIELDS): Promise<RestSlide> {
    let slide = await this.#get<RestSlide>(
      pagePath(presentationId, slideId), { fields }, "get slide", MAX_SLIDE_BYTES);
    if (slide.objectId !== slideId) throw new Error("Google Slides returned a different slide");
    return slide;
  }

  /** Fetch a layout's placeholders, as far as a slide made from it takes them. */
  async getLayout(presentationId: string, layoutId: string): Promise<RestPage> {
    let layout = await this.#get<RestPage>(
      pagePath(presentationId, layoutId), { fields: LAYOUT_PAGE_FIELDS }, "get layout", MAX_SLIDE_BYTES);
    if (layout.objectId !== layoutId) throw new Error("Google Slides returned a different layout");
    return layout;
  }

  /** Fetch full pages of the slides among `ids` that `order`, the deck's slide IDs, still has. */
  async getSlides(
    presentationId: string, ids: Iterable<string>, order: readonly string[], fields = SLIDE_FIELDS,
  ): Promise<Map<string, RestSlide>> {
    let slides = await Promise.all([...ids].filter(id => order.includes(id))
      .map(id => this.getSlide(presentationId, id, fields)));
    return new Map(slides.map(slide => [slide.objectId!, slide]));
  }

  /** As `getSlides()`, with the URL of each picture background, for the approver's preview alone. */
  getPreviewSlides(
    presentationId: string, ids: Iterable<string>, order: readonly string[],
  ): Promise<Map<string, RestSlide>> {
    return this.getSlides(presentationId, ids, order, PREVIEW_SLIDE_FIELDS);
  }

  /**
   * Render the latest version of a page as a PNG, and give the bearer URL Google serves it from,
   * which `downloadContentImage()` takes. Google counts this as an expensive read.
   */
  async getThumbnailUrl(presentationId: string, pageId: string, size: ThumbnailSize): Promise<string> {
    let { contentUrl } = await this.#get<{ contentUrl?: string }>(
      `${pagePath(presentationId, pageId)}/thumbnail`,
      { "thumbnailProperties.mimeType": "PNG", "thumbnailProperties.thumbnailSize": size },
      "get thumbnail", MAX_THUMBNAIL_RESPONSE_BYTES);
    return googleContentUrl(contentUrl, "thumbnail").href;
  }

  /** Render the latest version of a page as a PNG. Google counts this as an expensive read. */
  async getThumbnail(
    presentationId: string, pageId: string, size: ThumbnailSize,
  ): Promise<PageThumbnail> {
    let contentUrl = await this.getThumbnailUrl(presentationId, pageId, size);
    let content = await downloadContent(
      new URL(contentUrl), MAX_THUMBNAIL_BYTES, "thumbnail",
    ).catch((error: unknown) => {
      if (!(error instanceof ResponseTooLargeError)) throw error;
      throw new Error(
        `Google Slides thumbnail exceeded ${MAX_THUMBNAIL_BYTES} bytes; request a smaller size.`);
    });
    // readBytesCapped allocates an array of exactly the body's size, never a shared buffer.
    return { ...pngDimensions(content), content: content.buffer as ArrayBuffer };
  }

  /**
   * Apply `requests` together, and only while the presentation is still at `requiredRevisionId`.
   * Throws `SlidesWriteRefused` for a 4xx answer, which applied nothing; any other failure leaves
   * the outcome unknown, since the update may have been committed before the response was lost.
   */
  async batchUpdate(
    presentationId: string, requests: unknown[], requiredRevisionId: string,
  ): Promise<void> {
    let response = await fetchWithAuthRetry(
      `${API_BASE}/${encodeURIComponent(presentationId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests, writeControl: { requiredRevisionId } }),
      },
      this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (response.ok) {
      await response.body?.cancel();
      return;
    }
    // Always rejects, having logged Google's diagnostics.
    let failure = await readGoogleJson(response, {
      provider: "Google Slides", operation: "batch update", maxBytes: MAX_RESPONSE_BYTES,
    }).catch((error: unknown) => error);
    let refused = response.status >= 400 && response.status < 500;
    throw refused ? new SlidesWriteRefused(response.status) : failure;
  }
}

/** The reads the approver's preview makes. */
export type PreviewReader = Pick<GoogleSlidesApi, "getPreviewOutline" | "getPreviewSlides">;

/** The reads a presentation session makes. */
export type PresentationReader = Pick<
  GoogleSlidesApi, "getPresentation" | "getOutline" | "getSlides" | "getLayout" | "getThumbnail">;

/**
 * What a presentation session reads of a new presentation, as `scripts/record-blank-presentation.ts`
 * recorded it from Google: each read less the presentation's ID, title and revision, and each page
 * by its ID.
 */
type BlankRecording = {
  presentation: Omit<RestPresentation, "presentationId">;
  outline: Omit<RestPresentation, "presentationId">;
  slides: Record<string, RestSlide>;
  layouts: Record<string, RestPage>;
};

const BLANK = BLANK_RECORDING as BlankRecording;
// A change applies against a fresh read of the created presentation, so this never reaches Google.
const BLANK_REVISION = "blank";

/**
 * A presentation not yet created, read as the recording of a new one: the title slide and default
 * layouts Google gives every new presentation, under the same object IDs, so a change queued against
 * it applies unchanged to the presentation a user's approval creates. Makes no request. Each read
 * is a copy, since one recording serves every session in the isolate.
 */
export class BlankPresentation implements PresentationReader, PreviewReader {
  constructor(private title: string) {}

  async getPresentation(presentationId: string): Promise<RestPresentation> {
    return { ...structuredClone(BLANK.presentation), presentationId, title: this.title };
  }

  /**
   * The outline, with the page size and theme pages of the presentation read. Its layouts' elements
   * are the placeholders' geometry, as the recording holds them, and their text styles, as Simple
   * Light sets them (see `slides-blank-theme.ts`).
   */
  async getPreviewOutline(presentationId: string): Promise<RestPresentation> {
    let { pageSize, masters, layouts } = structuredClone(BLANK.presentation);
    return {
      ...await this.getOutline(presentationId),
      ...(pageSize ? { pageSize } : {}),
      ...(masters ? { masters } : {}),
      layouts: layouts?.map(page => ({
        ...page,
        pageElements: page.objectId && Object.hasOwn(BLANK.layouts, page.objectId)
          ? structuredClone(BLANK.layouts[page.objectId].pageElements ?? [])
            .map(element => styledPlaceholder(element, page.layoutProperties?.displayName))
          : [],
      })),
    };
  }

  /** With a revision, as Google reports one to the account that creates, and so can edit, it. */
  async getOutline(presentationId: string): Promise<RestPresentation> {
    return {
      ...structuredClone(BLANK.outline), presentationId, title: this.title, revisionId: BLANK_REVISION,
    };
  }

  async getSlides(
    _presentationId: string, ids: Iterable<string>, order: readonly string[],
  ): Promise<Map<string, RestSlide>> {
    return new Map([...ids].filter(id => order.includes(id) && Object.hasOwn(BLANK.slides, id))
      .map(id => [id, structuredClone(BLANK.slides[id])]));
  }

  getPreviewSlides(
    presentationId: string, ids: Iterable<string>, order: readonly string[],
  ): Promise<Map<string, RestSlide>> {
    return this.getSlides(presentationId, ids, order);
  }

  async getLayout(_presentationId: string, layoutId: string): Promise<RestPage> {
    if (!Object.hasOwn(BLANK.layouts, layoutId)) throw new Error("A new presentation has no such layout.");
    return structuredClone(BLANK.layouts[layoutId]);
  }

  async getThumbnail(): Promise<PageThumbnail> {
    throw new Error("This Google Slides presentation doesn't exist yet, so its slides can't be " +
      "rendered until a user approves its creation.");
  }
}
