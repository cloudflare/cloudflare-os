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
  const stub = env.TEST_USER.getByName(`user-commit-email-${++userCounter}`);
  // Calls go through runInDurableObject rather than the stub's RPC, whose rejections workerd
  // reports as uncaught exceptions even once the test has handled them.
  return <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
}

describe("UserDurableObject.setOwnCommitEmail", () => {
  it("sets and clears the profile's commit email", async () => {
    const inDo = freshUser();
    await inDo(u => u.setOwnCommitEmail("me@example.com"));
    expect((await inDo(u => u.whoami())).commitEmail).toBe("me@example.com");

    await inDo(u => u.setOwnCommitEmail(null));
    expect(await inDo(u => u.whoami())).not.toHaveProperty("commitEmail");
  });

  it("rejects addresses that could break out of a commit header", async () => {
    const inDo = freshUser();
    await inDo(u => u.setOwnCommitEmail("me@example.com"));
    for (const bad of ["me@example.com>\ncommitter x", "a <b@c>", "no-at-sign", "", "x@"]) {
      await expect(inDo(u => u.setOwnCommitEmail(bad))).rejects.toThrow(/Invalid commit email/);
    }
    expect((await inDo(u => u.whoami())).commitEmail).toBe("me@example.com");
  });
});
