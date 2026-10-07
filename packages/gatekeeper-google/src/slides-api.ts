import { readBytesCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { readGoogleJson } from "./google-response";

const API_BASE = "https://slides.googleapis.com/v1/presentations";
// Text styles dominate a presentation's JSON; 10 MiB matches the Docs bound for a document body.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

// Masters, notes masters and layout elements are deliberately not requested: they are not slide
// content, and on a template-heavy deck they are most of the response.
const PRESENTATION_FIELDS =
  "presentationId,title,locale,pageSize," +
  "layouts(objectId,layoutProperties(displayName))," +
  "slides(objectId,pageElements," +
  "slideProperties(layoutObjectId,isSkipped,notesPage(notesProperties,pageElements)))";

// A thumbnail response is a URL and two numbers.
const MAX_THUMBNAIL_RESPONSE_BYTES = 16 * 1024;
// A 1600-pixel PNG of a photo-heavy slide runs to a few MiB; a text slide is about 150 KiB.
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const THUMBNAIL_HOST_SUFFIX = ".googleusercontent.com";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A `Dimension`; Slides reports sizes in EMU or points. */
export type RestDimension = { magnitude?: number; unit?: "EMU" | "PT" | "UNIT_UNSPECIFIED" };

/** One `TextElement` of a shape's or table cell's `TextContent`. */
export type RestTextElement = {
  startIndex?: number;
  endIndex?: number;
  paragraphMarker?: unknown;
  textRun?: { content?: string };
  autoText?: { type?: string; content?: string };
};

/** A `TextContent`. */
export type RestText = { textElements?: RestTextElement[] };

/** A `PageElement`, as far as the gatekeeper reads one. */
export type RestPageElement = {
  objectId?: string;
  title?: string;
  description?: string;
  shape?: { shapeType?: string; placeholder?: { type?: string }; text?: RestText };
  table?: {
    rows?: number;
    columns?: number;
    tableRows?: {
      tableCells?: {
        location?: { rowIndex?: number; columnIndex?: number };
        rowSpan?: number;
        columnSpan?: number;
        text?: RestText;
      }[];
    }[];
  };
  elementGroup?: { children?: RestPageElement[] };
  image?: unknown;
  video?: unknown;
  line?: unknown;
  sheetsChart?: unknown;
  wordArt?: unknown;
  speakerSpotlight?: unknown;
};

/** A slide `Page`. */
export type RestSlide = {
  objectId?: string;
  pageElements?: RestPageElement[];
  slideProperties?: {
    layoutObjectId?: string;
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
  pageSize?: { width?: RestDimension; height?: RestDimension };
  layouts?: { objectId?: string; layoutProperties?: { displayName?: string } }[];
  slides?: RestSlide[];
};

/** A thumbnail size, named by Google for the width it renders: 200, 800 or 1600 pixels. */
export type ThumbnailSize = "SMALL" | "MEDIUM" | "LARGE";

/** A rendered page: PNG bytes and their dimensions in pixels. */
export type PageThumbnail = { width: number; height: number; content: ArrayBuffer };

// `contentUrl` is a bearer URL: anyone holding it sees the image as the account that asked, for
// 30 minutes. So it is fetched only from Google's image host, and never returned or logged.
function thumbnailContentUrl(contentUrl: string | undefined): URL {
  let url = URL.parse(contentUrl ?? "");
  if (url?.protocol !== "https:" || !url.hostname.endsWith(THUMBNAIL_HOST_SUFFIX)) {
    throw new Error("Google Slides returned an unexpected thumbnail location");
  }
  return url;
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

export class GoogleSlidesApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #request<T extends { presentationId?: string }>(
    presentationId: string,
    fields: string,
    operation: string,
  ): Promise<T> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(presentationId)}`);
    url.searchParams.set("fields", fields);
    let response = await fetchWithAuthRetry(
      url.toString(), {}, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    let result = await readGoogleJson<T>(response, {
      provider: "Google Slides", operation, maxBytes: MAX_RESPONSE_BYTES,
    });
    if (result.presentationId !== presentationId) {
      throw new Error("Google Slides returned a different presentation");
    }
    return result;
  }

  /** Fetch a presentation's slides and their content, without masters or layout elements. */
  getPresentation(presentationId: string): Promise<RestPresentation> {
    return this.#request<RestPresentation>(presentationId, PRESENTATION_FIELDS, "get presentation");
  }

  /** Fetch only a presentation's title, which also proves the caller can open it. */
  async getPresentationTitle(presentationId: string): Promise<string | undefined> {
    let result = await this.#request<{ presentationId: string; title?: string }>(
      presentationId, "presentationId,title", "get presentation title",
    );
    return result.title;
  }

  /** Fetch a presentation's title and its slide IDs, in presentation order. */
  async getOutline(
    presentationId: string,
  ): Promise<{ title: string | undefined; slideIds: string[] }> {
    let { title, slides = [] } = await this.#request<
      Pick<RestPresentation, "presentationId" | "title" | "slides">
    >(presentationId, "presentationId,title,slides(objectId)", "get presentation outline");
    return { title, slideIds: slides.flatMap(slide => slide.objectId ?? []) };
  }

  /** Render the latest version of a page as a PNG. Google counts this as an expensive read. */
  async getThumbnail(
    presentationId: string, pageId: string, size: ThumbnailSize,
  ): Promise<PageThumbnail> {
    let url = new URL(
      `${API_BASE}/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageId)}` +
      "/thumbnail");
    url.searchParams.set("thumbnailProperties.mimeType", "PNG");
    url.searchParams.set("thumbnailProperties.thumbnailSize", size);
    let response = await fetchWithAuthRetry(
      url.toString(), {}, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    let { contentUrl } = await readGoogleJson<{ contentUrl?: string }>(response, {
      provider: "Google Slides", operation: "get thumbnail", maxBytes: MAX_THUMBNAIL_RESPONSE_BYTES,
    });
    // No credentials: the URL itself is the authority. A redirect could leave Google's host.
    let image = await fetch(thumbnailContentUrl(contentUrl), {
      redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!image.ok) {
      await image.body?.cancel();
      throw new Error(`Google Slides thumbnail download failed [http=${image.status}]`);
    }
    let content = await readBytesCapped(image, MAX_THUMBNAIL_BYTES).catch((error: unknown) => {
      if (!(error instanceof ResponseTooLargeError)) throw error;
      throw new Error(
        `Google Slides thumbnail exceeded ${MAX_THUMBNAIL_BYTES} bytes; request a smaller size.`);
    });
    // readBytesCapped allocates an array of exactly the body's size, never a shared buffer.
    return { ...pngDimensions(content), content: content.buffer as ArrayBuffer };
  }
}
