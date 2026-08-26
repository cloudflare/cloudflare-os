import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

let harness: Harness | undefined;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
});

afterAll(async () => {
  try {
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
    await harness?.server.close();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

function username(prefix: string): string {
  const value = nextUsernames(prefix).at(0);
  if (value === undefined) throw new Error("Failed to allocate a test username");
  return value;
}

it.concurrent("publishes, instantiates, and deletes an owned blueprint", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username("blueprint"));
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await authenticated.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const document = formats.find(format => format.output.id === "document");
  if (document === undefined) throw new Error("Document output format is not installed");
  using sourceWorkspace = await authenticated.newGadgetFromBlueprint(document.blueprintId, {});
  const sourceMetadata = await sourceWorkspace.getMetadata();
  const sourceGadgetId = sourceMetadata.defaultGadgetId;
  if (sourceGadgetId === undefined) throw new Error("Source workspace has no default Gadget");
  using sourceGadget = await sourceWorkspace.getGadget(sourceGadgetId);

  const blueprint = await sourceGadget.createBlueprint("Starter", "Deterministic starter");
  expect(await sourceWorkspace.listBlueprints()).toContainEqual(expect.objectContaining({
    id: blueprint.id,
    title: "Starter",
    description: "Deterministic starter",
  }));

  const owned = await waitFor("the published blueprint to reach the owner's list", async () => {
    const blueprints = await authenticated.listOwnBlueprints();
    return blueprints.some(entry => entry.id === blueprint.id) ? blueprints : null;
  });
  expect(owned).toContainEqual(expect.objectContaining({
    id: blueprint.id,
    source: {
      type: "workspace",
      workspaceId: sourceMetadata.id,
      workspaceTitle: sourceMetadata.title,
    },
  }));
  using installedWorkspace = await authenticated.newGadgetFromBlueprint(blueprint.id, {});
  const installedMetadata = await installedWorkspace.getMetadata();
  const installedGadgetId = installedMetadata.defaultGadgetId;
  if (installedGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
  using installedGadget = await installedWorkspace.getGadget(installedGadgetId);
  expect(await installedGadget.getTitle()).toBe("Starter");

  await sourceWorkspace.deleteBlueprint(blueprint.id);
  await waitFor("the deleted blueprint to leave the owner's list", async () =>
    (await authenticated.listOwnBlueprints()).some(entry => entry.id === blueprint.id)
      ? null
      : true);
  await installedWorkspace.deleteSelf();
  await sourceWorkspace.deleteSelf();
});

it.concurrent("creates and removes an indexed standard output", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username("output"));
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await authenticated.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const document = formats.find(format => format.output.id === "document");
  if (document === undefined) throw new Error("Document output format is not installed");
  expect(document.requiresSetup).toBe(false);

  using workspace = await authenticated.newGadgetFromBlueprint(document.blueprintId, {});
  const metadata = await workspace.getMetadata();
  const gadgetId = metadata.defaultGadgetId;
  if (gadgetId === undefined) throw new Error("Output workspace has no default Gadget");

  const indexed = await waitFor("the document to appear in the output index", async () => {
    const result = await authenticated.listOutputs();
    return result.outputs.some(output =>
      output.workspaceId === metadata.id && output.workpieceId === gadgetId)
      ? result.outputs
      : null;
  });
  expect(indexed).toContainEqual(expect.objectContaining({
    workspaceId: metadata.id,
    workpieceId: gadgetId,
    output: expect.objectContaining({ id: "document" }),
  }));

  using gadget = await workspace.getGadget(gadgetId);
  await gadget.remove();
  await waitFor("the removed document to leave the output index", async () =>
    (await authenticated.listOutputs()).outputs.some(output =>
      output.workspaceId === metadata.id && output.workpieceId === gadgetId)
      ? null
      : true);
  await workspace.deleteSelf();
});
