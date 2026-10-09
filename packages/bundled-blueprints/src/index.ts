// What the Workshop backend's build scripts import: the archive and source readers, the manifest
// parser, and the generator that turns a blueprint directory into the bundled module.

export type { BlueprintArchive } from "./files.ts";
export {
  extractFiles,
  findInterruptedImportBackups,
  parseArchive,
  readSourceFiles,
  validatePortablePaths,
} from "./files.ts";
export type {
  BundledBlueprintManifest,
  BundledBlueprintPresentation,
  BundledBlueprintProvenance,
} from "./manifest.ts";
export {
  parseBundledBlueprintManifest,
  parseBundledBlueprintPresentation,
  parseBundledBlueprintProvenance,
} from "./manifest.ts";
export type { GeneratedModule, GenerateOptions } from "./generate.ts";
export { BUNDLED_BLUEPRINTS_DIR, generateBundledBlueprintsModule } from "./generate.ts";
