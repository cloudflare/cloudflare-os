import { describe, expect, it } from "vitest";
import { resourcesWithActionKinds } from "../src/action-catalog";
import { ALL_RESOURCES, CALENDAR_RESOURCE, OUTLOOK_RESOURCE, SHAREPOINT_RESOURCE } from "../src/microsoft-env";

const kindsOf = (urlPattern: string) =>
  Object.fromEntries(resourcesWithActionKinds().find(resource => resource.urlPattern === urlPattern)!
    .actionKinds!.map(({ kind, autoApprovable }) => [kind.tag, autoApprovable]));

describe("resourcesWithActionKinds", () => {
  it("keeps every resource, in order, so Calendar still matches ahead of Outlook", () => {
    expect(resourcesWithActionKinds().map(resource => resource.urlPattern))
      .toEqual(ALL_RESOURCES.map(resource => resource.urlPattern));
  });

  it("lists each resource's kinds, with sending and anything that mails someone never automatic", () => {
    expect(kindsOf(OUTLOOK_RESOURCE.urlPattern)).toMatchObject({ "outlook.drafts": true, "outlook.send": false });
    expect(kindsOf(CALENDAR_RESOURCE.urlPattern)).toMatchObject({
      "calendar.events": true, "calendar.invitations": false, "calendar.responses": false,
    });
    expect(Object.keys(kindsOf(SHAREPOINT_RESOURCE.urlPattern))).toEqual(expect.arrayContaining([
      "sharepoint.files.create", "sharepoint.files.edit", "sharepoint.files.delete", "sharepoint.lists.edit",
    ]));
  });
});
