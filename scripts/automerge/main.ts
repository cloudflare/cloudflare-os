import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether the module at `url`, its `import.meta.url`, is the script node was started with. Through
 * realpath, since `import.meta.url` resolves symlinks in the path the script was run by.
 */
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && url === pathToFileURL(realpathSync(process.argv[1])).href;
}
