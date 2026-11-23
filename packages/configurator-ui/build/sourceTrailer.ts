/** The comments ending an inlined script: its name in stack traces and, when it has one, its map's. */
export const sourceTrailer = (sourceUrl: string, mapped: boolean): string => mapped
  ? `//# sourceURL=${sourceUrl}\n//# sourceMappingURL=${sourceUrl}.map`
  : `//# sourceURL=${sourceUrl}`;
