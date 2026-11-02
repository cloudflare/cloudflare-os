import { describe, expect, it } from "vitest";
import type { OutlookDraft } from "../src/configurator/outlook-configurator-types";
import { normalizeAddress, type ConfiguratorConnection } from "../src/configurator-connection";
import { GraphApi } from "../src/graph-api";
import type { StoredIdentity } from "../src/microsoft-credentials";
import {
  OutlookConfiguratorUI, accessLevels, draftUrl, mailboxBatch, subjectSearch,
} from "../src/outlook-configurator";
import { bindingLink, parseOutlookUrl } from "../src/outlook-scope";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ALL_SCOPES = ["User.Read", "Mail.ReadWrite", "Mail.ReadWrite.Shared", "Mail.Send", "Mail.Send.Shared", "MailboxSettings.ReadWrite", "People.Read", "User.ReadBasic.All"];
const READ_SCOPES = ["User.Read", "Mail.Read", "People.Read", "MailboxSettings.Read"];

// -- a fake mailbox, served as Microsoft Graph would serve it --------------------------------------

type Folder = { id: string; displayName: string; parentFolderId: string; wellKnown?: string };
type Message = {
  id: string; folder: string; conversationId: string; from: string; fromName?: string; subject: string;
  receivedDateTime: string; isRead?: boolean; categories?: string[]; isDraft?: boolean;
};

const ROOT = "AAMkRoot";
const day = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function folders(): Folder[] {
  return [
    { id: "AAMkInbox", displayName: "Inbox", parentFolderId: ROOT, wellKnown: "inbox" },
    { id: "AAMkDrafts", displayName: "Drafts", parentFolderId: ROOT, wellKnown: "drafts" },
    { id: "AAMkSent", displayName: "Sent Items", parentFolderId: ROOT, wellKnown: "sentitems" },
    { id: "AAMkDeleted", displayName: "Deleted Items", parentFolderId: ROOT, wellKnown: "deleteditems" },
    { id: "AAMkJunk", displayName: "Junk Email", parentFolderId: ROOT, wellKnown: "junkemail" },
    { id: "AAMkArchive", displayName: "Archive", parentFolderId: ROOT, wellKnown: "archive" },
    { id: "AAMkZeta", displayName: "Zeta", parentFolderId: ROOT },
    { id: "AAMkProjects", displayName: "projects", parentFolderId: ROOT },
    { id: "AAMkApollo", displayName: "Apollo", parentFolderId: "AAMkProjects" },
    { id: "AAMkSpecs", displayName: "Specs", parentFolderId: "AAMkApollo" },
    { id: "AAMkVendors", displayName: "Vendors", parentFolderId: "AAMkInbox" },
  ];
}

function messages(): Message[] {
  return [
    { id: "AAMkM1", folder: "AAMkInbox", conversationId: "AAQkConvBudget", from: "sarah@contoso.com", fromName: "Sarah James", subject: "Q3 budget review", receivedDateTime: day(1), categories: ["Blue category"] },
    { id: "AAMkM2", folder: "AAMkSent", conversationId: "AAQkConvBudget", from: "phillip@contoso.com", fromName: "Phillip Jones", subject: "RE: Q3 budget review", receivedDateTime: day(0.5), isRead: true },
    { id: "AAMkM3", folder: "AAMkVendors", conversationId: "AAQkConvInvoice", from: "billing@fabrikam.com", subject: "Invoice 1042", receivedDateTime: day(10), isRead: true },
    { id: "AAMkM4", folder: "AAMkApollo", conversationId: "AAQkConvApollo", from: "bob@contoso.com", fromName: "Bob Smith", subject: "Apollo launch", receivedDateTime: day(40), categories: ["red category"] },
    { id: "AAMkM5", folder: "AAMkSpecs", conversationId: "AAQkConvSpecs", from: "sarah@contoso.com", fromName: "Sarah James", subject: "Specs draft", receivedDateTime: day(100), isRead: true },
    { id: "AAMkM6", folder: "AAMkDrafts", conversationId: "AAQkConvDraft", from: "phillip@contoso.com", subject: "Unsent thoughts", receivedDateTime: day(2), isDraft: true },
    { id: "AAMkM7", folder: "AAMkDeleted", conversationId: "AAQkConvGone", from: "sarah@contoso.com", fromName: "Sarah James", subject: "Old lunch plans", receivedDateTime: day(3), isRead: true },
    { id: "AAMkM8", folder: "AAMkInbox", conversationId: "AAQkConvNews", from: "news@fabrikam.com", subject: "Weekly news", receivedDateTime: day(5) },
  ];
}

class FakeGraph {
  folders = folders();
  messages = messages();
  requests: string[] = [];
  /** Shared mailboxes by address: whether they are shared with the user, and whether the directory can be read. */
  users: Record<string, { id: string; displayName: string; shared: boolean }> = {
    "support@contoso.com": { id: "11111111-2222-3333-4444-555555555555", displayName: "Contoso Support", shared: true },
    "sarah@contoso.com": { id: "66666666-2222-3333-4444-555555555555", displayName: "Sarah James", shared: false },
  };
  directoryReadable = true;
  mailboxEnabled = true;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (init?.method === "POST" && url.pathname === "/v1.0/$batch") {
      this.requests.push("/$batch");
      const { requests } = JSON.parse(String(init.body)) as { requests: { id: string; url: string }[] };
      const responses = requests.map(request => {
        const answer = this.answer(new URL(`https://graph.microsoft.com/v1.0/${request.url}`));
        return { id: request.id, status: answer.status, body: answer.body };
      });
      return Response.json({ responses });
    }
    const { status, body } = this.answer(url);
    return Response.json(body, { status });
  };

  answer(url: URL): { status: number; body: unknown } {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    this.requests.push(`${path}${url.search ? `?${decodeURIComponent(url.search.slice(1))}` : ""}`);
    const query = url.searchParams;
    if (path === "/me/people") {
      const term = query.get("$search")!.replace(/"/g, "").toLowerCase();
      const people = [
        { displayName: "Sarah James", scoredEmailAddresses: [{ address: "Sarah@Contoso.com" }] },
        { displayName: "Sarah James", scoredEmailAddresses: [{ address: "sarah@contoso.com" }] },
        { displayName: "Sam Ortiz", scoredEmailAddresses: [{ address: "sam@fabrikam.com" }] },
        { displayName: "No Address", scoredEmailAddresses: [] },
      ];
      return { status: 200, body: { value: people.filter(person => person.displayName.toLowerCase().includes(term)) } };
    }
    const users = /^\/users\/([^/]+)(\/.*)?$/.exec(path);
    let rest = path.replace(/^\/me/, "");
    if (users) {
      const key = users[1]!;
      const user = Object.entries(this.users).find(([address, candidate]) => address === key || candidate.id === key);
      if (users[2] === undefined) {
        if (!this.directoryReadable) return error(403, "Authorization_RequestDenied");
        return user ? { status: 200, body: { id: user[1].id, mail: user[0], displayName: user[1].displayName } } : error(404, "Request_ResourceNotFound");
      }
      if (!user) return error(404, "ErrorInvalidUser");
      if (!user[1].shared) return error(404, "ErrorItemNotFound");
      rest = users[2];
    } else if (!path.startsWith("/me")) {
      return error(400, "BadRequest");
    }
    if (!this.mailboxEnabled) return error(404, "MailboxNotEnabledForRESTAPI");
    if (rest === "/mailFolders") return this.page(this.folders.filter(folder => folder.parentFolderId === ROOT).map(folderJson), query, url);
    const folder = /^\/mailFolders\/([^/]+)(\/childFolders|\/messages)?$/.exec(rest);
    if (folder) {
      const found = this.folder(folder[1]!);
      if (!found) return error(404, "ErrorItemNotFound");
      if (folder[2] === "/childFolders") return this.page(this.folders.filter(child => child.parentFolderId === found.id).map(folderJson), query, url);
      if (folder[2] === "/messages") return this.listMessages(this.messages.filter(message => message.folder === found.id), query, url);
      return { status: 200, body: folderJson(found) };
    }
    if (rest === "/messages") return this.listMessages(this.messages, query, url);
    const message = /^\/messages\/([^/]+)$/.exec(rest);
    if (message) {
      const found = this.messages.find(candidate => candidate.id === message[1]);
      return found ? { status: 200, body: messageJson(found) } : error(404, "ErrorItemNotFound");
    }
    return error(400, `unexpected ${path}`);
  }

  folder(segment: string): Folder | undefined {
    if (segment === "msgfolderroot") return { id: ROOT, displayName: "Top of Information Store", parentFolderId: "" };
    return this.folders.find(folder => folder.id === segment || folder.wellKnown === segment);
  }

  listMessages(candidates: Message[], query: URLSearchParams, url: URL): { status: number; body: unknown } {
    let matched = candidates;
    const filter = query.get("$filter");
    if (filter) matched = matched.filter(message => matches(message, filter));
    const search = query.get("$search");
    if (search) {
      const words = [...search.matchAll(/subject:([^\s"]+)/g)].map(match => match[1]!.toLowerCase());
      matched = matched.filter(message => words.every(word => message.subject.toLowerCase().includes(word)));
    }
    if (query.get("$orderby") === "receivedDateTime desc" || search) matched = matched.toSorted((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
    return this.page(matched.map(messageJson), query, url);
  }

  page(rows: unknown[], query: URLSearchParams, url: URL): { status: number; body: Record<string, unknown> } {
    const top = Number(query.get("$top") ?? 10);
    const skip = Number(query.get("$skip") ?? 0);
    const body: Record<string, unknown> = { value: rows.slice(skip, skip + top) };
    if (skip + top < rows.length) {
      const next = new URL(url);
      next.searchParams.set("$skip", String(skip + top));
      body["@odata.nextLink"] = next.toString();
    }
    return { status: 200, body };
  }
}

function error(status: number, code: string) {
  return { status, body: { error: { code, message: `${code}.` } } };
}

function folderJson(folder: Folder) {
  const children = folders().filter(child => child.parentFolderId === folder.id).length;
  return { id: folder.id, displayName: folder.displayName, parentFolderId: folder.parentFolderId, childFolderCount: children };
}

function messageJson(message: Message) {
  return {
    id: message.id, parentFolderId: message.folder, conversationId: message.conversationId, subject: message.subject,
    from: { emailAddress: { address: message.from, ...(message.fromName ? { name: message.fromName } : {}) } },
    receivedDateTime: message.receivedDateTime, isRead: message.isRead === true, isDraft: message.isDraft === true,
    categories: message.categories ?? [],
  };
}

/** Evaluates the `$filter`s the configurator writes; anything else fails the test. */
function matches(message: Message, filter: string): boolean {
  return topLevel(filter, " and ").every(clause => {
    if (clause.startsWith("(") && clause.endsWith(")")) return topLevel(clause.slice(1, -1), " or ").some(part => matches(message, part));
    let match: RegExpExecArray | null;
    if ((match = /^receivedDateTime ge (\S+)$/.exec(clause))) return message.receivedDateTime >= match[1]!;
    if ((match = /^conversationId eq '(.*)'$/.exec(clause))) return message.conversationId === unquote(match[1]!);
    if ((match = /^from\/emailAddress\/address eq '(.*)'$/.exec(clause))) return message.from.toLowerCase() === unquote(match[1]!).toLowerCase();
    if ((match = /^categories\/any\(c:c eq '(.*)'\)$/.exec(clause))) return (message.categories ?? []).some(name => name.toLowerCase() === unquote(match![1]!).toLowerCase());
    if ((match = /^parentFolderId ne '(.*)'$/.exec(clause))) return message.folder !== unquote(match[1]!);
    throw new Error(`the fake can't evaluate ${clause}`);
  });
}

function topLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") depth--;
    else if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(text.slice(start, index));
      start = index + separator.length;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const unquote = (value: string) => value.replace(/''/g, "'");

function configurator(options: { scopes?: string[]; ceiling?: "read" | "draft" | "send"; graph?: FakeGraph } = {}) {
  const graph = options.graph ?? new FakeGraph();
  const identity: StoredIdentity = { tenantId: "t", objectId: "o", name: "Phillip Jones", username: "Phillip@Contoso.com", fetchedAt: NOW };
  const connection: ConfiguratorConnection = {
    identity: async () => identity,
    grantedScopes: async () => options.scopes ?? ALL_SCOPES,
    read: async op => await op(new GraphApi("token", { fetch: graph.fetch })),
  };
  return { graph, ui: new OutlookConfiguratorUI(connection, options.ceiling ?? "send", () => NOW) };
}

// -- pure helpers -----------------------------------------------------------------------------

describe("accessLevels", () => {
  it("offers every level the grant and the deployment allow, and shared mailboxes only what .Shared grants", () => {
    expect(accessLevels("send", ALL_SCOPES)).toEqual({ own: ["read", "draft", "send"], shared: ["read", "draft", "send"], limitedByDeployment: false });
    expect(accessLevels("draft", ALL_SCOPES)).toEqual({ own: ["read", "draft"], shared: ["read", "draft"], limitedByDeployment: true });
    expect(accessLevels("send", ["User.Read", "Mail.ReadWrite", "Mail.Read.Shared", "People.Read", "User.ReadBasic.All"]))
      .toEqual({ own: ["read", "draft"], shared: ["read"], limitedByDeployment: false });
    expect(accessLevels("send", READ_SCOPES)).toEqual({ own: ["read"], shared: [], limitedByDeployment: false });
    expect(accessLevels("send", ["User.Read"])).toEqual({ own: [], shared: [], limitedByDeployment: false });
  });
});

describe("draftUrl", () => {
  it("writes a draft as a binding URL that parseOutlookUrl reads back", () => {
    const draft: OutlookDraft = {
      mailbox: " Support@Contoso.com ", folder: { id: "AAMk/Folder+1==", subfolders: false },
      senders: ["Ada@Contoso.com", "@fabrikam.com"], access: "draft",
    };
    expect(parseOutlookUrl(draftUrl(draft))).toEqual({
      mailbox: "support@contoso.com", folder: "id:AAMk/Folder+1==", subfolders: false,
      senders: ["ada@contoso.com", "@fabrikam.com"], access: "draft",
    });
    expect(parseOutlookUrl(draftUrl({ conversationId: "AAQkConvBudget", access: "read" }))).toMatchObject({ conversationId: "AAQkConvBudget", access: "read" });
  });

  it("refuses what would put more than an ID in a path", () => {
    expect(() => draftUrl({ folder: { id: "../../me", subfolders: true }, access: "read" })).toThrow("That folder can't be read");
    expect(() => draftUrl({ mailbox: "not an address", access: "read" })).toThrow("isn't an email address");
  });
});

describe("bindingLink", () => {
  it("reads Outlook's Open in Outlook links as message links", () => {
    expect(bindingLink("https://outlook.office365.com/owa/?ItemID=AAMk%2Ba%2Fbc%3D&exvsurl=1&viewmodel=ReadMessageItem"))
      .toBe("https://outlook.office.com/mail/id/AAMk_a-bc%3D");
  });

  it("names a message in an Outlook link by the ID Graph reads", () => {
    expect(bindingLink("https://outlook.office.com/mail/inbox/id/AAQk%2FbPl%2B4%3D")).toBe("https://outlook.office.com/mail/inbox/id/AAQk-bPl_4%3D");
    expect(bindingLink("https://outlook.office.com/mail/inbox/id/AAMkM1")).toBe("https://outlook.office.com/mail/inbox/id/AAMkM1");
    expect(bindingLink("https://outlook.office.com/mail/inbox/id/%E0%A4%A")).toBe("https://outlook.office.com/mail/inbox/id/%E0%A4%A");
    expect(bindingLink("https://evil.example/owa/?ItemID=AAMk")).toBe("https://evil.example/owa/?ItemID=AAMk");
  });

  it("is how every Outlook link is read, so a link an agent pastes resolves as one the configurator saw", () => {
    expect(parseOutlookUrl("https://outlook.office.com/mail/inbox/id/AAQk%2FbPl%2B4%3D").messageId).toBe("AAQk-bPl_4=");
    expect(parseOutlookUrl("https://outlook.office365.com/owa/?ItemID=AAMk%2Ba%2Fbc%3D&exvsurl=1").messageId).toBe("AAMk_a-bc=");
    expect(() => parseOutlookUrl("https://outlook.office.com/mail/inbox/id/%E0%A4%A")).toThrow(/garbled/);
    expect(() => parseOutlookUrl("https://evil.example/owa/?ItemID=AAMk")).toThrow(/start with/);
  });
});

describe("subjectSearch", () => {
  it("requires every word in the subject and drops what KQL would read as syntax", () => {
    expect(subjectSearch("Q3 budget")).toBe('"subject:Q3 AND subject:budget"');
    expect(subjectSearch('-secret OR "x" (y) NOT')).toBe('"subject:secret AND subject:x AND subject:y"');
    expect(subjectSearch("  ")).toBeUndefined();
  });
});

describe("normalizeAddress", () => {
  it("lowercases addresses and refuses anything else", () => {
    expect(normalizeAddress(" Ada@Contoso.COM ")).toBe("ada@contoso.com");
    expect(() => normalizeAddress("ada@contoso")).toThrow();
    expect(() => normalizeAddress("ada@contoso.com/../x")).toThrow();
  });
});

describe("mailboxBatch", () => {
  it("sends four at a time, since Exchange throttles a fifth, and retries what it throttled", async () => {
    const sizes: number[] = [];
    let throttled = false;
    const api = {
      batch: async (requests: { id: string }[]) => {
        sizes.push(requests.length);
        return new Map(requests.map(request => {
          const status = request.id === "2" && !throttled ? 429 : 200;
          if (status === 429) throttled = true;
          return [request.id, { id: request.id, status, body: { id: request.id } }];
        }));
      },
    } as unknown as GraphApi;
    const requests = Array.from({ length: 6 }, (_, index) => ({ id: String(index), method: "GET" as const, url: `me/mailFolders/${index}` }));
    const answers = await mailboxBatch(api, requests, async () => {});
    expect(sizes).toEqual([4, 2, 1]);
    expect([...answers.values()].map(answer => answer.status)).toEqual([200, 200, 200, 200, 200, 200]);
  });
});

// -- the capability ---------------------------------------------------------------------------

describe("getStatus", () => {
  it("is ready with the user's address and the levels each kind of mailbox allows", async () => {
    expect(await configurator().ui.getStatus()).toEqual({
      state: "ready", me: { address: "phillip@contoso.com", name: "Phillip Jones" },
      levels: ["read", "draft", "send"], sharedLevels: ["read", "draft", "send"], limitedByDeployment: false,
    });
  });

  it("asks for access when the grant has no mail, and says so when there is no mailbox", async () => {
    expect(await configurator({ scopes: ["User.Read", "Files.Read.All"] }).ui.getStatus()).toEqual({ state: "needsAccess" });
    const graph = new FakeGraph();
    graph.mailboxEnabled = false;
    expect(await configurator({ graph }).ui.getStatus()).toMatchObject({ state: "unavailable", message: expect.stringMatching(/no Outlook mailbox/) });
  });
});

describe("listFolders", () => {
  it("lists Outlook's folders first, then the user's alphabetically, each parent before its subfolders", async () => {
    const { folders } = await configurator().ui.listFolders(null);
    expect(folders.map(folder => [folder.path, folder.depth, folder.kind, folder.descendants])).toEqual([
      ["Inbox", 0, "inbox", 1], ["Inbox/Vendors", 1, "folder", 0], ["Drafts", 0, "drafts", 0], ["Sent Items", 0, "sent", 0],
      ["Deleted Items", 0, "deleted", 0], ["Junk Email", 0, "junk", 0], ["Archive", 0, "archive", 0],
      ["projects", 0, "folder", 2], ["projects/Apollo", 1, "folder", 1], ["projects/Apollo/Specs", 2, "folder", 0], ["Zeta", 0, "folder", 0],
    ]);
    expect(folders[0]).toMatchObject({ id: "AAMkInbox", name: "Inbox" });
  });

  it("lists only the Inbox of a shared mailbox whose folder list can't be read", async () => {
    const graph = new FakeGraph();
    const ui = configurator({ graph }).ui;
    await ui.openSharedMailbox("support@contoso.com");
    const original = graph.answer.bind(graph);
    graph.answer = url => decodeURIComponent(url.pathname).endsWith("/mailFolders") ? error(403, "ErrorAccessDenied") : original(url);
    const list = await ui.listFolders("support@contoso.com");
    expect(list.folders.map(folder => folder.path)).toEqual(["Inbox"]);
    expect(list.notice).toMatch(/Only this mailbox's Inbox/);
  });
});

describe("searchPeople", () => {
  it("returns each person once, by lowercased address, and skips people with no address", async () => {
    const { ui, graph } = configurator();
    expect(await ui.searchPeople(' "sam"\\ ')).toEqual([{ address: "sam@fabrikam.com", name: "Sam Ortiz" }]);
    expect(graph.requests.at(-1)).toContain('$search="sam"');
    expect(await ui.searchPeople("sarah")).toEqual([{ address: "sarah@contoso.com", name: "Sarah James" }]);
    expect(await ui.searchPeople("   ")).toEqual([]);
  });
});

describe("openSharedMailbox", () => {
  it("opens a mailbox shared with the user, by its owner's name", async () => {
    expect(await configurator().ui.openSharedMailbox(" Support@Contoso.com ")).toEqual({ address: "support@contoso.com", name: "Contoso Support" });
  });

  it("tells a mailbox that doesn't exist from one that isn't shared, and refuses the user's own", async () => {
    const { ui } = configurator();
    await expect(ui.openSharedMailbox("nobody@contoso.com")).rejects.toThrow("There's no mailbox nobody@contoso.com in your organization");
    await expect(ui.openSharedMailbox("sarah@contoso.com")).rejects.toThrow("You haven't been given access to sarah@contoso.com");
    await expect(ui.openSharedMailbox("phillip@contoso.com")).rejects.toThrow("That's your own mailbox");
    await expect(ui.openSharedMailbox("support")).rejects.toThrow("isn't an email address");
  });

  it("asks again each time, so a mailbox shared a moment ago opens", async () => {
    const graph = new FakeGraph();
    const { ui } = configurator({ graph });
    graph.users["sarah@contoso.com"]!.shared = false;
    await expect(ui.openSharedMailbox("sarah@contoso.com")).rejects.toThrow("haven't been given access");
    graph.users["sarah@contoso.com"]!.shared = true;
    await expect(ui.openSharedMailbox("sarah@contoso.com")).resolves.toMatchObject({ name: "Sarah James" });
  });
});

describe("findConversations", () => {
  it("lists recent conversations by their latest message, leaving out drafts and Deleted Items", async () => {
    const { items } = await configurator().ui.findConversations(null, "");
    expect(items.map(item => [item.subject, item.from])).toEqual([
      ["RE: Q3 budget review", "Phillip Jones"], ["Weekly news", "news@fabrikam.com"], ["Invoice 1042", "billing@fabrikam.com"],
      ["Apollo launch", "Bob Smith"], ["Specs draft", "Sarah James"],
    ]);
  });

  it("searches subjects, and reads a pasted link as its message's conversation", async () => {
    const { ui } = configurator();
    expect((await ui.findConversations(null, "budget")).items.map(item => item.id)).toEqual(["AAQkConvBudget"]);
    expect((await ui.findConversations(null, "https://outlook.office.com/mail/inbox/id/AAMkM4")).items)
      .toEqual([{ id: "AAQkConvApollo", subject: "Apollo launch", from: "Bob Smith", receivedAt: day(40) }]);
    expect((await ui.findConversations(null, "https://outlook.office365.com/owa/?ItemID=AAMkM3&viewmodel=ReadMessageItem")).items[0]?.id).toBe("AAQkConvInvoice");
  });

  it("explains a link that isn't to a message, or is in another mailbox", async () => {
    const { ui } = configurator();
    await expect(ui.findConversations(null, "https://outlook.office.com/mail/inbox")).rejects.toThrow("isn't to a message");
    await expect(ui.findConversations(null, "https://example.com/mail/id/AAMkM4")).rejects.toThrow("Outlook links start with");
    await expect(ui.findConversations(null, "https://outlook.office.com/mail/support@contoso.com/id/AAMkM4")).rejects.toThrow("in the support@contoso.com mailbox");
  });
});

describe("resourceUrlFor and locate", () => {
  it("refuses a folder or conversation the mailbox doesn't have", async () => {
    const { ui } = configurator();
    await expect(ui.resourceUrlFor({ folder: { id: "AAMkMissing", subfolders: true }, access: "read" })).rejects.toThrow("isn't in the mailbox anymore");
    await expect(ui.resourceUrlFor({ conversationId: "AAQkNoSuchConv", access: "read" })).rejects.toThrow("conversation isn't in the mailbox");
  });

  it("writes the resolved binding URL, and reads it back as the frame shows it", async () => {
    const { ui } = configurator();
    const url = await ui.resourceUrlFor({ folder: { id: "AAMkApollo", subfolders: false }, senders: ["bob@contoso.com"], access: "draft" });
    expect(url).toBe("https://outlook.office.com/mail/folder/AAMkApollo/?subfolders=0&senders=bob%40contoso.com&access=draft");
    expect(await ui.locate(url)).toEqual({
      access: "draft", folder: { id: "AAMkApollo", path: "projects/Apollo", subfolders: false }, senders: ["bob@contoso.com"],
    });
  });

  it("binds a shared mailbox by its address and reads its name back", async () => {
    const { ui } = configurator();
    const url = await ui.resourceUrlFor({ mailbox: "support@contoso.com", access: "read" });
    expect(url).toBe("https://outlook.office.com/mail/support%40contoso.com/?access=read");
    expect(await ui.locate(url)).toEqual({ access: "read", mailbox: { address: "support@contoso.com", name: "Contoso Support" } });
  });

  it("refuses a level the mailbox doesn't allow, naming the most it does", async () => {
    await expect(configurator({ ceiling: "draft" }).ui.resourceUrlFor({ access: "send" })).rejects.toThrow('Choose up to "Draft and organize"');
    await expect(configurator({ scopes: ["User.Read", "Mail.ReadWrite", "Mail.Read.Shared", "People.Read", "User.ReadBasic.All"] }).ui
      .resourceUrlFor({ mailbox: "support@contoso.com", access: "draft" })).rejects.toThrow('Choose up to "Read only"');
  });

  it("locates an Outlook message link as its conversation, and lowers an access level beyond the ceiling", async () => {
    const { ui } = configurator({ ceiling: "draft" });
    expect(await ui.locate("https://outlook.office.com/mail/inbox/id/AAMkM1?access=send"))
      .toEqual({ access: "draft", conversation: { id: "AAQkConvBudget", subject: "Q3 budget review" } });
    expect(await ui.locate("https://outlook.office.com/mail/nowhere/")).toBeNull();
  });
});
