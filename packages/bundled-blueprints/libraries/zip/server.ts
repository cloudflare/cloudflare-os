/**
 * The ZIP library's server entry (`@gadgets/bundled-blueprints/libraries/zip/server`): a minimal
 * streaming ZIP32 writer for server-side gadget exports.
 */

export { createZip, crc32, type ZipEntry, type ZipEntryData } from "./src/zip.ts";
