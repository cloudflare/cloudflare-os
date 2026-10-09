// GitLab runs a line of posted Markdown that starts with `/name` as a quick action on the issue
// or merge request, whatever the approved action said; every text this gatekeeper posts is escaped
// so that no such line runs.

import { describe, expect, it } from "vitest";
import { escapeQuickActions } from "../src/gitlab-action-types";

describe("escapeQuickActions", () => {
  it("escapes every line GitLab would run, on any line of the text", () => {
    expect(escapeQuickActions("/approve")).toBe("\\/approve");
    expect(escapeQuickActions("Done.\n/clone other/project --with_notes\nThanks"))
      .toBe("Done.\n\\/clone other/project --with_notes\nThanks");
    // GitLab deletes carriage returns before matching, so each of these runs as /approve.
    expect(escapeQuickActions("Done.\r\n/app\rrove\r\n")).toBe("Done.\r\n\\/app\rrove\r\n");
    expect(escapeQuickActions("/\r\rapprove")).toBe("\\/\r\rapprove");
  });

  it("leaves lines GitLab would not run, so paths and escaped text read unchanged", () => {
    for (const text of ["see /approve", " /approve", "/usr/bin/env node", "/", "\\/approve"]) {
      expect(escapeQuickActions(text)).toBe(text);
    }
  });
});
