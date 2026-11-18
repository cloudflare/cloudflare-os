// A pull request's discussion through a real session on the real `GitHubGatekeeperImpl` Durable
// Object, with GitHub faked at the `fetch` boundary: each review entry must carry the diff
// comments GitHub has for it now, however the review page and the review-comment store were
// cached, whether or not `readDiffThreads()` was ever called.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubDiscussionEntry, GitHubDiffThread } from "../../src/types";
import type { GatekeeperProps, Outcome, SessionCall } from "./worker";

const OWNER = "acme";
const REPO = "widgets";
const PULL = 7;
const HEAD = "a".repeat(40);
/** The repository's path by name, read only to pin its id, 1, or by that id, as every other read is. */
const REPO_PATH = new RegExp(`^/(repos/${OWNER}/${REPO}|repositories/1)(?=/|$)`);
/** Past every 30-second read cache (pull details, review pages, the comment stores' syncs). */
const STALE = 31_000;

type Row = Record<string, unknown>;

const user = (login: string) => ({ login, html_url: `https://github.com/${login}`, avatar_url: null });

/** GitHub's REST API for pull request #7: its reviews and their diff comments. */
class FakeGitHub {
  readonly reviews: Row[] = [];
  readonly comments: Row[] = [];
  /** Bumped whenever `reviews` changes, as the review listing's etag would be. */
  #reviewsVersion = 0;
  /** `GET /pulls/7/reviews` answered 304, unchanged since the etag sent. */
  reviewsNotModified = 0;

  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      this.#handle(new Request(input, init)));
  }

  addReview(id: number, login: string, state: "COMMENTED" | "APPROVED", body = ""): void {
    this.reviews.push({
      id, user: user(login), body, state, submitted_at: new Date().toISOString(),
      html_url: `https://github.com/${OWNER}/${REPO}/pull/${PULL}#pullrequestreview-${id}`,
      commit_id: HEAD,
    });
    this.#reviewsVersion++;
  }

  /** A diff comment submitted with review `reviewId`; `inReplyTo` makes it a reply in that thread. */
  addComment(id: number, reviewId: number, login: string, body: string, inReplyTo?: number): void {
    const now = new Date().toISOString();
    this.comments.push({
      id, pull_request_review_id: reviewId, in_reply_to_id: inReplyTo, user: user(login), body,
      path: "src/app.ts", line: 3, original_line: 3, side: "RIGHT", start_line: null,
      original_start_line: null, start_side: null, subject_type: "line", position: 1,
      original_position: 1, commit_id: HEAD, original_commit_id: HEAD,
      created_at: now, updated_at: now,
      html_url: `https://github.com/${OWNER}/${REPO}/pull/${PULL}#discussion_r${id}`,
    });
  }

  /** Edits a diff comment: the review listing doesn't change. */
  editComment(id: number, body: string): void {
    const comment = this.comments.find(candidate => candidate.id === id)!;
    comment.body = body;
    comment.updated_at = new Date().toISOString();
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(REPO_PATH, "");
    const firstPage = (url.searchParams.get("page") ?? "1") === "1";

    if (path === "") {
      return Response.json({
        id: 1, name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER },
        html_url: `https://github.com/${OWNER}/${REPO}`, description: null, visibility: "public",
        private: false, default_branch: "main",
      });
    }
    if (path === "/user") return Response.json(user("ada"));
    if (path === `/pulls/${PULL}` || path === `/issues/${PULL}`) {
      const repository = { owner: { login: OWNER }, name: REPO, full_name: `${OWNER}/${REPO}` };
      return Response.json({
        number: PULL, html_url: `https://github.com/${OWNER}/${REPO}/pull/${PULL}`, title: "Fix",
        state: "open", body: "", user: user("max"), labels: [], assignees: [], requested_reviewers: [],
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: null,
        comments: 0, draft: false, merged_at: null, mergeable: true, mergeable_state: "clean",
        commits: 1, additions: 1, deletions: 0, changed_files: 1, pull_request: {},
        head: { ref: "fix", sha: HEAD, repo: repository },
        base: { ref: "main", sha: HEAD, repo: repository },
      });
    }
    if (path === `/issues/${PULL}/comments`) return Response.json([]);
    if (path === `/pulls/${PULL}/reviews`) {
      const etag = `"reviews-${this.#reviewsVersion}"`;
      if (request.headers.get("if-none-match") === etag) {
        this.reviewsNotModified++;
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return Response.json(firstPage ? this.reviews : [], { headers: { ETag: etag } });
    }
    if (path === `/pulls/${PULL}/comments`) {
      const since = url.searchParams.get("since");
      const rows = this.comments.filter(comment =>
        since === null || Date.parse(comment.updated_at as string) >= Date.parse(since));
      return Response.json(firstPage ? rows : []);
    }
    throw new Error(`test: unexpected fetch ${request.method} ${request.url}`);
  }
}

class TestGitCache extends RpcTarget {
  async advertiseCommit(): Promise<void> {}
}

class TestApprovalQueue extends RpcTarget {
  async authorizeObservation(): Promise<void> {}
  async submitAction(): Promise<void> {}
  async getGitCache(): Promise<TestGitCache> {
    return new TestGitCache();
  }
}

async function unwrap<T>(pending: Promise<Outcome<unknown>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok as T;
}

let nextScenario = 0;

async function gatekeeper() {
  const scenario = `discussion-${nextScenario++}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(), resourceKind: "repo", owner: OWNER, repo: REPO,
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  const drained = <T>(method: string) => {
    const calls: SessionCall[] = [{ method: "getPullRequest", args: [String(PULL)] }, { method }];
    return unwrap<T[]>(hooks.sessionRead(scenario, props, new RpcStub(new TestApprovalQueue()) as never, calls, true));
  };
  return {
    /** Each review in the discussion, by id, with its diff comments' ids and bodies. */
    reviews: async () => Object.fromEntries((await drained<GitHubDiscussionEntry>("readDiscussion"))
      .flatMap(entry => entry.kind === "review"
        ? [[entry.id, entry.diffComments.map(comment => [comment.id, comment.bodyMarkdown])]]
        : [])),
    threads: () => drained<GitHubDiffThread>("readDiffThreads"),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readDiscussion", () => {
  it("lists diff comments posted after the discussion was first read, without readDiffThreads()", async () => {
    const github = new FakeGitHub();
    const start = Date.now();
    vi.setSystemTime(start);
    github.addReview(10, "ask-bonk[bot]", "COMMENTED", "LGTM!");
    const gk = await gatekeeper();

    expect(await gk.reviews()).toEqual({ "10": [] });

    // A review bot opens a thread, and the author replies in it: GitHub records the reply as a
    // review of its own, with no body.
    vi.setSystemTime(start + STALE);
    github.addReview(11, "ask-bonk[bot]", "COMMENTED");
    github.addComment(501, 11, "ask-bonk[bot]", "[P2] Make this reachable by keyboard");
    github.addReview(12, "max", "COMMENTED");
    github.addComment(502, 12, "max", "Not going to fix here", 501);

    expect(await gk.reviews()).toEqual({
      "10": [],
      "11": [["501", "[P2] Make this reachable by keyboard"]],
      "12": [["502", "Not going to fix here"]],
    });
    // The same comments the thread listing shows.
    expect((await gk.threads()).map(thread => [thread.id, thread.comments.map(comment => comment.reviewId)]))
      .toEqual([["501", ["11", "12"]]]);
  });

  it("shows a diff comment's edit while the review listing is unchanged", async () => {
    const github = new FakeGitHub();
    const start = Date.now();
    vi.setSystemTime(start);
    github.addReview(11, "ask-bonk[bot]", "COMMENTED");
    github.addComment(501, 11, "ask-bonk[bot]", "Old finding");
    const gk = await gatekeeper();

    expect(await gk.reviews()).toEqual({ "11": [["501", "Old finding"]] });

    vi.setSystemTime(start + STALE);
    github.editComment(501, "Edited finding");

    expect(await gk.reviews()).toEqual({ "11": [["501", "Edited finding"]] });
    // The review page itself was served from its cache, revalidated by etag.
    expect(github.reviewsNotModified).toBe(1);
  });
});
