// Delete the error-reporting sourcemap artifacts of the package given as argv[2].
//
// The configurator and app builds write these (src/generated/<module>.js + .js.map,
// dist-app/<bundle>.js + .js.map) only when VITE_FRONTEND_ERROR_REPORTING=true, and delete them
// when it is not -- but only when they actually run. A vp cache hit restores the archived outputs
// without running the build, and restoration only adds files, so artifacts from an
// enabled-reporting build survive a later disabled-reporting cache hit and could be collected as if
// they matched the current bundle. Running this as an uncached `dependsOn` of the cached tasks
// deletes them first; on an enabled-reporting cache hit the restore brings back the archived set.
//
// `src/generated/*.txt` and `dist-app/app/` (the bundle itself) are never touched.

import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageDir = resolve(process.argv[2] ?? ".");

async function removeReportingArtifacts(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names
      .filter(name => name.endsWith(".js") || name.endsWith(".js.map"))
      .map(name => rm(join(dir, name), { force: true })));
}

await removeReportingArtifacts(join(packageDir, "src", "generated"));
await removeReportingArtifacts(join(packageDir, "dist-app"));
