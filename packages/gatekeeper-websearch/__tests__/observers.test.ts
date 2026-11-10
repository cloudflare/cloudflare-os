import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";

it("admits every observer of public search results", async () => {
  const worker = createExecutionContext().exports;
  const gatekeeper = env.WEB_SEARCH_GATEKEEPER.getByName("observer-access");
  const owner = await worker.WebSearchAccount({}).getVerifier();
  const collaborator = await worker.WebSearchAccount({}).getVerifier();

  await expect(gatekeeper.verifyObserverAccess([
    { id: "owner", verifier: owner },
    { id: "collaborator", verifier: collaborator },
  ], [])).resolves.toEqual({ allowedObserverIds: ["owner", "collaborator"] });
  await expect(gatekeeper.verifyObserverAccess([], []))
    .resolves.toEqual({ allowedObserverIds: [] });
});
