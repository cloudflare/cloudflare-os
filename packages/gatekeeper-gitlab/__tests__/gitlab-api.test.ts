// gitlab-api.ts coverage: URL and query composition for every endpoint the gatekeeper uses,
// the documented error-body shapes, redirect refusal, OAuth request bodies and grant parsing,
// PKCE, Access-header passthrough, and the git smart-HTTP request framing. GitLab is faked at
// `fetch`; response bodies come from the documentation-derived fixtures.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitLabApi,
  GitLabApiError,
  buildAuthorizeUrl,
  encodeProjectPath,
  encodeRefName,
  errorMessageFromBody,
  exchangeAuthCode,
  generatePkce,
  gitRepoPath,
  lineCode,
  refreshAccessToken,
  revokeToken,
  type GitLabInstance,
} from "../src/gitlab-api";
import * as fx from "./fixtures/gitlab-docs";

const INSTANCE: GitLabInstance = { apiOrigin: "https://gitlab.example.com", headers: {} };
const ACCESS_INSTANCE: GitLabInstance = {
  apiOrigin: "https://gitlab-access.example.com",
  headers: { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret.access" },
};

type Call = { url: URL; init: RequestInit; headers: Headers; body?: string };

/** Install a fetch fake answering each call from `responses` in order; returns the recorded calls. */
function fakeFetch(responses: Array<Response | ((call: Call) => Response)>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const call: Call = { url: new URL(String(input)), init, headers };
    if (typeof init.body === "string") call.body = init.body;
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${call.url}`);
    return typeof next === "function" ? next(call) : next;
  }));
  return calls;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const api = (instance = INSTANCE) => new GitLabApi(instance, async () => ({ token: "tok-1", grantId: "grant-1" }));

describe("path encoding", () => {
  it("encodes a nested project path as one segment", () => {
    expect(encodeProjectPath("group/sub/project")).toBe("group%2Fsub%2Fproject");
  });

  it("encodes a branch name with slashes as one segment (GitLab's my%2Fbranch rule)", () => {
    expect(encodeRefName("feature/x")).toBe("feature%2Fx");
    expect(encodeRefName("release/2026.09")).toBe("release%2F2026.09");
  });

  it("keeps slashes in the git URL path but encodes each segment", () => {
    expect(gitRepoPath("group/sub/pro ject")).toBe("group/sub/pro%20ject");
  });
});

describe("request composition", () => {
  it("sends bearer auth, JSON accept, the user agent, and no Access headers when none are configured", async () => {
    const calls = fakeFetch([json(fx.currentUserResponse.data)]);
    await api().getCurrentUser();
    const [call] = calls;
    expect(call.url.toString()).toBe("https://gitlab.example.com/api/v4/user");
    expect(call.headers.get("authorization")).toBe("Bearer tok-1");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("user-agent")).toBe("Cloudflare-Gadgets");
    expect(call.headers.has("cf-access-client-id")).toBe(false);
    expect(call.init.redirect).toBe("manual");
  });

  it("attaches the Access service-token pair to every request when configured", async () => {
    const calls = fakeFetch([json(fx.projectResponse.data)]);
    await api(ACCESS_INSTANCE).getProject("diaspora/diaspora-project-site");
    expect(calls[0].url.origin).toBe("https://gitlab-access.example.com");
    expect(calls[0].headers.get("cf-access-client-id")).toBe("id.access");
    expect(calls[0].headers.get("cf-access-client-secret")).toBe("secret.access");
  });

  it("spells array query params as key[]=", async () => {
    const calls = fakeFetch([json(fx.mergeBaseResponse.data)]);
    await api().mergeBase("g/p", "abc", "def");
    expect(calls[0].url.search).toBe("?refs%5B%5D=abc&refs%5B%5D=def");
  });

  it("omits undefined and null query values", async () => {
    const calls = fakeFetch([json([])]);
    await api().listIssues("g/p", { perPage: 20, page: 1 });
    const params = calls[0].url.searchParams;
    expect([...params.keys()].toSorted()).toEqual(["page", "per_page", "with_labels_details"]);
  });
});

describe("redirect refusal", () => {
  it("maps a same-origin 301 to a 'project moved' error carrying the Location, without following it", async () => {
    fakeFetch([new Response(null, {
      status: 301,
      headers: { location: "https://gitlab.example.com/api/v4/projects/81" },
    })]);
    const error = await api().createIssue("old/path", { title: "x" }).catch(e => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error.status).toBe(301);
    expect(error.movedTo).toBe("https://gitlab.example.com/api/v4/projects/81");
    expect(error.message).toMatch(/renamed or transferred/);
  });

  it("recognises a rename by its /api/v4/ path even when the Location names the browser-facing host", async () => {
    // GitLab spells the Location with its configured external URL, so behind a separate Access
    // hostname the rename redirect is cross-origin to the request -- still a rename.
    fakeFetch([new Response(null, {
      status: 301,
      headers: { location: "https://gitlab.example.com/api/v4/projects/81" },
    })]);
    const error = await api(ACCESS_INSTANCE).getProject("old/path").catch(e => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error.message).toMatch(/renamed or transferred/);
    expect(error.movedTo).toBe("https://gitlab.example.com/api/v4/projects/81");
  });

  it("names the access proxy, not a rename, when the redirect is to a login page", async () => {
    fakeFetch([new Response(null, {
      status: 302,
      headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/gitlab-access.example.com?kid=x" },
    })]);
    const error = await api(ACCESS_INSTANCE).getCurrentUser().catch(e => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error.status).toBe(302);
    expect(error.message).not.toMatch(/renamed/);
    expect(error.message).toMatch(/redirected to https:\/\/team\.cloudflareaccess\.com/);
    expect(error.message).toMatch(/Cloudflare Access/);
  });
});

describe("error bodies", () => {
  it("reads the documented string message shape", () => {
    expect(errorMessageFromBody(fx.errorBodies.data.notFound, "fallback")).toBe("404 Project Not Found");
    expect(errorMessageFromBody(fx.errorBodies.data.missingAttribute, "fallback"))
      .toBe("400 (Bad request) \"title\" not given");
  });

  it("flattens the documented validation-hash shape", () => {
    expect(errorMessageFromBody(fx.errorBodies.data.validation, "fallback"))
      .toBe("bio: is too long (maximum is 255 characters)");
  });

  it("reads the OAuth-style error shape", () => {
    expect(errorMessageFromBody(fx.errorBodies.data.insufficientScope, "fallback"))
      .toBe("insufficient_scope: The request requires higher privileges than provided by the access token.");
  });

  it("falls back for empty or unknown bodies", () => {
    expect(errorMessageFromBody("", "fallback")).toBe("fallback");
    expect(errorMessageFromBody({ unrelated: 1 }, "fallback")).toBe("fallback");
    expect(errorMessageFromBody(undefined, "fallback")).toBe("fallback");
  });

  it("classifies a 401 as a credential rejection only from /user and the git endpoints", async () => {
    fakeFetch([
      json(fx.errorBodies.data.unauthorized, { status: 401 }),
      json({ message: "401 Unauthorized" }, { status: 401 }),
      json({ message: "401 Unauthorized" }, { status: 401 }),
      new Response("Unauthorized", { status: 401 }),
    ]);
    const probe = await api().getCurrentUser().catch(e => e);
    expect(probe.isAuthError).toBe(true);
    // The refusal is a fact about the credential the request carried, so the error names it.
    expect(probe.grantId).toBe("grant-1");
    // GitLab's documented "this user does not have permission to accept this merge request" is a
    // 401 too; it is the merge's own answer, not a revoked token.
    expect((await api().mergeMergeRequest("g/p", 1, {}).catch(e => e)).isAuthError).toBe(false);
    expect((await api().approveMergeRequest("g/p", 1, "abc").catch(e => e)).isAuthError).toBe(false);
    // The git endpoints authenticate nothing but the bearer.
    const git = await api().fetchGitUploadPack("g/p", new Uint8Array()).catch(e => e);
    expect(git.isAuthError).toBe(true);
    expect(git.grantId).toBe("grant-1");
  });

  it("appends Retry-After on a 429", async () => {
    fakeFetch([new Response("Retry later", { status: 429, headers: { "retry-after": "30" } })]);
    const limited = await api().getCurrentUser().catch(e => e);
    expect(limited.status).toBe(429);
    expect(limited.message).toBe("Retry later (retry after 30s)");
  });
});

describe("members", () => {
  it("reads a user's effective membership through the documented user_ids filter, taking the highest row", async () => {
    const calls = fakeFetch([
      json([{ id: 8769, username: "dancarter", access_level: 30 }]),
      json([]),
      json([{ id: 8769, username: "dancarter", access_level: 10 }, { id: 8769, username: "dancarter", access_level: 40 }, { id: 7, username: "other", access_level: 50 }]),
    ]);
    expect(await api().getProjectMember("g/p", 8769)).toMatchObject({ access_level: 30 });
    expect(calls[0].url.pathname).toBe("/api/v4/projects/g%2Fp/members/all");
    expect(calls[0].url.searchParams.getAll("user_ids[]")).toEqual(["8769"]);
    expect(await api().getProjectMember("g/p", 8769)).toBeNull();
    expect(await api().getProjectMember("g/p", 8769)).toMatchObject({ access_level: 40 });
  });
});

describe("issues and merge requests", () => {
  it("composes the issue list query from the filter", async () => {
    const calls = fakeFetch([json([fx.issueResponse.data])]);
    await api().listIssues("group/sub/project", {
      state: "opened",
      labels: ["bug", "needs triage"],
      authorUsername: "root",
      assigneeUsername: "lennie",
      search: "frobnicate",
      orderBy: "updated_at",
      sort: "asc",
      perPage: 50,
      page: 2,
    });
    const url = calls[0].url;
    expect(url.pathname).toBe("/api/v4/projects/group%2Fsub%2Fproject/issues");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: "opened",
      labels: "bug,needs triage",
      author_username: "root",
      "assignee_username[]": "lennie",
      search: "frobnicate",
      order_by: "updated_at",
      sort: "asc",
      with_labels_details: "true",
      per_page: "50",
      page: "2",
    });
  });

  it("drops state=all (the server default) and requests label details on single reads", async () => {
    const calls = fakeFetch([json([]), json(fx.issueResponse.data)]);
    await api().listIssues("g/p", { state: "all", perPage: 20, page: 1 });
    expect(calls[0].url.searchParams.has("state")).toBe(false);
    await api().getIssue("g/p", 41);
    expect(calls[1].url.pathname).toBe("/api/v4/projects/g%2Fp/issues/41");
    expect(calls[1].url.searchParams.get("with_labels_details")).toBe("true");
  });

  it("sends the issuable PUT with state_event and comma-joined label deltas", async () => {
    const calls = fakeFetch([json(fx.issueResponse.data)]);
    await api().updateIssue("g/p", 41, { state_event: "close", add_labels: ["a", "b"], remove_labels: ["c"] });
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].body!)).toEqual({ state_event: "close", add_labels: "a,b", remove_labels: "c" });
  });

  it("spells the MR draft filter with wip=yes|no and defaults state to all", async () => {
    const calls = fakeFetch([json([]), json([])]);
    await api().listMergeRequests("g/p", { draft: true, sourceBranch: "feat", perPage: 20, page: 1 });
    expect(calls[0].url.searchParams.get("wip")).toBe("yes");
    expect(calls[0].url.searchParams.get("state")).toBe("all");
    expect(calls[0].url.searchParams.get("source_branch")).toBe("feat");
    await api().listMergeRequests("g/p", { draft: false, perPage: 20, page: 1 });
    expect(calls[1].url.searchParams.get("wip")).toBe("no");
  });

  it("creates an issue with assignee ids and joined labels", async () => {
    const calls = fakeFetch([json(fx.issueResponse.data, { status: 201 })]);
    await api().createIssue("g/p", { title: "T", description: "D", labels: ["x"], assignee_ids: [9] });
    expect(JSON.parse(calls[0].body!)).toEqual({ title: "T", description: "D", labels: "x", assignee_ids: [9] });
  });

  it("merges with the documented params and approves with a sha", async () => {
    const calls = fakeFetch([json(fx.mergeRequestResponse.data), json({}, { status: 201 })]);
    await api().mergeMergeRequest("g/p", 133, { squash: true, sha: "e82eb4a0", should_remove_source_branch: true });
    expect(calls[0].url.pathname).toBe("/api/v4/projects/g%2Fp/merge_requests/133/merge");
    expect(JSON.parse(calls[0].body!)).toEqual({ squash: true, sha: "e82eb4a0", should_remove_source_branch: true });
    await api().approveMergeRequest("g/p", 133, "e82eb4a0");
    expect(calls[1].url.pathname).toBe("/api/v4/projects/g%2Fp/merge_requests/133/approve");
    expect(JSON.parse(calls[1].body!)).toEqual({ sha: "e82eb4a0" });
  });

  it("resolves the merge_request/issues note paths and the discussion reply path", async () => {
    const calls = fakeFetch([json(fx.issueNotesResponse.data), json({}, { status: 201 }), json({}), json([])]);
    await api().listNotes("g/p", "merge_requests", 7, { orderBy: "updated_at", sort: "desc", page: 1, perPage: 100 });
    expect(calls[0].url.pathname).toBe("/api/v4/projects/g%2Fp/merge_requests/7/notes");
    expect(calls[0].url.searchParams.get("order_by")).toBe("updated_at");
    await api().addDiscussionNote("g/p", 7, fx.diffDiscussionResponse.data.id, "reply");
    expect(calls[1].url.pathname)
      .toBe(`/api/v4/projects/g%2Fp/merge_requests/7/discussions/${fx.diffDiscussionResponse.data.id}/notes`);
    await api().setDiscussionResolved("g/p", 7, "abc", true);
    expect(calls[2].init.method).toBe("PUT");
    expect(JSON.parse(calls[2].body!)).toEqual({ resolved: true });
    // The thread itself is read from the discussions endpoint, for issues and merge requests alike.
    await api().listDiscussions("g/p", "issues", 3, 2, 100);
    expect(calls[3].url.pathname).toBe("/api/v4/projects/g%2Fp/issues/3/discussions");
    expect(calls[3].url.searchParams.get("page")).toBe("2");
  });

  it("publishes drafts with a summary note and reviewer state", async () => {
    const calls = fakeFetch([json(fx.draftNotesResponse.data[0], { status: 201 }), json({})]);
    await api().createDraftNote("g/p", 11, {
      note: "nit",
      position: {
        base_sha: "b", start_sha: "s", head_sha: "h", position_type: "text",
        old_path: "a.ts", new_path: "a.ts", new_line: 3,
      },
    });
    expect(calls[0].url.pathname).toBe("/api/v4/projects/g%2Fp/merge_requests/11/draft_notes");
    await api().bulkPublishDraftNotes("g/p", 11, { note: "LGTM", reviewer_state: "requested_changes" });
    expect(calls[1].url.pathname).toBe("/api/v4/projects/g%2Fp/merge_requests/11/draft_notes/bulk_publish");
    expect(JSON.parse(calls[1].body!)).toEqual({ note: "LGTM", reviewer_state: "requested_changes" });
  });

  it("deletes a draft, and treats an already-gone draft (404) as deleted", async () => {
    const calls = fakeFetch([new Response(null, { status: 204 }), json({ message: "404 Not found" }, { status: 404 })]);
    await api().deleteDraftNote("g/p", 11, 5);
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url.pathname).toBe("/api/v4/projects/g%2Fp/merge_requests/11/draft_notes/5");
    await expect(api().deleteDraftNote("g/p", 11, 5)).resolves.toBeUndefined();
  });
});

describe("repository", () => {
  it("encodes branch and ref names whole and maps 404 to null", async () => {
    const calls = fakeFetch([
      json(fx.branchResponse.data),
      json(fx.errorBodies.data.notFound, { status: 404 }),
      json(fx.commitResponse.data),
    ]);
    const branch = await api().getBranch("g/p", "feature/x");
    expect(calls[0].url.pathname).toBe("/api/v4/projects/g%2Fp/repository/branches/feature%2Fx");
    expect(branch?.commit.id).toBe(fx.branchResponse.data.commit.id);
    expect(await api().getBranch("g/p", "nope")).toBeNull();
    const commit = await api().getCommit("g/p", "release/1");
    expect(calls[2].url.pathname).toBe("/api/v4/projects/g%2Fp/repository/commits/release%2F1");
    expect(calls[2].url.searchParams.get("stats")).toBe("true");
    expect(commit?.stats).toEqual({ additions: 15, deletions: 10, total: 25 });
  });

  it("composes history filters and the compare query", async () => {
    const calls = fakeFetch([json([fx.commitResponse.data]), json(fx.compareResponse.data)]);
    await api().listCommits("g/p", {
      refName: "main", path: "src/", author: "randx",
      since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z", page: 1, perPage: 100,
    });
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      ref_name: "main", path: "src/", author: "randx",
      since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z", page: "1", per_page: "100",
    });
    const compare = await api().compare("g/p", "main", "feature");
    expect(Object.fromEntries(calls[1].url.searchParams)).toEqual({ from: "main", to: "feature" });
    expect(compare.commits).toHaveLength(1);
    expect(compare).not.toHaveProperty("merge_base_commit");
  });

  it("reads blobs raw, and stops reading an oversized one at the cap rather than after the body", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const calls = fakeFetch([
      new Response("This is a binary file", { headers: { "content-type": "text/plain" } }),
      new Response(endless, { headers: { "content-type": "application/octet-stream" } }),
      json(fx.errorBodies.data.notFound, { status: 404 }),
    ]);
    const bytes = await api().getBlob("g/p", fx.blobResponse.data.sha, 1 << 20);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("This is a binary file");
    expect(calls[0].url.pathname).toBe(`/api/v4/projects/g%2Fp/repository/blobs/${fx.blobResponse.data.sha}/raw`);
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok-1");
    expect(calls[0].headers.get("accept")).toBeNull();  // raw bytes, not the JSON envelope

    expect(await api().getBlob("g/p", fx.blobResponse.data.sha, 4096)).toBe("oversized");
    // Five 1 KiB chunks cross a 4 KiB cap; the stream was cancelled there, not drained.
    expect(pulled).toBeLessThanOrEqual(6);

    expect(await api().getBlob("g/p", "missing", 1 << 20)).toBeNull();
  });

  it("treats an unrelated-refs merge_base failure as null", async () => {
    fakeFetch([json({ message: "400 Bad request - Could not find merge base" }, { status: 400 })]);
    expect(await api().mergeBase("g/p", "a", "b")).toBeNull();
  });
});

describe("git smart-HTTP", () => {
  it("POSTs upload-pack with protocol v2, oauth2 basic auth, and the Access headers", async () => {
    const calls = fakeFetch([new Response("0000", {
      status: 200, headers: { "content-type": "application/x-git-upload-pack-result" },
    })]);
    const body = new TextEncoder().encode("0014command=fetch0000");
    const response = await api(ACCESS_INSTANCE).fetchGitUploadPack("group/sub/project", body);
    expect(response.ok).toBe(true);
    const [call] = calls;
    expect(call.url.toString()).toBe("https://gitlab-access.example.com/group/sub/project.git/git-upload-pack");
    expect(call.headers.get("git-protocol")).toBe("version=2");
    expect(call.headers.get("content-type")).toBe("application/x-git-upload-pack-request");
    expect(call.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:tok-1")}`);
    expect(call.headers.get("cf-access-client-id")).toBe("id.access");
    expect(call.init.redirect).toBe("manual");
  });

  it("POSTs receive-pack without a protocol header and with a streaming body", async () => {
    const calls = fakeFetch([new Response("0000", {
      status: 200, headers: { "content-type": "application/x-git-receive-pack-result" },
    })]);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0x30])); c.close(); } });
    await api().fetchGitReceivePack("g/p", stream);
    expect(calls[0].url.toString()).toBe("https://gitlab.example.com/g/p.git/git-receive-pack");
    expect(calls[0].headers.has("git-protocol")).toBe(false);
    expect(calls[0].init.body).toBe(stream);
  });

  it("reports a redirect on the git endpoint as an Access-policy problem rather than a parse error", async () => {
    fakeFetch([new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } })]);
    const error = await api().fetchGitUploadPack("g/p", new Uint8Array()).catch(e => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error.message).toMatch(/Access application must admit the service token/);
  });

  it("rejects a non-git content type (a login page) before streaming", async () => {
    fakeFetch([new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })]);
    const error = await api().fetchGitUploadPack("g/p", new Uint8Array()).catch(e => e);
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/expected application\/x-git-upload-pack-result/);
  });

  it("surfaces a non-OK status with the body's first 200 chars", async () => {
    fakeFetch([new Response("Repository not found", { status: 404 })]);
    const error = await api().fetchGitReceivePack("g/p", new ReadableStream()).catch(e => e);
    expect(error.status).toBe(404);
    expect(error.message).toBe("git push failed: 404 : Repository not found");
  });
});

describe("OAuth", () => {
  it("generates a 43-char base64url verifier and its S256 challenge", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("builds the authorize URL on the browser-facing origin with every documented param", () => {
    const url = new URL(buildAuthorizeUrl("https://gitlab.example.com", {
      clientId: "app", redirectUri: "https://os.example/gatekeeper/gitlab/oauth",
      scopes: ["api", "write_repository"], state: "doid:nonce", codeChallenge: "chal",
    }));
    expect(url.origin + url.pathname).toBe("https://gitlab.example.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "app",
      redirect_uri: "https://os.example/gatekeeper/gitlab/oauth",
      response_type: "code",
      scope: "api write_repository",
      state: "doid:nonce",
      code_challenge: "chal",
      code_challenge_method: "S256",
    });
  });

  it("exchanges a code with client_secret and code_verifier, and reads expiry from expires_in", async () => {
    const calls = fakeFetch([json(fx.oauthTokenResponse.data)]);
    const now = 1_700_000_000_000;
    const grant = await exchangeAuthCode(ACCESS_INSTANCE, {
      code: "c", clientId: "app", clientSecret: "s", redirectUri: "https://os/oauth", codeVerifier: "v",
    }, now);
    const [call] = calls;
    expect(call.url.toString()).toBe("https://gitlab-access.example.com/oauth/token");
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call.headers.get("cf-access-client-id")).toBe("id.access");
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      grant_type: "authorization_code", code: "c", client_id: "app", client_secret: "s",
      redirect_uri: "https://os/oauth", code_verifier: "v",
    });
    expect(grant).toEqual({
      accessToken: fx.oauthTokenResponse.data.access_token,
      refreshToken: fx.oauthTokenResponse.data.refresh_token,
      expiresAt: new Date(now + 7200 * 1000),
    });
  });

  it("honours a non-default expires_in rather than assuming two hours", async () => {
    fakeFetch([json({ ...fx.oauthTokenResponse.data, expires_in: 300 })]);
    const grant = await exchangeAuthCode(INSTANCE, {
      code: "c", clientId: "a", clientSecret: "s", redirectUri: "r", codeVerifier: "v",
    }, 0);
    expect(grant.expiresAt.getTime()).toBe(300_000);
  });

  it("rejects an incomplete token response", async () => {
    fakeFetch([json({ access_token: "x", token_type: "bearer" })]);
    const error = await exchangeAuthCode(INSTANCE, {
      code: "c", clientId: "a", clientSecret: "s", redirectUri: "r", codeVerifier: "v",
    }).catch(e => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error.message).toMatch(/incomplete/);
  });

  it("refreshes with redirect_uri and returns the rotated pair", async () => {
    const calls = fakeFetch([json(fx.oauthRefreshResponse.data)]);
    const result = await refreshAccessToken(INSTANCE, {
      refreshToken: "old", clientId: "app", clientSecret: "s", redirectUri: "https://os/oauth",
    }, 0);
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      grant_type: "refresh_token", refresh_token: "old", client_id: "app", client_secret: "s",
      redirect_uri: "https://os/oauth",
    });
    expect(result).toEqual({
      ok: true,
      grant: {
        accessToken: fx.oauthRefreshResponse.data.access_token,
        refreshToken: fx.oauthRefreshResponse.data.refresh_token,
        expiresAt: new Date(7200 * 1000),
      },
    });
  });

  it("classifies invalid_grant as revoked and throws on other refresh failures", async () => {
    fakeFetch([
      json(fx.oauthInvalidGrantResponse.data, { status: 400 }),
      new Response("upstream down", { status: 502 }),
    ]);
    const params = { refreshToken: "old", clientId: "a", clientSecret: "s", redirectUri: "r" };
    const revoked = await refreshAccessToken(INSTANCE, params);
    expect(revoked).toMatchObject({ ok: false, revoked: true });
    const failure = await refreshAccessToken(INSTANCE, params).catch(e => e);
    expect(failure).toBeInstanceOf(GitLabApiError);
    expect(failure.status).toBe(502);
  });

  it("revokes with client credentials and the token", async () => {
    const calls = fakeFetch([json({})]);
    await revokeToken(INSTANCE, { token: "t", clientId: "a", clientSecret: "s" });
    expect(calls[0].url.pathname).toBe("/oauth/revoke");
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ token: "t", client_id: "a", client_secret: "s" });
  });
});

describe("lineCode", () => {
  it("follows the documented <sha1(path)>_<old>_<new> formula", async () => {
    const code = await lineCode("package.json", 10, 10);
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode("package.json"));
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    expect(code).toBe(`${hex}_10_10`);
    expect(code).toMatch(/^[0-9a-f]{40}_10_10$/);
  });
});
