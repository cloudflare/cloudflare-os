// What a binding's reads report for observers, and how its verifyObserverAccess checks a
// collaborator against that: with their own account, which reuses its answers across bindings, in
// the owner's organization only. And what admission still checks, and the history export names,
// from before reads reported subresources.

import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHAREPOINT_RESOURCE, scopesFor, type Env } from "../../src/microsoft-env";
import { calendarSubresourceId, qualifiedSubresourceId, sharePointSubresourceId, tenantSubresourceId } from "../../src/subresources";
import {
  BRIEF, DEEP, DRIVE, EMPTY, FakeGraph, MALLORY, NOTES, OTHER_TENANT, PHILLIP, SARAH, SPECS, TENANT,
  facet, failure, folderProps, hooks, json, props, reconnectAs, ref, seedAccount, storedGrant, unwrap,
} from "./fake-graph";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const item = (itemId: string) => sharePointSubresourceId({ kind: "item", driveId: DRIVE, itemId });
const tenant = tenantSubresourceId(TENANT);

/** The subresources the last read through facet `name` reported. */
async function lastReported(name: string): Promise<string[]> {
  return (await hooks().queueLog(name)).observations.at(-1)!.subresources!;
}

describe("what reads report", () => {
  it("name the folder and every child a listing revealed, which a collaborator must open", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const binding = folderProps(id);
    const name = facet("report-listing");
    unwrap(await hooks().run(name, binding, [["list"]], { pages: 10 }));
    const reported = await lastReported(name);
    expect(reported.toSorted()).toEqual([SPECS, DEEP, EMPTY, BRIEF].map(item).toSorted());

    expect(unwrap(await hooks().verifyObserverAccess(name, binding, { sarah }, reported))).toEqual(["sarah"]);
    expect(graph.probedItems(SARAH).toSorted()).toEqual([SPECS, DEEP, EMPTY, BRIEF].toSorted());
  });

  it("deny a collaborator who can't open one of them, and nobody else", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    graph.hide(SARAH, BRIEF);
    const binding = folderProps(id);
    const name = facet("report-hidden");
    unwrap(await hooks().run(name, binding, [["list"]], { pages: 10 }));
    expect(unwrap(await hooks().verifyObserverAccess(name, binding, { sarah, phillip: id }, await lastReported(name)))).toEqual(["phillip"]);
  });

  it("name an empty listing's folder", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const name = facet("report-empty");
    expect(unwrap(await hooks().run(name, folderProps(id), [["list", { folderId: ref(EMPTY) }]], { pages: 10 }))).toEqual([]);
    expect(await lastReported(name)).toEqual([item(EMPTY)]);
  });

  it("name a file whose replacement awaits approval when its new content is read, since its details are SharePoint's", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const name = facet("report-staged");
    unwrap(await hooks().run(name, folderProps(id), [["replaceFile", ref(NOTES), "new text\n"]]));
    const before = (await hooks().queueLog(name)).observations.length;
    expect(unwrap(await hooks().run(name, folderProps(id), [["readFile", ref(NOTES)]]))).toMatchObject({ content: "new text\n" });
    expect((await hooks().queueLog(name)).observations).toHaveLength(before + 1);
    expect(await lastReported(name)).toEqual([item(NOTES)]);
  });

  it("name the owner's organization for a read that reveals nothing narrower, which only its members pass", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const mallory = await seedAccount(graph, MALLORY);
    const binding = props(id, { kind: "all" });
    const name = facet("report-tenant");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    expect(await lastReported(name)).toEqual([tenant]);
    expect(unwrap(await hooks().verifyObserverAccess(name, binding, { sarah, mallory }, [tenant]))).toEqual(["sarah"]);
    expect(graph.batched).toEqual([]);
  });
});

describe("verifyObserverAccess", () => {
  it("denies a collaborator from another organization without asking Graph about anything", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const mallory = await seedAccount(graph, MALLORY);
    const binding = folderProps(id);
    expect(unwrap(await hooks().verifyObserverAccess(facet("verify-tenant"), binding, { mallory }, [item(BRIEF)]))).toEqual([]);
    expect(graph.batched).toEqual([]);
  });

  it("refuses an ID the binding's reads never report", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    expect(failure(await hooks().verifyObserverAccess(facet("verify-foreign"), folderProps(id), { sarah }, [`outlook/user/${PHILLIP.oid}`])))
      .toMatch(/Not a subresource ID this Microsoft 365 binding reports/);
  });

  it.each([
    ["an allowed", false, ["sarah"], 15 * 60_000],
    ["a denied", true, [], 15_000],
  ])("reuses %s answer across the owner's bindings until it expires", async (_, hidden, allowed, ttl) => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    if (hidden) graph.hide(SARAH, BRIEF);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const folder = folderProps(id);
    const everything = props(id, { kind: "all" });

    expect(unwrap(await hooks().verifyObserverAccess(facet("reuse-folder"), folder, { sarah }, [item(BRIEF)]))).toEqual(allowed);
    vi.setSystemTime(start + ttl - 1);
    expect(unwrap(await hooks().verifyObserverAccess(facet("reuse-all"), everything, { sarah }, [item(BRIEF)]))).toEqual(allowed);
    expect(graph.probedItems(SARAH)).toEqual([BRIEF]);

    vi.setSystemTime(start + ttl);
    expect(unwrap(await hooks().verifyObserverAccess(facet("reuse-again"), folder, { sarah }, [item(BRIEF)]))).toEqual(allowed);
    expect(graph.probedItems(SARAH)).toEqual([BRIEF, BRIEF]);
  });

  it("asks afresh once the collaborator's account is reconnected", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const binding = folderProps(id);
    unwrap(await hooks().verifyObserverAccess(facet("reconnect-before"), binding, { sarah }, [item(BRIEF)]));
    await hooks().installCallback(sarah, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const staged = await reconnectAs(graph, sarah, SARAH) as { handoff: { ticket: string } };
    unwrap(await hooks().account(sarah, "commitReconnect", staged.handoff.ticket));

    unwrap(await hooks().verifyObserverAccess(facet("reconnect-after"), binding, { sarah }, [item(BRIEF)]));
    expect(graph.probedItems(SARAH)).toEqual([BRIEF, BRIEF]);
  });

  it("fails the whole check when Graph can't answer, and remembers nothing of it", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    let down = true;
    graph.on("POST", /^\/v1\.0\/\$batch$/, () => down ? json({ error: { code: "generalException", message: "down" } }, { status: 500 }) : undefined);
    const binding = folderProps(id);
    expect(failure(await hooks().verifyObserverAccess(facet("outage"), binding, { sarah }, [item(BRIEF)]))).toBeTruthy();
    down = false;
    expect(unwrap(await hooks().verifyObserverAccess(facet("outage-over"), binding, { sarah }, [item(BRIEF)]))).toEqual(["sarah"]);
    expect(graph.probedItems(SARAH)).toEqual([BRIEF]);
  });

  /** Answers every `$batch` entry 401 while `rejecting(token)`, as Graph does for a credential a workload refused. */
  function rejectInsideBatches(graph: FakeGraph, rejecting: (token: string) => boolean): void {
    graph.on("POST", /^\/v1\.0\/\$batch$/, request => {
      if (!rejecting(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return undefined;
      const { requests } = JSON.parse(request.body!) as { requests: Array<{ id: string }> };
      return json({ responses: requests.map(sub => ({ id: sub.id, status: 401, body: { error: { code: "InvalidAuthenticationToken" } } })) });
    });
  }

  it("heals a credential Graph rejects inside a batch, then answers, remembering no denial for it", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const stale = (await storedGrant(sarah))!.accessToken;
    rejectInsideBatches(graph, token => token === stale);
    const binding = folderProps(id);

    expect(unwrap(await hooks().verifyObserverAccess(facet("rejected"), binding, { sarah }, [item(BRIEF)]))).toEqual(["sarah"]);
    expect(graph.tokenRequests().map(form => form.get("grant_type"))).toEqual(["refresh_token"]);
    expect(unwrap(await hooks().verifyObserverAccess(facet("rejected-again"), binding, { sarah }, [item(BRIEF)]))).toEqual(["sarah"]);
    expect(graph.probedItems(SARAH)).toEqual([BRIEF]);
  });

  it("stops answering, earlier grants included, once Graph rejects a credential that can't be healed", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    let rejecting = false;
    rejectInsideBatches(graph, () => rejecting);
    const binding = folderProps(id);
    expect(unwrap(await hooks().verifyObserverAccess(facet("dead-before"), binding, { sarah }, [item(BRIEF)]))).toEqual(["sarah"]);

    rejecting = true;
    graph.tokens.delete((await storedGrant(sarah))!.refreshToken!);
    expect(failure(await hooks().verifyObserverAccess(facet("dead-new"), binding, { sarah }, [item(NOTES)]))).toMatch(/expired or was revoked/);
    expect(failure(await hooks().verifyObserverAccess(facet("dead-cached"), binding, { sarah }, [item(BRIEF)]))).toMatch(/expired or was revoked/);
  });
});

describe("an observer's own account", () => {
  it("answers for someone's whole calendars and its user's own free/busy by who they are, without asking Graph", async () => {
    const graph = new FakeGraph().install();
    const sarah = await seedAccount(graph, SARAH);
    const asked = [
      tenant,
      calendarSubresourceId({ kind: "calendars", ownerId: SARAH.oid }),
      calendarSubresourceId({ kind: "calendars", ownerId: PHILLIP.oid }),
      calendarSubresourceId({ kind: "availability", address: SARAH.upn }),
    ];
    expect(unwrap(await hooks().account(sarah, "checkSubresourceAccess", asked))).toEqual([true, true, false, true]);
    expect(graph.requests.filter(request => request.url.origin !== "https://login.microsoftonline.com")).toEqual([]);
  });

  it("answers an ID by the tenant it names, asking Graph only about its user's own", async () => {
    const graph = new FakeGraph().install();
    const sarah = await seedAccount(graph, SARAH);
    const own = qualifiedSubresourceId(item(BRIEF), TENANT);
    const foreign = qualifiedSubresourceId(item(BRIEF), OTHER_TENANT);
    expect(unwrap(await hooks().account(sarah, "checkSubresourceAccess", [own, foreign]))).toEqual([true, false]);
    expect(graph.probedItems(SARAH)).toEqual([BRIEF]);
  });

  it("leaves a calendar's events to its owner's sharing list", async () => {
    const graph = new FakeGraph().install();
    const sarah = await seedAccount(graph, SARAH);
    const events = calendarSubresourceId({ kind: "calendar", ownerId: PHILLIP.oid, calendarId: "AAMkCal=", level: "full" });
    expect(failure(await hooks().account(sarah, "checkSubresourceAccess", [events]))).toMatch(/owner's sharing list/);
  });
});

describe("reads made before reads reported subresources", () => {
  it("still refuse, at admission, a collaborator from another organization", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const mallory = await seedAccount(graph, MALLORY);
    const binding = folderProps(id);
    const name = facet("legacy-tenant");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    expect(failure(await hooks().addObserver(name, binding, "mallory", mallory))).toMatch(/different organization/);
  });

  it("are still checked at admission, and exported with the owner's organization", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    graph.hide(SARAH, BRIEF);
    const binding = folderProps(id);
    const name = facet("legacy");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    await hooks().seed(name, binding, `observedUnit:item:${DRIVE}:${BRIEF}`, "observed");

    expect(failure(await hooks().addObserver(name, binding, "sarah", sarah))).toMatch(/can't open something in SharePoint/);
    expect(unwrap(await hooks().historicalSubresources(name, binding))).toEqual([tenant, item(BRIEF)]);
    // What reads reveal now is reported instead of recorded.
    unwrap(await hooks().run(name, binding, [["list"]], { pages: 10 }));
    expect(unwrap(await hooks().historicalSubresources(name, binding))).toEqual([tenant, item(BRIEF)]);
  });

  it("export nothing for a binding that never read", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(unwrap(await hooks().historicalSubresources(facet("legacy-none"), folderProps(id)))).toEqual([]);
  });

  it("refuse to export a unit this version can't read, rather than leave it out", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("legacy-unreadable");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    await hooks().seed(name, binding, "observedUnit:someday:x", "observed");
    expect(failure(await hooks().historicalSubresources(name, binding))).toMatch(/can't be exported/);
  });
});
