// Behavior tests for the Google Drive, Docs, Sheets and Slides gatekeepers' observer checks: the
// files each read reports as subresources, how verifyObserverAccess() answers for them, and what
// addObserver() still enforces. Google is faked at the fetch layer, answering each file lookup by
// the caller's token, and the observers' accounts are real UserAccounts.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import {GOOGLE_DRIVE_RESOURCE, resourceUrlPatternsToOAuthScopes} from "../../src/resources";
import {presentation, shape, slide, text} from "../slides-fixture";
import type {TestHooks, WorkspaceBinding} from "./worker";

const testEnv = env as unknown as {
  GoogleDocGatekeeperImpl: DurableObjectNamespace;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const OWNER_TOKEN = "owner-token";

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const SLIDES_MIME = "application/vnd.google-apps.presentation";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const DOC = "doc-1";
const SHEET = "sheet-1";
const DECK = "deck-1";
/** A folder its viewers can see but not list. */
const LOCKED = "locked-folder";
/** A folder its viewers can list. */
const OPEN = "open-folder";
/** A file its viewers can see but not download. */
const RESTRICTED = "restricted-file";
/** A file its viewers can download. */
const REPORT = "report-file";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

type FileNode = {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  capabilities?: {canListChildren?: boolean; canDownload?: boolean};
};

type Observation = {
  title: string;
  subresources?: string[];
  excludeObservers?: string[];
};

/** What the fake Google answers with, which tests set. */
type WorkspaceBackendState = {
  /** The files each observer token may open, in Drive and in Docs, Sheets or Slides. */
  access: Map<string, string[]>;
  /** Observer tokens whose lookups fail as an outage would. */
  failing: Set<string>;
  /**
   * Observer tokens Docs, Sheets and Slides refuse with 403 and this `ErrorInfo` reason, as they
   * do one missing a scope.
   */
  refusals: Map<string, string>;
  /** Each file lookup an observer token made, as `<token> <host> <fileId>`. */
  lookups: string[];
};

type WorkspaceBackend = {
  state: WorkspaceBackendState;
  fetch(url: URL, init: RequestInit): Promise<Response>;
};

/** One document tab: the section break every body opens with, then one paragraph. */
const TAB = {
  tabProperties: {tabId: "t.0", title: "Tab 1"},
  documentTab: {
    body: {content: [
      {startIndex: 0, endIndex: 1, sectionBreak: {}},
      {
        startIndex: 1, endIndex: 7,
        paragraph: {
          elements: [{startIndex: 1, endIndex: 7, textRun: {content: "Hello\n", textStyle: {}}}],
          paragraphStyle: {namedStyleType: "NORMAL_TEXT"},
        },
      },
    ]},
    lists: {}, namedRanges: {},
  },
  childTabs: [],
};

const PRESENTATION = presentation([slide("s1", [shape("t1", text(["Intro"]), {placeholder: "TITLE"})])]);

/** One multipart `files.get` batch answer: each requested file, or a 404 for one not visible. */
function batchResponse(ids: string[], visible: (id: string) => FileNode | undefined): Response {
  const boundary = "workspace_batch";
  const parts = ids.map((id, index) => {
    const node = visible(id);
    return [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <response-item-${index}>`,
      "",
      node ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found",
      "Content-Type: application/json",
      "",
      node ? JSON.stringify(node) : JSON.stringify({error: {code: 404, message: "File not found"}}),
    ].join("\r\n");
  });
  return new Response(`${parts.join("\r\n")}\r\n--${boundary}--\r\n`, {
    headers: {"Content-Type": `multipart/mixed; boundary=${boundary}`},
  });
}

/** Every file Drive holds; the owner can open each. */
const FILES: Record<string, FileNode> = {
  [DOC]: {id: DOC, name: "Plan", mimeType: DOC_MIME, trashed: false},
  [SHEET]: {id: SHEET, name: "Forecast", mimeType: SHEET_MIME, trashed: false},
  [DECK]: {id: DECK, name: "Review", mimeType: SLIDES_MIME, trashed: false},
  [LOCKED]: {
    id: LOCKED, name: "Locked", mimeType: FOLDER_MIME, trashed: false, capabilities: {canListChildren: false},
  },
  [OPEN]: {
    id: OPEN, name: "Open", mimeType: FOLDER_MIME, trashed: false, capabilities: {canListChildren: true},
  },
  [RESTRICTED]: {
    id: RESTRICTED, name: "Restricted", mimeType: "text/csv", trashed: false, capabilities: {canDownload: false},
  },
  [REPORT]: {
    id: REPORT, name: "Report", mimeType: "text/csv", trashed: false, capabilities: {canDownload: true},
  },
};

/**
 * Drive, Docs, Sheets and Slides as far as these reads and checks use them. Every lookup answers
 * the owner, and answers an observer only for the files `access` grants its token (Drive with
 * 404, the others with 403), failing with 500 for a token in `failing` and, in Docs, Sheets and
 * Slides, with a reasoned 403 for a token in `refusals`.
 */
function workspaceBackend(): WorkspaceBackend {
  const state: WorkspaceBackendState = {access: new Map(), failing: new Set(), refusals: new Map(), lookups: []};
  const visible = (token: string, id: string): FileNode | undefined =>
    token === OWNER_TOKEN || state.access.get(token)?.includes(id) ? FILES[id] : undefined;
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    const observer = token !== OWNER_TOKEN;
    if (url.pathname === "/batch/drive/v3") {
      const ids = [...String(init.body).matchAll(/GET \/drive\/v3\/files\/([^?]+)\?/g)]
        .map(match => decodeURIComponent(match[1]));
      if (observer) state.lookups.push(...ids.map(id => `${token} drive ${id}`));
      if (state.failing.has(token)) return json({error: {code: 500, message: "Backend error"}}, 500);
      return batchResponse(ids, id => visible(token, id));
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (observer) state.lookups.push(`${token} ${url.hostname} ${id}`);
    if (state.failing.has(token)) return json({error: {code: 500, message: "Backend error"}}, 500);
    const reason = state.refusals.get(token);
    if (reason && url.hostname !== "www.googleapis.com") {
      return json({error: {code: 403, status: "PERMISSION_DENIED", message: "Refused", details: [
        {"@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com"},
      ]}}, 403);
    }
    const node = visible(token, id);
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
      return node
        ? json({...node, modifiedTime: "2026-10-01T10:00:00Z"})
        : json({error: {code: 404, message: "File not found"}}, 404);
    }
    if (!node) return json({error: {code: 403, message: "The caller does not have permission"}}, 403);
    switch (url.hostname) {
      case "docs.googleapis.com":
        return json({
          documentId: id, title: node.name, revisionId: "revision-1",
          ...(url.searchParams.has("fields") ? {} : {tabs: [TAB]}),
        });
      case "sheets.googleapis.com":
        return json({
          spreadsheetId: id, properties: {title: node.name},
          sheets: [{properties: {sheetId: 0, title: "Sheet1", index: 0}}],
        });
      case "slides.googleapis.com":
        return json({...PRESENTATION, presentationId: id, title: node.name});
    }
    return json({error: {code: 404, message: "Not found"}}, 404);
  };
  return {state, fetch: fetchImpl};
}

type Ownerless<P> = P extends {userObjectId: string} ? Omit<P, "userObjectId"> : P;
/** What a binding of `K` is made with, less the owner's account, which the harness supplies. */
type Scope<K extends WorkspaceBinding["kind"]> = Ownerless<Extract<WorkspaceBinding, {kind: K}>["props"]>;
type PropsOf<K extends WorkspaceBinding["kind"]> = Extract<WorkspaceBinding, {kind: K}>["props"];

function workspaceHarness<K extends WorkspaceBinding["kind"]>(
    backend: WorkspaceBackend, kind: K, scope: Scope<K>,
) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) =>
    backend.fetch(new URL(typeof input === "string" || input instanceof URL ? input : input.url), init));
  const name = `workspace-test-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  // A facet's ID only names its storage, so one namespace serves every kind.
  const id = testEnv.GoogleDocGatekeeperImpl.idFromName(name).toString();
  const facetName = `${kind}-${name}`;
  const queueId = `queue-${name}`;
  /** A connected Google account whose stored access token is `token`, with any `resources` granted. */
  const account = async (token: string, resources?: string[]): Promise<string> => {
    const accountId = testEnv.UserAccount.idFromName(`${name}-${token}`);
    await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("refreshToken", `${token}-refresh`);
      state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
      if (resources) {
        state.storage.kv.put("grantedResources", resources);
        state.storage.kv.put("grantedScopes", resourceUrlPatternsToOAuthScopes(resources));
      }
    });
    return accountId.toString();
  };
  const unowned = scope as object;
  const binding = account(OWNER_TOKEN).then(userObjectId =>
    ({kind, props: "creation" in unowned ? unowned : {userObjectId, ...unowned}}) as WorkspaceBinding);
  const propsOf = async <B extends WorkspaceBinding["kind"]>(expected: B): Promise<PropsOf<B>> => {
    const bound = await binding;
    if (bound.kind !== expected) throw new Error(`This harness binds ${bound.kind}, not ${expected}.`);
    return bound.props as PropsOf<B>;
  };
  return {
    docSession: async () => hook.openDocSession(facetName, id, await propsOf("doc"), queueId),
    sheetsSession: async () => hook.openSheetsSession(facetName, id, await propsOf("sheets"), queueId),
    slidesSession: async () => hook.openSlidesSession(facetName, id, await propsOf("slides"), queueId),
    driveSession: async () => hook.openDriveSession(facetName, id, await propsOf("drive"), queueId),
    /**
     * An observer's account, which Google lets open `files`, holding a Drive grant only with
     * `drive`.
     */
    observer: (token: string, files: string[], {drive = false} = {}): Promise<string> => {
      backend.state.access.set(token, files);
      return account(token, drive ? [GOOGLE_DRIVE_RESOURCE.urlPattern] : undefined);
    },
    addObserver: async (observerId: string, userObjectId: string) =>
      hook.workspaceAddObserver(facetName, id, await binding, queueId, observerId, userObjectId),
    verify: async (observers: Array<{id: string; userObjectId: string}>, subresources: string[]) =>
      hook.workspaceVerifyObserverAccess(facetName, id, await binding, observers, subresources),
    observations: async (): Promise<Observation[]> => {
      const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return observations as Observation[];
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Drive, Docs, Sheets and Slides observations", () => {
  it("report the bound file on every read of a Doc, Sheets or Slides binding, excluding nobody", async () => {
    const backend = workspaceBackend();
    const doc = workspaceHarness(backend, "doc", {documentId: DOC});
    await doc.addObserver("reader", await doc.observer("reader-token", [DOC]));
    using docSession = await doc.docSession();
    expect(await docSession.getMetadata()).toMatchObject({title: "Plan"});
    expect(await docSession.listTabs()).toMatchObject([{id: "t.0", title: "Tab 1"}]);

    const sheets = workspaceHarness(backend, "sheets", {spreadsheetId: SHEET});
    using sheetsSession = await sheets.sheetsSession();
    expect(await sheetsSession.getSpreadsheet()).toMatchObject({title: "Forecast"});

    const slides = workspaceHarness(backend, "slides", {presentationId: DECK});
    using slidesSession = await slides.slidesSession();
    expect(await slidesSession.getPresentation()).toMatchObject({title: "Review"});

    const docObservations = await doc.observations();
    expect(docObservations.map(observation => observation.subresources))
      .toEqual([[`docs/document/${DOC}`], [`docs/document/${DOC}`]]);
    expect((await sheets.observations()).map(observation => observation.subresources))
      .toEqual([[`sheets/spreadsheet/${SHEET}`]]);
    expect((await slides.observations()).map(observation => observation.subresources))
      .toEqual([[`slides/presentation/${DECK}`]]);
    for (const observation of docObservations) expect(observation.excludeObservers).toBeUndefined();
  });

  it("report nothing for a document not created yet", async () => {
    const doc = workspaceHarness(workspaceBackend(), "doc", {creation: {title: "Draft"}});
    using session = await doc.docSession();
    expect(await session.getMetadata()).toMatchObject({title: "Draft"});
    expect((await doc.observations()).map(observation => observation.subresources)).toEqual([[]]);
  });

  it("report each Drive file a read returns, then the document read through it, excluding nobody", async () => {
    const backend = workspaceBackend();
    const drive = workspaceHarness(backend, "drive", {scope: {kind: "account"}});
    // A viewer with a Drive grant who can see none of these files. The legacy tracker would
    // exclude them, and the queue refuses an observation that excludes an active observer.
    await drive.addObserver("viewer", await drive.observer("viewer-token", [], {drive: true}));
    using session = await drive.driveSession();
    expect(await session.getEntry(DOC)).toMatchObject({id: DOC, name: "Plan"});
    using doc = await session.openGoogleDoc(DOC);
    expect(await doc.getMetadata()).toMatchObject({title: "Plan"});
    expect(await doc.listTabs()).toMatchObject([{id: "t.0", title: "Tab 1"}]);

    const observations = await drive.observations();
    expect(observations.map(observation => observation.subresources)).toEqual([
      [`drive/file/${DOC}`], [`drive/file/${DOC}`], [`docs/document/${DOC}`], [`docs/document/${DOC}`],
    ]);
    for (const observation of observations) expect(observation.excludeObservers).toBeUndefined();
  });
});

describe("Drive, Docs, Sheets and Slides verifyObserverAccess", () => {
  it.each([
    {kind: "doc", scope: {documentId: DOC}, file: DOC, subresource: `docs/document/${DOC}`},
    {kind: "sheets", scope: {spreadsheetId: SHEET}, file: SHEET, subresource: `sheets/spreadsheet/${SHEET}`},
    {kind: "slides", scope: {presentationId: DECK}, file: DECK, subresource: `slides/presentation/${DECK}`},
  ] as const)("allows only the observers whose account can open the bound $kind file", async ({
    kind, scope, file, subresource,
  }) => {
    const binding = workspaceHarness(workspaceBackend(), kind, scope as Scope<typeof kind>);
    const observers = [
      {id: "reader", userObjectId: await binding.observer("reader-token", [file])},
      {id: "outsider", userObjectId: await binding.observer("outsider-token", [])},
    ];
    expect(await binding.verify(observers, [subresource])).toEqual({allowedObserverIds: ["reader"]});
  });

  it("allows a Drive file only to an account with a Drive grant, but a native file to any that opens it", async () => {
    const drive = workspaceHarness(workspaceBackend(), "drive", {scope: {kind: "account"}});
    const observers = [
      {id: "granted", userObjectId: await drive.observer("granted-token", [DOC], {drive: true})},
      {id: "ungranted", userObjectId: await drive.observer("ungranted-token", [DOC])},
      {id: "outsider", userObjectId: await drive.observer("outsider-token", [], {drive: true})},
    ];
    expect(await drive.verify(observers, [`drive/file/${DOC}`])).toEqual({allowedObserverIds: ["granted"]});
    expect(await drive.verify(observers, [`docs/document/${DOC}`]))
      .toEqual({allowedObserverIds: ["granted", "ungranted"]});
  });

  it("allows a Drive folder only to an account that can list it, though it can see it", async () => {
    const drive = workspaceHarness(workspaceBackend(), "drive", {scope: {kind: "account"}});
    const observers = [
      {id: "viewer", userObjectId: await drive.observer("viewer-token", [LOCKED, OPEN], {drive: true})},
    ];
    expect(await drive.verify(observers, [`drive/folder/${LOCKED}`])).toEqual({allowedObserverIds: []});
    expect(await drive.verify(observers, [`drive/file/${LOCKED}`])).toEqual({allowedObserverIds: ["viewer"]});
    expect(await drive.verify(observers, [`drive/folder/${OPEN}`, `drive/file/${LOCKED}`]))
      .toEqual({allowedObserverIds: ["viewer"]});
  });

  it("allows a Drive file's content only to an account that may download it, though it can see it", async () => {
    const drive = workspaceHarness(workspaceBackend(), "drive", {scope: {kind: "account"}});
    const observers = [
      {id: "viewer", userObjectId: await drive.observer("viewer-token", [RESTRICTED, REPORT], {drive: true})},
    ];
    expect(await drive.verify(observers, [`drive/content/${RESTRICTED}`])).toEqual({allowedObserverIds: []});
    expect(await drive.verify(observers, [`drive/file/${RESTRICTED}`])).toEqual({allowedObserverIds: ["viewer"]});
    expect(await drive.verify(observers, [`drive/content/${REPORT}`, `drive/file/${RESTRICTED}`]))
      .toEqual({allowedObserverIds: ["viewer"]});
  });

  it.each([
    {
      kind: "doc", scope: {documentId: DOC}, valid: `docs/document/${DOC}`,
      refused: ["sheets/spreadsheet/x", `drive/file/${DOC}`, "slides/presentation/x", "docs/document/d%6Fc"],
    },
    {
      kind: "sheets", scope: {spreadsheetId: SHEET}, valid: `sheets/spreadsheet/${SHEET}`,
      refused: ["docs/document/x", `drive/file/${SHEET}`, "sheets/spreadsheet/x/sheet/0"],
    },
    {
      kind: "slides", scope: {presentationId: DECK}, valid: `slides/presentation/${DECK}`,
      refused: ["sheets/spreadsheet/x", `drive/folder/${DECK}`],
    },
    {
      kind: "drive", scope: {scope: {kind: "account"}}, valid: `drive/file/${DOC}`,
      refused: [
        // Another Google gatekeeper's ID, which the observer's account could check.
        "calendar/freeBusy/alice%40example.com",
        "docs/document/d%6Fc",
        "drive/drive/x",
        "drive/file/x/folder/y",
        "drive/file",
      ],
    },
  ] as const)("refuses the whole $kind call for an ID that binding never reports", async ({
    kind, scope, valid, refused,
  }) => {
    const backend = workspaceBackend();
    const binding = workspaceHarness(backend, kind, scope as Scope<typeof kind>);
    const observers = [
      {id: "viewer", userObjectId: await binding.observer("viewer-token", [DOC, SHEET, DECK], {drive: true})},
    ];
    for (const id of refused) {
      await expect(binding.verify(observers, [valid, id]), id).rejects.toThrow(/subresource ID/);
    }
    expect(backend.state.lookups).toEqual([]);
  });

  it("fails the whole call when Docs cannot tell", async () => {
    const backend = workspaceBackend();
    const doc = workspaceHarness(backend, "doc", {documentId: DOC});
    const observers = [
      {id: "reader", userObjectId: await doc.observer("reader-token", [DOC])},
      {id: "flaky", userObjectId: await doc.observer("flaky-token", [DOC])},
    ];
    backend.state.failing.add("flaky-token");
    await expect(doc.verify(observers, [`docs/document/${DOC}`])).rejects.toThrow(/500/);
  });

  it("throws when Docs refuses for a reason, which says nothing about access, and asks again next time", async () => {
    const backend = workspaceBackend();
    const doc = workspaceHarness(backend, "doc", {documentId: DOC});
    const observers = [{id: "reader", userObjectId: await doc.observer("reader-token", [DOC])}];
    backend.state.refusals.set("reader-token", "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    await expect(doc.verify(observers, [`docs/document/${DOC}`])).rejects.toThrow(/http=403/);

    backend.state.refusals.clear();
    expect(await doc.verify(observers, [`docs/document/${DOC}`])).toEqual({allowedObserverIds: ["reader"]});
  });

  it("fails the whole call when Drive cannot tell", async () => {
    const backend = workspaceBackend();
    const drive = workspaceHarness(backend, "drive", {scope: {kind: "account"}});
    const observers = [
      {id: "viewer", userObjectId: await drive.observer("viewer-token", [DOC], {drive: true})},
      {id: "flaky", userObjectId: await drive.observer("flaky-token", [DOC], {drive: true})},
    ];
    backend.state.failing.add("flaky-token");
    await expect(drive.verify(observers, [`drive/file/${DOC}`])).rejects.toThrow(/500/);
  });
});

describe("Drive, Docs, Sheets and Slides addObserver", () => {
  it("still refuses a Doc observer who cannot open the document", async () => {
    const doc = workspaceHarness(workspaceBackend(), "doc", {documentId: DOC});
    await expect(doc.addObserver("outsider", await doc.observer("outsider-token", [])))
      .rejects.toThrow("does not have access to the bound Google Doc");
    await doc.addObserver("reader", await doc.observer("reader-token", [DOC]));
  });

  it("still refuses a Drive observer without a Drive grant, even one who can open the files", async () => {
    const drive = workspaceHarness(workspaceBackend(), "drive", {scope: {kind: "account"}});
    await expect(drive.addObserver("ungranted", await drive.observer("ungranted-token", [DOC])))
      .rejects.toThrow("has not granted Google Drive access");
    await drive.addObserver("granted", await drive.observer("granted-token", [], {drive: true}));
  });

  it("still refuses a Drive file binding's observer who cannot see the bound file", async () => {
    const drive = workspaceHarness(workspaceBackend(), "drive", {scope: {kind: "file", fileId: DOC}});
    await expect(drive.addObserver("outsider", await drive.observer("outsider-token", [], {drive: true})))
      .rejects.toThrow("cannot access Drive data this workspace has read");
    await drive.addObserver("viewer", await drive.observer("viewer-token", [DOC], {drive: true}));
  });
});
