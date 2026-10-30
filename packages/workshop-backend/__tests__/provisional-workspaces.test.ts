import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

let userCounter = 0;
function freshUser() {
  const stub = env.TEST_USER.getByName(`provisional-workspaces-${++userCounter}`);
  return <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
}

describe("UserDurableObject.listProvisionalWorkspaces", () => {
  it("lists the workspaces listWorkspaces hides, until they are first active", async () => {
    const inDo = freshUser();
    await inDo(async user => {
      await user.newWorkspace("left", "Untitled Workspace");
      await user.newWorkspace("used", "Untitled Workspace");
      await user.setWorkspaceLastActive("used", new Date(), undefined);
    });

    const provisional = await inDo(user => user.listProvisionalWorkspaces());
    expect(provisional).toEqual([{ id: "left", title: "Untitled Workspace", created: expect.any(Date) }]);
    expect((await inDo(user => user.listWorkspaces())).map(workspace => workspace.id)).toEqual(["used"]);

    // Activity moves it to listWorkspaces; deleting it removes it from both.
    await inDo(user => user.setWorkspaceLastActive("left", new Date(), undefined));
    expect(await inDo(user => user.listProvisionalWorkspaces())).toEqual([]);
    await inDo(async user => {
      await user.newWorkspace("gone", "Untitled Workspace");
      await user.deleteWorkspace("gone");
    });
    expect(await inDo(user => user.listProvisionalWorkspaces())).toEqual([]);
  });
});
