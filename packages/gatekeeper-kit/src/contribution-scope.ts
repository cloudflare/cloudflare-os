/**
 * The grammar and checks of a "contributor" repository binding: a capability that may push only
 * to branches under one prefix and open change requests (pull/merge requests) from them into the
 * repository's default branch. Shared by the git-hosting gatekeepers so that the URL a Workshop
 * creates, the props a gatekeeper persists, and the checks it applies cannot drift apart.
 *
 * The scope rides the resource URL's query, which the gatekeeper parses into props:
 * `?branchPrefix=<prefix>[&allowPublic=true]`. `branchPrefix` comes first so a resource
 * pattern can recognize the URL (`…\\?branchPrefix=*`); any other parameter is refused, since a
 * capability URL that silently ignored a constraint would grant more than it says.
 */

import { validateBranchName } from "./git-transport";

/** A contributor binding's scope, as persisted in a gatekeeper's props. */
export type ContributionScope = {
  /** Branch namespace, ending with `/`, e.g. `cloudflare-os/`. */
  branchPrefix: string;
  /** Whether the binding may write to a repository anyone can read. */
  allowPublic: boolean;
};

const MAX_PREFIX_LENGTH = 100;

/**
 * Validates a branch prefix: a valid branch name followed by `/`, so a prefix names a namespace
 * (`cloudflare-os/`) and can never equal or prefix an ordinary branch such as `main`.
 * @returns The prefix unchanged.
 * @throws If the prefix is not a namespace a branch name could live under.
 */
export function validateBranchPrefix(prefix: string): string {
  if (prefix.length < 2 || prefix.length > MAX_PREFIX_LENGTH || !prefix.endsWith("/")) {
    throw new Error(
      `invalid branch prefix ${JSON.stringify(prefix.slice(0, 64))}: it must end with "/" ` +
      `and be at most ${MAX_PREFIX_LENGTH} characters, e.g. "cloudflare-os/".`);
  }
  validateBranchName(prefix.slice(0, -1));
  return prefix;
}

/**
 * Reads a contributor scope from a resource URL's query.
 * @returns The scope, `null` when the URL carries no query at all (an ordinary binding), or
 *   throws when it carries a query that is not a well-formed contributor scope.
 */
export function parseContributionScope(search: URLSearchParams): ContributionScope | null {
  const keys = [...search.keys()];
  if (keys.length === 0) return null;
  if (keys[0] !== "branchPrefix") {
    throw new Error("A contributor repository URL must start its query with branchPrefix.");
  }
  for (const key of keys) {
    if (key !== "branchPrefix" && key !== "allowPublic") {
      throw new Error(`Unsupported repository URL parameter: ${JSON.stringify(key.slice(0, 64))}.`);
    }
    if (search.getAll(key).length !== 1) {
      throw new Error(`Repository URL parameter ${key} may appear only once.`);
    }
  }
  const allowPublic = search.get("allowPublic");
  if (allowPublic !== null && allowPublic !== "true" && allowPublic !== "false") {
    throw new Error("allowPublic must be true or false.");
  }
  return {
    branchPrefix: validateBranchPrefix(search.get("branchPrefix") ?? ""),
    allowPublic: allowPublic === "true",
  };
}

/**
 * The canonical query for a scope, the inverse of `parseContributionScope`.
 * @returns A string starting with `?`.
 */
export function contributionScopeQuery(scope: ContributionScope): string {
  const query = new URLSearchParams({ branchPrefix: validateBranchPrefix(scope.branchPrefix) });
  if (scope.allowPublic) query.set("allowPublic", "true");
  return `?${query.toString()}`;
}

/** What a contributor check needs to know about the repository, read fresh by the caller. */
export type ContributionTarget = {
  /** Whether anyone, signed in or not, can read the repository. */
  isPublic: boolean;
  defaultBranch: string;
};

/**
 * Refuses writes to a public repository unless the scope explicitly allows them. Checked when an
 * action is queued and again when it is applied, since visibility can change in between.
 * @throws If the write is not allowed.
 */
export function assertContributionVisibility(scope: ContributionScope, target: ContributionTarget): void {
  if (target.isPublic && !scope.allowPublic) {
    throw new Error(
      "This repository is public, and this connection is not allowed to write to public " +
      "repositories. Nothing was pushed.");
  }
}

/**
 * Refuses a branch outside the scope: it must lie under the prefix (and be longer than it), and
 * must not be the default branch.
 * @returns The branch unchanged.
 * @throws If the branch may not be written through this binding.
 */
export function assertContributionBranch(scope: ContributionScope, target: ContributionTarget,
    branch: string): string {
  validateBranchName(branch);
  if (!branch.startsWith(scope.branchPrefix) || branch.length === scope.branchPrefix.length) {
    throw new Error(
      `This connection can only write to branches whose names start with ` +
      `"${scope.branchPrefix}" (for example "${scope.branchPrefix}fix-1"); ` +
      `${JSON.stringify(branch.slice(0, 120))} is not one of them.`);
  }
  if (branch === target.defaultBranch) {
    throw new Error(`This connection cannot write to the default branch "${target.defaultBranch}".`);
  }
  return branch;
}
