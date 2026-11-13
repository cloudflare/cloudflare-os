// The Workshop counts a collaborator as live for as long as a gatekeeper holds any stub to the
// approval queue it was handed, so every duplicate an Outlook session, cursor or hook delivery takes
// must be released with it, and only with it. TestHooks hands the facet a queue only the facet then
// holds, and reports when workerd releases it.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutlookGatekeeperProps } from "../../src/microsoft-env";
import { FakeGraph, PHILLIP, WRITE_SCOPES, facet, failure, hooks, json, seedAccount, unwrap } from "./fake-graph";

afterEach(() => {
  vi.unstubAllGlobals();
});

const MAIL_SCOPES = [
  ...WRITE_SCOPES,
  "https://graph.microsoft.com/Mail.Read", "https://graph.microsoft.com/People.Read", "https://graph.microsoft.com/User.ReadBasic.All",
];

const ROOT_FOLDER = "AAMkRootFolder";
const INBOX = "AAMkInboxFolder";
const MESSAGE_ONE = "AAMkMessageOne";
const MESSAGE_TWO = "AAMkMessageTwo";

const message = (id: string, receivedAt: string) => ({
  id, parentFolderId: INBOX, conversationId: `conv-${id}`, subject: `Subject ${id}`,
  from: { emailAddress: { address: "ada@contoso.com", name: "Ada" } }, toRecipients: [], ccRecipients: [], bccRecipients: [], replyTo: [],
  receivedDateTime: receivedAt, isDraft: false, isRead: false, importance: "normal", flag: { flagStatus: "notFlagged" },
  hasAttachments: false, bodyPreview: "", webLink: "",
});

/** Phillip's own mailbox, as much of it as these reads touch: Inbox under the root, and two messages a search finds, one page each. */
function outlookGraph(graph: FakeGraph): FakeGraph {
  return graph
    .on("POST", /^\/v1\.0\/\$batch$/, request => {
      const { requests } = JSON.parse(request.body ?? "{}") as { requests: Array<{ id: string; url: string }> };
      if (!requests.every(sub => sub.url.startsWith("me/mailFolders/"))) return undefined;
      const ids: Record<string, string> = { inbox: INBOX, msgfolderroot: ROOT_FOLDER };
      return json({
        responses: requests.map(sub => sub.id in ids
          ? { id: sub.id, status: 200, body: { id: ids[sub.id] } }
          : { id: sub.id, status: 404, body: { error: { code: "ErrorItemNotFound" } } }),
      });
    })
    .on("GET", new RegExp(`^/v1\\.0/me/mailFolders/${INBOX}(\\?|$)`), () => json({
      id: INBOX, displayName: "Inbox", parentFolderId: ROOT_FOLDER, childFolderCount: 0, unreadItemCount: 0, totalItemCount: 2,
    }))
    .on("GET", /^\/v1\.0\/organization(\?|$)/, () => json({ value: [{ verifiedDomains: [{ name: "contoso.com" }] }] }))
    .on("GET", /^\/v1\.0\/me\/messages(\?|$)/, request => request.url.searchParams.get("$skiptoken") === "2"
      ? json({ value: [message(MESSAGE_TWO, "2026-11-01T10:00:00Z")] })
      : json({
        value: [message(MESSAGE_ONE, "2026-11-02T10:00:00Z")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=2",
      }));
}

function mailbox(userObjectId: string): OutlookGatekeeperProps {
  return { userObjectId, scope: { mailbox: { kind: "me" }, access: "read" } };
}

let handles = 0;
const handle = (prefix: string) => `${prefix}-${++handles}`;

async function released(queue: string): Promise<void> {
  await vi.waitFor(async () => expect((await hooks().trackedQueue(queue)).released).toBe(true), { timeout: 2_000, interval: 20 });
}

describe("an Outlook session's approval queue", () => {
  it("is released when listMessages fails after it began the walk, once the session is disposed", async () => {
    const graph = outlookGraph(new FakeGraph().install());
    // Naming the listed folder fails: Inbox answers 500 when its path is walked.
    graph.on("GET", new RegExp(`^/v1\\.0/me/mailFolders/${INBOX}(\\?|$)`), () => json({ error: { code: "InternalServerError" } }, { status: 500 }));
    const id = await seedAccount(graph, PHILLIP, { scopes: MAIL_SCOPES });
    const name = facet("outlook-list-fails");
    const session = handle("list-fails");
    unwrap(await hooks().holdSession(session, name, mailbox(id)));

    expect(failure(await hooks().holdCall(session, "listMessages", []))).toMatch(/Microsoft Graph|500|Internal/i);
    await hooks().release(session);
    await released(session);
  });

  it("is released when search fails after it began the walk, once the session is disposed", async () => {
    const graph = outlookGraph(new FakeGraph().install());
    const id = await seedAccount(graph, PHILLIP, { scopes: MAIL_SCOPES });
    const name = facet("outlook-search-fails");
    // The binding was pinned to another account, so naming this mailbox's owner fails.
    await hooks().seed(name, mailbox(id), "pinnedUser", "someone/else");
    const session = handle("search-fails");
    unwrap(await hooks().holdSession(session, name, mailbox(id)));

    expect(failure(await hooks().holdCall(session, "search", ["hello"]))).toMatch(/different Microsoft 365 account/);
    await hooks().release(session);
    await released(session);
  });

  it("stays live for a cursor kept after its session is disposed, which still authorizes each page, until the cursor goes", async () => {
    const graph = outlookGraph(new FakeGraph().install());
    const id = await seedAccount(graph, PHILLIP, { scopes: MAIL_SCOPES });
    const name = facet("outlook-cursor-kept");
    const session = handle("cursor-session");
    const cursor = handle("cursor");
    unwrap(await hooks().holdSession(session, name, mailbox(id)));
    unwrap(await hooks().holdCall(session, "search", ["hello", { pageSize: 1 }], cursor));
    expect(unwrap<{ id: string }[]>(await hooks().holdCall(cursor, "next", [])).map(info => info.id)).toEqual([MESSAGE_ONE]);
    expect((await hooks().trackedQueue(session)).observations).toBe(1);

    await hooks().release(session);
    // The page is read and authorized over the connections the session's release went down first,
    // so a queue that release let go of would already be released when it comes back.
    expect(unwrap<{ id: string }[]>(await hooks().holdCall(cursor, "next", [])).map(info => info.id)).toEqual([MESSAGE_TWO]);
    expect(await hooks().trackedQueue(session)).toEqual({ released: false, observations: 2 });

    await hooks().release(cursor);
    await released(session);
  });
});

describe("an Outlook hook delivery's approval queue", () => {
  it("is released when the connection no longer grants Outlook", async () => {
    const graph = new FakeGraph().install();
    // A grant without Mail.Read: the binding's access can't be resolved.
    const id = await seedAccount(graph, PHILLIP, { scopes: WRITE_SCOPES });
    const delivery = handle("delivery");
    expect(failure(await hooks().trackedDeliver(delivery, facet("outlook-delivery-denied"), mailbox(id), MESSAGE_ONE)))
      .toMatch(/no longer grants Outlook access/);
    await released(delivery);
  });
});
