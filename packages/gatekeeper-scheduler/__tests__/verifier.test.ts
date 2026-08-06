import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vite-plus/test";

const worker = createExecutionContext().exports as unknown as {
  ScheduleAccount(options: { props: { accountId: string } }): {
    getVerifier(): Promise<{ verify(): Promise<void> }>;
  };
};

it("exports a callable scheduler verifier", async () => {
  const account = worker.ScheduleAccount({ props: { accountId: "test-account" } });
  const verifier = await account.getVerifier();

  await expect(verifier.verify()).resolves.toBeUndefined();
});
