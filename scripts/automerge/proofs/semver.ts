// The little of semver the dependency proof needs: the version a manifest range starts from, and
// whether moving between two versions crosses a breaking boundary.

/** A plain `major.minor.patch[-prerelease]` version. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const SIMPLE_RANGE = /^(?:\^|~|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Parses an exact version, or undefined. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? "" };
}

/**
 * The version an exact, caret or tilde range names (`2.2.0`, `^1.4.3`, `~0.3.0`), or undefined for
 * anything else: `workspace:`, `catalog:`, `npm:` aliases, URLs, unions and comparators.
 */
export function rangeVersion(range: string): Version | undefined {
  const match = SIMPLE_RANGE.exec(range.trim());
  return match ? parseVersion(match[1]) : undefined;
}

/**
 * Whether `from` -> `to` is a minor or patch move under semver's caret rule: same major, and for
 * 0.x the same minor, and not backwards. Moves into or out of a prerelease do not count.
 */
export function isMinorOrPatch(from: Version, to: Version): boolean {
  if (from.prerelease !== "" || to.prerelease !== "") return false;
  if (from.major !== to.major) return false;
  if (from.major === 0 && from.minor !== to.minor) return false;
  const order = (v: Version) => [v.major, v.minor, v.patch];
  const [a, b] = [order(from), order(to)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] > a[i];
  }
  return false;
}
