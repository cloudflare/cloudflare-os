// GitLab's GraphQL API, for what REST answers one project at a time: whether an account may
// download each of many projects' code (the observer verifier's `repository/*` check), and the facts
// about the projects a code search names. Also, from REST since GraphQL has no field for it, whether
// a project's repository is open to everyone who can see the project, which only narrowing asks.
//
// Both ask `projects(ids:)`, measured on GitLab 18.11: it takes at most 1000 ids, returns at most
// 100 nodes a page whatever `first` asks for, and silently leaves out a project the caller can't
// see. Ids go as variables (inlined, a few hundred make the query "too large"), in chunks of at most
// 100 so each chunk is one page; a chunk that says there is another page is an answer this code
// does not understand, and fails rather than be read as denying what it left out. Chunks are
// independent and run a few at a time (10 at once did not slow each other).

import { GitLabApiError, type GitLabApi, type GitLabProjectResponse } from "./gitlab-api";

/** The most ids one `projects(ids:)` query is given: the most nodes GitLab returns on one page. */
const CHUNK_SIZE = 100;
/** The most chunk queries (or REST reads) in flight at once. */
const CONCURRENCY = 6;

/** A project's global id, as GraphQL names it. */
const PROJECT_GID = /^gid:\/\/gitlab\/Project\/([1-9][0-9]*)$/;

/**
 * What the owner's account sees of a project a code search names: where it lives, its default
 * branch (null for an empty repository), and who can see it.
 */
export type GitLabProjectFacts = {
  id: number;
  /** The full path, `group/sub/project`. */
  path: string;
  name: string;
  /** The full path of the group or user namespace the project is in: `path` without its last segment. */
  namespace: string;
  url: string;
  defaultBranch: string | null;
  /** An unrecognised visibility reads as `private`, the most restrictive. */
  visibility: "public" | "internal" | "private";
  archived: boolean;
};

type ProjectsPage<Node> = {
  projects: { nodes: Node[]; pageInfo: { hasNextPage: boolean } } | null;
};

type DownloadCodeNode = { id: string; userPermissions?: { downloadCode?: unknown } | null };

type FactsNode = {
  id: string;
  fullPath: string;
  name: string;
  webUrl: string | null;
  visibility: string | null;
  archived: boolean | null;
  repository: { rootRef: string | null } | null;
};

const DOWNLOAD_CODE_QUERY = `query GadgetsProjectDownloadCode($ids: [ID!]) {
  projects(ids: $ids, first: ${CHUNK_SIZE}, archived: INCLUDE) {
    nodes { id userPermissions { downloadCode } }
    pageInfo { hasNextPage }
  }
}`;

const FACTS_QUERY = `query GadgetsProjectFacts($ids: [ID!]) {
  projects(ids: $ids, first: ${CHUNK_SIZE}, archived: INCLUDE) {
    nodes { id fullPath name webUrl visibility archived repository { rootRef } }
    pageInfo { hasNextPage }
  }
}`;

/**
 * Whether `api`'s account may download each project's code (`userPermissions.downloadCode`), for
 * every id in `ids`: GitLab's own answer, which weighs the project's visibility, whether the user is
 * external, a members-only repository and inherited membership. A project GitLab leaves out (gone,
 * or invisible to the account) is `false`.
 * @throws GitLabApiError when GitLab fails or answers a chunk with GraphQL errors, and Error when a
 * chunk's answer is not one this understands (another page, a project it was not asked about):
 * access is then undetermined, never denied.
 */
export async function fetchDownloadCode(api: GitLabApi, ids: number[]): Promise<Map<number, boolean>> {
  const answers = new Map<number, boolean>();
  const unique = [...new Set(ids)];
  for (const id of unique) answers.set(id, false);
  await forEachChunk(unique, async chunk => {
    for (const node of await queryProjects<DownloadCodeNode>(api, DOWNLOAD_CODE_QUERY, chunk)) {
      const downloadCode = node.userPermissions?.downloadCode;
      if (typeof downloadCode !== "boolean") throw unexpected();
      answers.set(nodeId(node.id, chunk), downloadCode);
    }
  });
  return answers;
}

/**
 * The facts about each project in `ids` that `api`'s account can see; a project it can't see is
 * left out of the map.
 * @throws As fetchDownloadCode.
 */
export async function fetchProjectFacts(api: GitLabApi, ids: number[]): Promise<Map<number, GitLabProjectFacts>> {
  const facts = new Map<number, GitLabProjectFacts>();
  await forEachChunk([...new Set(ids)], async chunk => {
    for (const node of await queryProjects<FactsNode>(api, FACTS_QUERY, chunk)) {
      const id = nodeId(node.id, chunk);
      if (typeof node.fullPath !== "string" || typeof node.name !== "string" || typeof node.webUrl !== "string") {
        throw unexpected();
      }
      const slash = node.fullPath.lastIndexOf("/");
      facts.set(id, {
        id,
        path: node.fullPath,
        name: node.name,
        namespace: slash < 0 ? "" : node.fullPath.slice(0, slash),
        url: node.webUrl,
        defaultBranch: node.repository?.rootRef ?? null,
        visibility: node.visibility === "public" || node.visibility === "internal" ? node.visibility : "private",
        archived: node.archived === true,
      });
    }
  });
  return facts;
}

/**
 * Whether each project's repository, as `api`'s account sees it, is open to everyone who can see
 * the project (its repository feature `enabled`) rather than to members only (`private`) or off
 * (`disabled`): `GET /projects/:id`'s `repository_access_level`, one project at a time, at most
 * CONCURRENCY at once. A project whose answer is not known -- GitLab did not send the level, or
 * the read failed (GitLab hid the project, refused, or failed) -- is left out of the map.
 */
export async function fetchRepositoryOpenToAllUsers(api: GitLabApi, ids: number[]): Promise<Map<number, boolean>> {
  const answers = new Map<number, boolean>();
  await mapLimit([...new Set(ids)], CONCURRENCY, async id => {
    let level: GitLabProjectResponse["repository_access_level"];
    try {
      level = (await api.getProjectById(id)).repository_access_level;
    } catch (error) {
      if (error instanceof GitLabApiError) return;
      throw error;
    }
    if (level === "enabled") answers.set(id, true);
    else if (level === "private" || level === "disabled") answers.set(id, false);
  });
  return answers;
}

/** Runs `fn` over `ids` in chunks of at most CHUNK_SIZE, at most CONCURRENCY at once. */
async function forEachChunk(ids: number[], fn: (chunk: number[]) => Promise<void>): Promise<void> {
  const chunks: number[][] = [];
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) chunks.push(ids.slice(start, start + CHUNK_SIZE));
  await mapLimit(chunks, CONCURRENCY, fn);
}

/** One `projects(ids:)` page for `chunk`, refusing an answer that says there is more. */
async function queryProjects<Node>(api: GitLabApi, query: string, chunk: number[]): Promise<Node[]> {
  const data = await api.graphql<ProjectsPage<Node>>(query, { ids: chunk.map(id => `gid://gitlab/Project/${id}`) });
  const projects = data.projects;
  if (projects === null || !Array.isArray(projects.nodes) || projects.pageInfo?.hasNextPage !== false) {
    throw unexpected();
  }
  return projects.nodes;
}

/** The project id a node's global id names, which must be one `chunk` asked about. */
function nodeId(gid: unknown, chunk: number[]): number {
  const match = typeof gid === "string" ? PROJECT_GID.exec(gid) : null;
  const id = match ? Number(match[1]) : NaN;
  if (!chunk.includes(id)) throw unexpected();
  return id;
}

function unexpected(): Error {
  return new Error("GitLab's answer about project access was not one the gatekeeper understands.");
}

/** Maps `items` through `fn`, at most `limit` at once, in order. */
async function mapLimit<In, Out>(items: readonly In[], limit: number, fn: (item: In) => Promise<Out>): Promise<Out[]> {
  const results: Out[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await fn(items[index]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
