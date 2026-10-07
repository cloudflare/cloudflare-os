import type { GooglePresentationReadSession } from "./slides-read-types";
export type * from "./slides-read-types";

/** The access provided by a directly bound Google Slides presentation, which is read-only. */
export type GooglePresentationSession = GooglePresentationReadSession;
