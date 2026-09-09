import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function setup(ctx: DurableObjectState, hasResources = true) {
  const description = {
    uniqueName: "person@example.com",
    grantedResourceUrlPatterns: hasResources
      ? ["https://dash.cloudflare.com/:accountId/notifications"]
      : [],
  };
  const existing = { describe: vi.fn(), revoke: vi.fn() };
  const fresh = {
    describe: vi.fn(async () => ({ uniqueName: description.uniqueName })),
    revoke: vi.fn(),
  };
  const record = { id: 0, vendorId: "cloudflare", account: existing, description };
  const put = vi.fn();
  const user = new UserDurableObject(ctx, {} as Cloudflare.Env);
  Object.assign(user, {
    storage: {
      nextAccountId: { get: () => 1 },
      connectedAccounts: { get: () => record, put },
    },
  });
  return { user, existing, fresh, record, put };
}

it.each([false, true])(
  "preserves resource grants during sign-in, including expired credentials (%s)",
  async (expired) => {
    await runInDurableObject(
      env.TEST_OVERSEER.getByName(crypto.randomUUID()),
      async (_instance, ctx) => {
        const { user, existing, fresh, record } = setup(ctx);
        Object.assign(record, { credentialsExpired: expired });
        expect(
          await user.linkConnectedAccountFromLogin(
            fresh as unknown as Fetcher<GatekeeperUser>,
            "cloudflare",
          ),
        ).toBe(0);
        expect(existing.describe).not.toHaveBeenCalled();
        expect(existing.revoke).not.toHaveBeenCalled();
        expect(fresh.revoke).toHaveBeenCalledOnce();
        expect(record.account).toBe(existing);
        expect(record).toHaveProperty("credentialsExpired", expired);
      },
    );
  },
);

it("refreshes billing-only credentials in place on sign-in", async () => {
  await runInDurableObject(
    env.TEST_OVERSEER.getByName(crypto.randomUUID()),
    async (_instance, ctx) => {
      const { user, existing, fresh, record } = setup(ctx, false);
      expect(
        await user.linkConnectedAccountFromLogin(
          fresh as unknown as Fetcher<GatekeeperUser>,
          "cloudflare",
        ),
      ).toBe(0);
      expect(existing.revoke).toHaveBeenCalledOnce();
      expect(fresh.revoke).not.toHaveBeenCalled();
      expect(record.account).toBe(fresh);
    },
  );
});
