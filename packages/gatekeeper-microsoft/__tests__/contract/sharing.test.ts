// What a binding allows against the live tenant when the user's own role is less than their grant:
// the fixture shares Phillip's `Shared with Sarah` folder with Sarah to view, while she is a member
// of Engineering, who can edit.

import { describe, expect, it } from "vitest";
import type { SharePointScopeInfo } from "../../src/types";
import { bind, facet, hooks, live, oneDrive, origin, run, unwrap } from "./tenant";

describe.skipIf(!live)("bindings to what's shared", { timeout: 120_000 }, () => {
  it("binds a folder shared with the user to view read-only, though the grant could write", async () => {
    const props = await bind("sarah", `${await oneDrive()}/Documents/Shared%20with%20Sarah`);
    const name = facet("shared-to-view");
    expect(unwrap(await hooks().describe(name, props))).toMatchObject({ tsType: "SharePointFolderReader" });
    expect(unwrap<SharePointScopeInfo>(await run(name, props, [["getScope"]]))).toMatchObject({ kind: "folder", can: { write: false } });
  });

  it("keeps write where the user can edit", async () => {
    const props = await bind("sarah", `${await origin()}/sites/Engineering/Shared%20Documents/Specs`);
    const name = facet("member-can-edit");
    expect(unwrap(await hooks().describe(name, props))).toMatchObject({ tsType: "SharePointFolderSession" });
    expect(unwrap<SharePointScopeInfo>(await run(name, props, [["getScope"]]))).toMatchObject({ can: { write: true } });
  });
});
