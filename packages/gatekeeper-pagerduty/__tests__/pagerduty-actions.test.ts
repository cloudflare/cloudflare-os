// The kinds of change each resource advertises before anything is connected.

import { describe, expect, it } from "vitest";
import { RESOURCES_WITH_ACTION_KINDS } from "../src/pagerduty-actions";

const INCIDENT = [
  "acknowledge-incidents", "resolve-incidents", "edit-incidents", "add-notes", "reassign-incidents",
  "request-responders", "post-status-updates",
];
const SCHEDULE = ["manage-overrides", "delete-overrides"];

describe("RESOURCES_WITH_ACTION_KINDS", () => {
  it("advertises the kinds each resource's bindings can submit", () => {
    const tags = (title: string) => RESOURCES_WITH_ACTION_KINDS.find(resource => resource.title === title)
      ?.actionKinds?.map(({ kind }) => kind.tag);
    expect(tags("PagerDuty Account")).toEqual([...INCIDENT, "create-incidents", ...SCHEDULE]);
    expect(tags("PagerDuty Team")).toEqual([...INCIDENT, "create-incidents", ...SCHEDULE]);
    expect(tags("PagerDuty Service")).toEqual([...INCIDENT, "create-incidents"]);
    expect(tags("PagerDuty Incident")).toEqual(INCIDENT);
    expect(tags("PagerDuty Schedule")).toEqual(SCHEDULE);
  });

  it("marks kinds that always page someone or remove something as never automatic", () => {
    const account = RESOURCES_WITH_ACTION_KINDS.find(resource => resource.title === "PagerDuty Account")!;
    expect(account.actionKinds!.filter(entry => !entry.autoApprovable).map(({ kind }) => kind.tag))
      .toEqual(["reassign-incidents", "request-responders", "post-status-updates", "create-incidents",
        "delete-overrides"]);
  });
});
