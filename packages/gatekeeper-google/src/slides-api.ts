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
}
