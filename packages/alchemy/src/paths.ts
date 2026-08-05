import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

const ownRequire = createRequire(import.meta.url);
// Resolve from the user's project first: packaged gatekeepers named in
// manifests (e.g. a starter repo's own workspace package) are dependencies
// of the project running the stack, not of this package.
const projectRequire = createRequire(
  pathToFileURL(NodePath.join(process.cwd(), "package.json")),
);

/**
 * Find a package's directory by scanning the resolver's `node_modules`
 * candidate paths for its `package.json` on disk. Deliberately avoids
 * `require.resolve("<pkg>/package.json")`: packages with an `exports` map
 * that omits `./package.json` (e.g. `@gadgets/typed-storage`) reject that
 * subpath, and resolving the package entry itself can fail when it points
 * at not-yet-built output — the very output this resolution exists to build.
 */
const findPackageDir = (
  require: NodeJS.Require,
  pkg: string,
): string | undefined => {
  for (const base of require.resolve.paths(pkg) ?? []) {
    const candidate = NodePath.join(base, pkg, "package.json");
    if (existsSync(candidate)) return NodePath.dirname(candidate);
  }
  return undefined;
};

/**
 * Directory containing a package (the dirname of its `package.json`),
 * resolved from the deploying project first, then from this package's own
 * dependencies (the `@gadgets/*` workspace packages).
 */
export const packageDir = (pkg: string): string => {
  const dir = findPackageDir(projectRequire, pkg) ?? findPackageDir(ownRequire, pkg);
  if (dir === undefined) {
    throw new Error(
      `Cannot resolve package "${pkg}" from ${process.cwd()} or from cloudflare-os's own dependencies.`,
    );
  }
  return dir;
};

/**
 * Absolute path to a script shipped inside this package (used by build
 * commands that post-process worker build output).
 */
export const ownScript = (name: string): string =>
  NodePath.join(
    NodePath.dirname(ownRequire.resolve("cloudflare-os/package.json")),
    "scripts",
    name,
  );
