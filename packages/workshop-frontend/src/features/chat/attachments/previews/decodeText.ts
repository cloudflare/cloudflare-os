/**
 * A text file's content. UTF-16 is read by its byte-order mark, which is how Excel's "Unicode
 * Text" and some Windows tools save; anything else is UTF-8, where bytes that are not valid show
 * as replacement characters, not an error.
 */
export const decodeText = (bytes: Uint8Array): string => {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
    : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
};
