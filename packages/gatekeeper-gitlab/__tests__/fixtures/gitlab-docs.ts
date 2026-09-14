// Response fixtures for the GitLab REST API, taken from the example responses in GitLab's own
// documentation (docs.gitlab.com/api/*, current at the time of writing). Each is labelled with
// its source so a fixture that has been replaced by a captured live response can be told from
// one that has not: `source: "docs"` fixtures are the documentation's examples; live checkpoints
// replace them with `source: "live"` captures (scrubbed) as the implementation is exercised
// against a real instance. A fixture still labelled `docs` after the push checkpoint is a review
// finding (plans/gitlab-gatekeeper.md, Verification).

export type FixtureSource = "docs" | "live";

/** Marker wrapper so the source label travels with the data without polluting the response shape. */
export type Fixture<T> = { source: FixtureSource; page: string; data: T };

function docs<T>(page: string, data: T): Fixture<T> {
  return { source: "docs", page, data };
}

/** `POST /oauth/token`, `grant_type=authorization_code` -- api/oauth2 "Authorization code flow". */
export const oauthTokenResponse = docs("api/oauth2", {
  access_token: "de6780bc506a0446309bd9362820ba8aed28aa506c71eedbe1c5c4f9dd350e54",
  token_type: "bearer",
  expires_in: 7200,
  refresh_token: "8257e65c97202ed1726cf9571600918f3bffb2544b26e00a61df9897668c33a1",
  created_at: 1607635748,
});

/** `POST /oauth/token`, `grant_type=refresh_token` -- rotated pair. */
export const oauthRefreshResponse = docs("api/oauth2", {
  access_token: "c97d1fe52119f38c7f67f0a14db68d60caa35ddc86fd12401718b649dcfa9c68",
  token_type: "bearer",
  expires_in: 7200,
  refresh_token: "803c1fd487fec35562c205dac93e9d8e08f9d3652a24079d704df3039df1158f",
  created_at: 1628711391,
});

/** The Doorkeeper `invalid_grant` body for a reused or revoked refresh token (shape is OAuth's, not GitLab-documented). */
export const oauthInvalidGrantResponse = docs("rfc6749", {
  error: "invalid_grant",
  error_description: "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.",
});

/** `GET /user` -- api/users "Retrieve the current user". Trailing fields trimmed. */
export const currentUserResponse = docs("api/users", {
  id: 1,
  username: "john_smith",
  email: "john@example.com",
  name: "John Smith",
  state: "active",
  locked: false,
  avatar_url: "http://localhost:3000/uploads/user/avatar/1/index.jpg",
  web_url: "http://localhost:3000/john_smith",
  created_at: "2012-05-23T08:00:58Z",
  public_email: "john@example.com",
  confirmed_at: "2012-05-23T09:05:22Z",
  commit_email: "admin@example.com",
});

/** `GET /users?username=` -- api/users "List all users". */
export const usersByUsernameResponse = docs("api/users", [
  {
    id: 1,
    username: "john_smith",
    name: "John Smith",
    state: "active",
    locked: false,
    avatar_url: "http://localhost:3000/uploads/user/avatar/1/cd8.jpeg",
    web_url: "http://localhost:3000/john_smith",
  },
]);

/** `GET /projects/:id` -- api/projects "Retrieve a project", the fields this gatekeeper reads. */
export const projectResponse = docs("api/projects", {
  id: 3,
  description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  default_branch: "main",
  visibility: "private" as const,
  http_url_to_repo: "http://example.com/diaspora/diaspora-project-site.git",
  web_url: "http://example.com/diaspora/diaspora-project-site",
  name: "Diaspora Project Site",
  path: "diaspora-project-site",
  path_with_namespace: "diaspora/diaspora-project-site",
  namespace: {
    id: 3,
    name: "Diaspora",
    path: "diaspora",
    kind: "group",
    full_path: "diaspora",
  },
  permissions: {
    project_access: { access_level: 10, notification_level: 3 },
    group_access: { access_level: 50, notification_level: 3 },
  },
  archived: false,
  empty_repo: false,
});

/** A public project seen by a non-member: both permission entries null -- api/projects "List all projects". */
export const publicProjectNonMemberResponse = docs("api/projects", {
  id: 4,
  description: null,
  default_branch: "main",
  visibility: "public" as const,
  web_url: "http://example.com/diaspora/diaspora-client",
  name: "Diaspora Client",
  path: "diaspora-client",
  path_with_namespace: "diaspora/diaspora-client",
  namespace: { id: 3, name: "Diaspora", path: "diaspora", kind: "group", full_path: "diaspora" },
  permissions: { project_access: null, group_access: null },
  archived: false,
  empty_repo: false,
});

/** `GET /projects/:id/issues` element -- api/issues "List all project issues" (label strings, no details). */
export const issueResponse = docs("api/issues", {
  project_id: 4,
  author: {
    state: "active",
    web_url: "https://gitlab.example.com/root",
    avatar_url: null,
    username: "root",
    id: 1,
    name: "Administrator",
  },
  description: "Omnis vero earum sunt corporis dolor et placeat.",
  state: "closed" as const,
  iid: 1,
  assignees: [{
    avatar_url: null,
    web_url: "https://gitlab.example.com/lennie",
    state: "active",
    username: "lennie",
    id: 9,
    name: "Dr. Luella Kovacek",
  }],
  type: "ISSUE",
  labels: ["foo", "bar"],
  id: 41,
  title: "Ut commodi ullam eos dolores perferendis nihil sunt.",
  updated_at: "2016-01-04T15:31:46.176Z",
  created_at: "2016-01-04T15:31:46.176Z",
  closed_at: "2016-01-05T15:31:46.176Z",
  user_notes_count: 1,
  web_url: "http://gitlab.example.com/my-group/my-project/issues/1",
  references: { short: "#1", relative: "#1", full: "my-group/my-project#1" },
});

/** A label object as `with_labels_details=true` returns it -- api/labels shape, fields the Issues doc promises. */
export const labelDetailsResponse = docs("api/labels", {
  id: 1,
  name: "bug",
  color: "#d9534f",
  text_color: "#FFFFFF",
  description: "Bug reported by user",
  description_html: "Bug reported by user",
});

/** `GET /projects/:id/merge_requests/:iid` -- api/merge_requests "Retrieve a merge request", trimmed to the fields read. */
export const mergeRequestResponse = docs("api/merge_requests", {
  id: 155016530,
  iid: 133,
  project_id: 15513260,
  title: "Manual job rules",
  description: "",
  state: "opened" as const,
  created_at: "2022-05-13T07:26:38.402Z",
  updated_at: "2022-05-14T03:38:31.354Z",
  merged_at: null,
  closed_at: null,
  target_branch: "main",
  source_branch: "manual-job-rules",
  user_notes_count: 0,
  author: {
    id: 4155490,
    username: "marcel.amirault",
    name: "Marcel Amirault",
    state: "active",
    avatar_url: "https://gitlab.com/uploads/-/system/user/avatar/4155490/avatar.png",
    web_url: "https://gitlab.com/marcel.amirault",
  },
  assignees: [],
  reviewers: [],
  source_project_id: 15513260,
  target_project_id: 15513260,
  labels: [],
  draft: false,
  merge_status: "can_be_merged",
  detailed_merge_status: "mergeable",
  sha: "e82eb4a098e32c796079ca3915e07487fc4db24c",
  merge_commit_sha: null,
  squash_commit_sha: null,
  should_remove_source_branch: null,
  references: { short: "!133", relative: "!133", full: "marcel.amirault/test-project!133" },
  web_url: "https://gitlab.com/marcel.amirault/test-project/-/merge_requests/133",
  squash: false,
  has_conflicts: false,
  changes_count: "1",
  // The inversion: `base_sha` is the MERGE BASE, `start_sha` the target head. Same here because
  // the target branch had not moved since the MR diverged.
  diff_refs: {
    base_sha: "1162f719d711319a2efb2a35566f3bfdadee8bab",
    head_sha: "e82eb4a098e32c796079ca3915e07487fc4db24c",
    start_sha: "1162f719d711319a2efb2a35566f3bfdadee8bab",
  },
  user: { can_merge: true },
});

/** `GET …/merge_requests/:iid/approvals` -- api/merge_request_approvals. */
export const approvalsResponse = docs("api/merge_request_approvals", {
  id: 5,
  iid: 5,
  project_id: 1,
  approvals_required: 2,
  approvals_left: 1,
  approved: true,
  approved_by: [{
    user: {
      name: "Administrator",
      username: "root",
      id: 1,
      state: "active",
      avatar_url: "http://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=80&d=identicon",
      web_url: "http://localhost:3000/root",
    },
    approved_at: "2016-06-09T01:45:21.720Z",
  }],
});

/** `GET …/merge_requests/:iid/diffs?per_page=2` -- api/merge_requests "List merge request diffs". */
export const mergeRequestDiffsResponse = docs("api/merge_requests", [
  {
    old_path: "README",
    new_path: "README",
    a_mode: "100644",
    b_mode: "100644",
    diff: "@@ -1 +1 @@\n-Title\n+README",
    collapsed: false,
    too_large: false,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    generated_file: false,
  },
  {
    old_path: "VERSION",
    new_path: "VERSION",
    a_mode: "100644",
    b_mode: "100644",
    diff: "@@ -1 +1 @@\n-1.9.7\n+1.9.8",
    collapsed: false,
    too_large: false,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    generated_file: false,
  },
]);

/** Issue notes -- api/notes "List all issue notes" (first is a system note). */
export const issueNotesResponse = docs("api/notes", [
  {
    id: 302,
    body: "closed",
    author: { id: 1, username: "pipin", name: "Pip", state: "active", web_url: "http://localhost:3000/pipin" },
    created_at: "2013-10-02T09:22:45Z",
    updated_at: "2013-10-02T10:22:45Z",
    system: true,
    noteable_id: 377,
    noteable_type: "Issue",
    project_id: 5,
    noteable_iid: 377,
    resolvable: false,
    confidential: false,
    internal: false,
  },
  {
    id: 305,
    body: "Text of the comment\r\n",
    author: { id: 1, username: "pipin", name: "Pip", state: "active", web_url: "http://localhost:3000/pipin" },
    created_at: "2013-10-02T09:56:03Z",
    updated_at: "2013-10-02T09:56:03Z",
    system: false,
    noteable_id: 121,
    noteable_type: "Issue",
    project_id: 5,
    noteable_iid: 121,
    resolvable: false,
    confidential: false,
    internal: false,
  },
]);

/**
 * `GET …/issues/:iid/discussions` -- api/discussions "List all issue discussion items": a thread
 * (two `DiscussionNote`s, the second a reply) and a standalone comment (`individual_note`).
 * A reply never appears in the notes endpoint, which is why discussions are read instead.
 */
export const issueDiscussionsResponse = docs("api/discussions", [
  {
    id: "6a9c1750b37d513a43987b574953fceb50b03ce7",
    individual_note: false,
    notes: [
      {
        id: 1126, type: "DiscussionNote", body: "discussion text",
        author: { id: 1, username: "root", name: "root", state: "active", avatar_url: null, web_url: "http://localhost:3000/root" },
        created_at: "2018-03-03T21:54:39.668Z", updated_at: "2018-03-03T21:54:39.668Z",
        system: false, noteable_id: 3, noteable_type: "Issue", project_id: 5, noteable_iid: 1, resolvable: false,
      },
      {
        id: 1129, type: "DiscussionNote", body: "reply to the discussion",
        author: { id: 1, username: "root", name: "root", state: "active", avatar_url: null, web_url: "http://localhost:3000/root" },
        created_at: "2018-03-04T13:38:02.127Z", updated_at: "2018-03-04T13:38:02.127Z",
        system: false, noteable_id: 3, noteable_type: "Issue", project_id: 5, noteable_iid: 1, resolvable: false,
      },
    ],
  },
  {
    id: "87805b7c09016a7058e91bdbe7b29d1f284a39e6",
    individual_note: true,
    notes: [
      {
        id: 1128, type: null, body: "a single comment",
        author: { id: 1, username: "root", name: "root", state: "active", avatar_url: null, web_url: "http://localhost:3000/root" },
        created_at: "2018-03-04T09:17:22.520Z", updated_at: "2018-03-04T09:17:22.520Z",
        system: false, noteable_id: 3, noteable_type: "Issue", project_id: 5, noteable_iid: 1, resolvable: false,
      },
    ],
  },
]);

/** An MR diff discussion -- api/discussions "List all merge request discussion items". */
export const diffDiscussionResponse = docs("api/discussions", {
  id: "87805b7c09016a7058e91bdbe7b29d1f284a39e6",
  individual_note: false,
  notes: [{
    id: 1128,
    type: "DiffNote" as const,
    body: "diff comment",
    author: {
      id: 1,
      name: "root",
      username: "root",
      state: "active",
      avatar_url: "https://www.gravatar.com/avatar/00afb8fb6ab07c3ee3e9c1f38777e2f4?s=80&d=identicon",
      web_url: "http://localhost:3000/root",
    },
    created_at: "2018-03-04T09:17:22.520Z",
    updated_at: "2018-03-04T09:17:22.520Z",
    system: false,
    noteable_id: 3,
    noteable_type: "MergeRequest",
    project_id: 5,
    noteable_iid: null,
    commit_id: "4803c71e6b1833ca72b8b26ef2ecd5adc8a38031",
    position: {
      base_sha: "b5d6e7b1613fca24d250fa8e5bc7bcc3dd6002ef",
      start_sha: "7c9c2ead8a320fb7ba0b4e234bd9529a2614e306",
      head_sha: "4803c71e6b1833ca72b8b26ef2ecd5adc8a38031",
      old_path: "package.json",
      new_path: "package.json",
      position_type: "text" as const,
      old_line: 27,
      new_line: 27,
      line_range: {
        start: { line_code: "588440f66559714280628a4f9799f0c4eb880a4a_10_10", type: "new" as const, old_line: null, new_line: 10 },
        end: { line_code: "588440f66559714280628a4f9799f0c4eb880a4a_11_11", type: "old" as const, old_line: 11, new_line: 11 },
      },
    },
    resolved: false,
    resolvable: true,
    resolved_by: null,
  }],
});

/** `GET …/draft_notes` -- api/draft_notes. */
export const draftNotesResponse = docs("api/draft_notes", [{
  id: 5,
  author_id: 23,
  merge_request_id: 11,
  resolve_discussion: false,
  discussion_id: null,
  note: "Example title",
  commit_id: null,
  line_code: null,
  position: {
    base_sha: null,
    start_sha: null,
    head_sha: null,
    old_path: null,
    new_path: null,
    position_type: "text",
    old_line: null,
    new_line: null,
    line_range: null,
  },
}]);

/** `GET /projects/:id/repository/commits/:sha` -- api/commits "Retrieve a commit". */
export const commitResponse = docs("api/commits", {
  id: "6104942438c14ec7bd21c6cd5bd995272b3faff6",
  short_id: "6104942438c",
  title: "Sanitize for network graph",
  author_name: "randx",
  author_email: "user@example.com",
  committer_name: "Dmitriy",
  committer_email: "user@example.com",
  created_at: "2021-09-20T09:06:12.300+03:00",
  message: "Sanitize for network graph",
  committed_date: "2021-09-20T09:06:12.300+03:00",
  authored_date: "2021-09-20T09:06:12.420+03:00",
  parent_ids: ["ae1d9fb46aa2b07ee9836d49862ec4e2c46fbbba"],
  stats: { additions: 15, deletions: 10, total: 25 },
  status: "running",
  web_url: "https://gitlab.example.com/janedoe/gitlab-foss/-/commit/6104942438c14ec7bd21c6cd5bd995272b3faff6",
});

/** `GET /projects/:id/repository/branches/:branch` -- api/branches "Retrieve a repository branch". */
export const branchResponse = docs("api/branches", {
  name: "main",
  merged: false,
  protected: true,
  default: true,
  developers_can_push: false,
  developers_can_merge: false,
  can_push: true,
  web_url: "https://gitlab.example.com/my-group/my-project/-/tree/main",
  commit: {
    id: "7b5c3cc8be40ee161ae89a06bba6229da1032a0c",
    short_id: "7b5c3cc",
    created_at: "2012-06-28T03:44:20-07:00",
    parent_ids: ["4ad91d3c1144c406e50c7b33bae684bd6837faf8"],
    title: "add projects API",
    message: "add projects API",
    author_name: "John Smith",
    author_email: "john@example.com",
    authored_date: "2012-06-27T05:51:39-07:00",
    committer_name: "John Smith",
    committer_email: "john@example.com",
    committed_date: "2012-06-28T03:44:20-07:00",
    web_url: "https://gitlab.example.com/my-group/my-project/-/commit/7b5c3cc8be40ee161ae89a06bba6229da1032a0c",
  },
});

/** `GET /projects/:id/repository/tags` element -- api/tags (a lightweight tag: `target === commit.id`). */
export const tagResponse = docs("api/tags", {
  commit: {
    id: "2695effb5807a22ff3d138d593fd856244e155e7",
    short_id: "2695effb",
    title: "Initial commit",
    created_at: "2017-07-26T11:08:53.000+02:00",
    parent_ids: ["2a4b78934375d7f53875269ffd4f45fd83a84ebe"],
    message: "Initial commit",
    author_name: "John Smith",
    author_email: "john@example.com",
    authored_date: "2012-05-28T04:42:42-07:00",
    committer_name: "Jack Smith",
    committer_email: "jack@example.com",
    committed_date: "2012-05-28T04:42:42-07:00",
  },
  release: { tag_name: "1.0.0", description: "Amazing release. Wow" },
  name: "v1.0.0",
  target: "2695effb5807a22ff3d138d593fd856244e155e7",
  message: null,
  protected: true,
  created_at: "2017-07-26T11:08:53.000+02:00",
});

/** `GET /projects/:id/repository/compare?from=main&to=feature` -- api/repositories. No merge base in the response. */
export const compareResponse = docs("api/repositories", {
  commit: {
    id: "12d65c8dd2b2676fa3ac47d955accc085a37a9c1",
    short_id: "12d65c8dd2b",
    title: "JS fix",
    author_name: "Example User",
    author_email: "user@example.com",
    created_at: "2014-02-27T10:27:00+02:00",
  },
  commits: [{
    id: "12d65c8dd2b2676fa3ac47d955accc085a37a9c1",
    short_id: "12d65c8dd2b",
    title: "JS fix",
    author_name: "Example User",
    author_email: "user@example.com",
    created_at: "2014-02-27T10:27:00+02:00",
  }],
  diffs: [{
    old_path: "files/js/application.js",
    new_path: "files/js/application.js",
    a_mode: null,
    b_mode: "100644",
    diff: "@@ -24,8 +24,10 @@\n //= require g.raphael-min\n //= require g.bar-min\n //= require branch-graph\n-//= require highlightjs.min\n-//= require ace/ace\n //= require_tree .\n //= require d3\n //= require underscore\n+\n+function fix() { \n+  alert(\"Fixed\")\n+}",
    collapsed: false,
    too_large: false,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
  }],
  compare_timeout: false,
  compare_same_ref: false,
  web_url: "https://gitlab.example.com/janedoe/gitlab-foss/-/compare/ae73cb07c9eeaf35924a10f713b364d32b2dd34f...0b4bc9a49b562e85de7cc9e834518ea6828729b9",
});

/** `GET /projects/:id/repository/merge_base?refs[]=&refs[]=` -- api/repositories "Get merge base". */
export const mergeBaseResponse = docs("api/repositories", {
  id: "1a0b36b3cdad1d2ee32457c102a8c0b7056fa863",
  short_id: "1a0b36b3",
  title: "Initial commit",
  created_at: "2014-02-27T08:03:18.000Z",
  parent_ids: [],
  message: "Initial commit\n",
  author_name: "Example User",
  author_email: "user@example.com",
  authored_date: "2014-02-27T08:03:18.000Z",
  committer_name: "Example User",
  committer_email: "user@example.com",
  committed_date: "2014-02-27T08:03:18.000Z",
  web_url: "https://gitlab.example.com/example-group/example-project/-/commit/1a0b36b3cdad1d2ee32457c102a8c0b7056fa863",
});

/** `GET /projects/:id/repository/blobs/:sha` -- api/repositories "Retrieve a blob". */
export const blobResponse = docs("api/repositories", {
  size: 1476,
  encoding: "base64",
  content: "VGhpcyBpcyBhIGJpbmFyeSBmaWxl",
  sha: "79f7bbd25901e8334750839545a9bd021f0e4c83",
});

/** Documented error bodies -- api/rest/troubleshooting and api/rest/authentication. */
export const errorBodies = docs("api/rest", {
  notFound: { message: "404 Project Not Found" },
  missingAttribute: { message: "400 (Bad request) \"title\" not given" },
  validation: { message: { bio: ["is too long (maximum is 255 characters)"] } },
  insufficientScope: {
    error: "insufficient_scope",
    error_description: "The request requires higher privileges than provided by the access token.",
    scope: "sudo",
  },
  unauthorized: { message: "401 Unauthorized" },
  mergeShaMismatch: { message: "SHA does not match HEAD of source branch" },
  mergeNotAllowed: { message: "405 Method Not Allowed" },
});
