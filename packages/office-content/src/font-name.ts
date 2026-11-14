/**
 * The most of a font name the readers keep; Office's own are at most 31 characters. A font is
 * named once and used by every run, cell or style that takes it, so the name a file gives is
 * copied many times over as it is resolved and drawn.
 */
export const MAX_FONT_NAME = 64;

/** A font name from the file, cut to `MAX_FONT_NAME`. */
export const fontName = <T extends string | undefined>(name: T): T => (name?.slice(0, MAX_FONT_NAME) ?? name) as T;
