import { describe, expect, it } from "vitest";
import { describeAction, findWorkspaceParentPage, type NotionStore } from "../src/notion-actions";

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
