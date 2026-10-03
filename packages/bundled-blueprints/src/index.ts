// What the Workshop backend's build scripts import: the archive codec and source reader, the
// manifest parser, and the generator that turns a blueprint directory into the bundled module.

export {
  buildContent,
  extractFiles,
  findInterruptedImportBackups,
  parseArchive,
  readSourceFiles,
  serializeArchive,
  validatePortablePaths,
} from "./files.ts";
export type { BundledBlueprintManifest, BundledBlueprintPresentation } from "./manifest.ts";
export { parseBundledBlueprintManifest, parseBundledBlueprintPresentation } from "./manifest.ts";
export type { GeneratedModule, GenerateOptions } from "./generate.ts";
export { BUNDLED_BLUEPRINTS_DIR, generateBundledBlueprintsModule } from "./generate.ts";
