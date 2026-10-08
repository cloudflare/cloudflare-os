import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { AdminSettings } from "../src/admin-settings.js";
import worker from "../src/server.js";
import { MAX_UPDATE_HOURS } from "@gadgets/workshop-shared/api";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import {
  NO_ANSWER, ROUTER_VERSION_HEADER, deployServiceInstall, deploymentUpdateStatus,
  fetchLatestRelease, routerVersionTag, workerVersionState, type DeployServiceInstall,
  type UpdateSettings, type VersionAnswer,
} from "../src/deployment-updates.js";
import {
  makeAdminSettingsStorage, type UpdateCheck,
} from "../src/storage-schema/admin-settings-storage.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

const HOUR = 60 * 60 * 1000;
const CHECK_URL = "https://deploy.example/api/releases/latest";
const INSTALL: DeployServiceInstall = {
  releaseId: "r10-aaaaaaa",
  versionTag: "tag-r10:0123abcd",
  versionTagSuffix: ":0123abcd",
  updateUrl: "https://deploy.example/#flow=upgrade&account=acct&installation=0123abcd&name=os",
  updateCheckUrl: CHECK_URL,
};
const VERSION = { id: "version-id", tag: "tag-r10:0123abcd", timestamp: "2026-10-01T00:00:00.000Z" };
const DEPLOYED = { CLOUDFLARE_OS_DEPLOYMENT: INSTALL, CF_VERSION_METADATA: VERSION };
const T0 = Date.UTC(2026, 9, 5, 12);
const SETTINGS: UpdateSettings =
    { updateChecksEnabled: true, updateMinimumAgeHours: 24, updateNoticeSnoozeHours: 24 };
// How a status reports SETTINGS.
const REPORTED = { checksEnabled: true, minimumAgeHours: 24, noticeSnoozeHours: 24 };
// How a status reports a deployment whose every Worker that answered runs the recorded version.
const UNMODIFIED = { modified: false, modifiedWorkers: [], unfinishedWorkers: [] };
// The backend, running the recorded version, as the only Worker that answered.
const CURRENT = new Map<string, VersionAnswer>([["backend", INSTALL.versionTag]]);

function envWith(value: unknown): Cloudflare.Env {
  return { CLOUDFLARE_OS_DEPLOYMENT: value } as unknown as Cloudflare.Env;
}

function release(body: Record<string, unknown>): Response {
  return Response.json({
    releaseId: "r12-ccccccc", publishedAt: "2026-10-04T12:00:00.000Z", ...body,
  });
}

const NEWER = { upgradeAvailable: true, availableSince: "2026-10-03T12:00:00.000Z" };

// Records every request the Worker makes and answers it with `answer`.
function stubFetch(answer: () => Response | Promise<Response>) {
  const requests: { url: string, init: RequestInit | undefined }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push({ url: String(input), init });
    return answer();
  });
  return { requests, spy };
}

let now = T0;
function stubClock() {
  now = T0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("deployServiceInstall", () => {
  it("reads the variable the deploy service writes", () => {
    expect(deployServiceInstall(envWith(INSTALL))).toStrictEqual(INSTALL);
    expect(deployServiceInstall(envWith({ ...INSTALL, extra: 1 }))).toStrictEqual(INSTALL);
  });

  it("accepts an empty version tag", () => {
    expect(deployServiceInstall(envWith({ ...INSTALL, versionTag: "" })))
        .toStrictEqual({ ...INSTALL, versionTag: "" });
  });

  it("reads a variable without versionTagSuffix", () => {
    const { versionTagSuffix: _, ...withoutSuffix } = INSTALL;
    expect(deployServiceInstall(envWith(withoutSuffix))).toStrictEqual(withoutSuffix);
  });

  it("accepts http URLs", () => {
    const local = { ...INSTALL, updateUrl: "http://localhost:5173/", updateCheckUrl: "http://localhost:8787/x" };
    expect(deployServiceInstall(envWith(local))).toStrictEqual(local);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["the JSON as a string", JSON.stringify(INSTALL)],
    ["an array", [INSTALL]],
    ["no releaseId", { ...INSTALL, releaseId: undefined }],
    ["an empty releaseId", { ...INSTALL, releaseId: "" }],
    ["a numeric releaseId", { ...INSTALL, releaseId: 10 }],
    ["no versionTag", { ...INSTALL, versionTag: undefined }],
    ["a null versionTag", { ...INSTALL, versionTag: null }],
    ["an empty versionTagSuffix", { ...INSTALL, versionTagSuffix: "" }],
    ["a null versionTagSuffix", { ...INSTALL, versionTagSuffix: null }],
    ["a numeric versionTagSuffix", { ...INSTALL, versionTagSuffix: 123 }],
    ["no updateUrl", { ...INSTALL, updateUrl: undefined }],
    ["no updateCheckUrl", { ...INSTALL, updateCheckUrl: undefined }],
    ["a non-string updateUrl", { ...INSTALL, updateUrl: { href: INSTALL.updateUrl } }],
    ["a javascript: updateUrl", { ...INSTALL, updateUrl: "javascript:alert(1)" }],
    ["a relative updateUrl", { ...INSTALL, updateUrl: "/#flow=upgrade" }],
    ["an ftp: updateCheckUrl", { ...INSTALL, updateCheckUrl: "ftp://deploy.example/latest" }],
    ["a file: updateCheckUrl", { ...INSTALL, updateCheckUrl: "file:///etc/passwd" }],
    ["an unparseable updateCheckUrl", { ...INSTALL, updateCheckUrl: "not a url" }],
  ])("is null for %s", (_label, value) => {
    expect(deployServiceInstall(envWith(value))).toBeNull();
  });
});

describe("workerVersionTag", () => {
  it.each([
    ["a tag", { CF_VERSION_METADATA: VERSION }, VERSION.tag],
    ["an empty tag", { CF_VERSION_METADATA: { ...VERSION, tag: "" } }, undefined],
    ["a non-string tag", { CF_VERSION_METADATA: { ...VERSION, tag: 10 } }, undefined],
    ["no tag", { CF_VERSION_METADATA: { id: "version-id" } }, undefined],
    ["a null binding", { CF_VERSION_METADATA: null }, undefined],
    ["no binding", {}, undefined],
    ["a binding that throws", {
      get CF_VERSION_METADATA(): unknown { throw new Error("unavailable"); },
    }, undefined],
    ["a tag that throws", {
      CF_VERSION_METADATA: { get tag(): unknown { throw new Error("unavailable"); } },
    }, undefined],
  ])("reads %s", (_label, workerEnv, tag) => {
    expect(workerVersionTag(workerEnv)).toBe(tag);
  });
});

describe("workerVersionState", () => {
  const { versionTagSuffix: _, ...withoutSuffix } = INSTALL;

  it.each([
    ["the recorded tag", INSTALL.versionTag, INSTALL, "current"],
    ["another release of this installation", "tag-r09:0123abcd", INSTALL, "unfinished"],
    ["a later release of this installation", "tag-r12:0123abcd", INSTALL, "unfinished"],
    ["another installation's tag", "tag-r10:ffffffff", INSTALL, "modified"],
    ["a tag the deploy flow did not write", "edited", INSTALL, "modified"],
    ["an empty tag", "", INSTALL, "modified"],
    ["no tag", undefined, INSTALL, "modified"],
    ["no answer", NO_ANSWER, INSTALL, "unknown"],
    ["no tag, where an empty one is recorded", "", { ...INSTALL, versionTag: "" }, "modified"],
    ["the recorded tag, with no suffix recorded", INSTALL.versionTag, withoutSuffix, "current"],
    ["another release, with no suffix recorded", "tag-r09:0123abcd", withoutSuffix, "modified"],
    ["no answer, with no suffix recorded", NO_ANSWER, withoutSuffix, "unknown"],
  ] as const)("is %s for %s", (_label, answer, install, state) => {
    expect(workerVersionState(answer, install)).toBe(state);
  });
});

describe("routerVersionTag", () => {
  it("is undefined when the request did not come through the router", () => {
    expect(routerVersionTag(new Request("https://workshop.example/api").headers)).toBeUndefined();
  });

  it.each([
    ["a tag", "tag-r10:0123abcd"],
    ["an empty tag", ""],
  ])("reads %s", (_label, tag) => {
    const req = new Request("https://workshop.example/api",
        { headers: { [ROUTER_VERSION_HEADER.toLowerCase()]: tag } });
    expect(routerVersionTag(req.headers)).toBe(tag);
  });
});

describe("fetchLatestRelease", () => {
  it("sends the running release as `from` and nothing else", async () => {
    const { requests } = stubFetch(() => release(NEWER));
    await fetchLatestRelease(CHECK_URL, "r10 a&b=c");
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe(CHECK_URL);
    expect([...url.searchParams]).toEqual([["from", "r10 a&b=c"]]);
    expect(url.hash).toBe("");
    // Only the timeout's signal: no method, headers, body or credentials of its own.
    const init = requests[0]!.init!;
    expect(Object.keys(init)).toEqual(["signal"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns what an update check stores, with epoch-millisecond times", async () => {
    stubFetch(() => release(NEWER));
    expect(await fetchLatestRelease(CHECK_URL, "r10")).toStrictEqual({
      latestReleaseId: "r12-ccccccc",
      upgradeAvailable: true,
      availableSince: Date.parse("2026-10-03T12:00:00.000Z"),
    });
  });

  it.each([
    ["without availableSince", {}],
    ["ignoring availableSince", { availableSince: "2026-10-03T12:00:00.000Z" }],
    ["ignoring a junk availableSince", { availableSince: "Oct 3 2026" }],
  ])("returns an up-to-date answer %s", async (_label, extra) => {
    stubFetch(() => release({ upgradeAvailable: false, ...extra }));
    expect(await fetchLatestRelease(CHECK_URL, "r10")).toStrictEqual({
      latestReleaseId: "r12-ccccccc", upgradeAvailable: false,
    });
  });

  it.each([
    ["no publishedAt", undefined],
    ["a junk publishedAt", "yesterday"],
  ])("does not read publishedAt: accepts %s", async (_label, publishedAt) => {
    stubFetch(() => Response.json({ releaseId: "r12", publishedAt, ...NEWER }));
    expect(await fetchLatestRelease(CHECK_URL, "r10")).toMatchObject({ latestReleaseId: "r12" });
  });

  it("rejects a status that is not OK, cancelling the unread body", async () => {
    const cancel = vi.fn();
    stubFetch(() => new Response(new ReadableStream({ cancel }), { status: 503 }));
    await expect(fetchLatestRelease(CHECK_URL, "r10")).rejects.toThrow("status 503");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an HTML page answered with 200, without quoting it", async () => {
    stubFetch(() => new Response("<!doctype html><html><body>deploy</body></html>",
        { headers: { "content-type": "text/html" } }));
    const error = await fetchLatestRelease(CHECK_URL, "r10").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The update check did not answer with a release.");
    expect((error as Error).message).not.toContain("doctype");
  });

  it("throws a failure to read the body as itself, not as a bad answer", async () => {
    stubFetch(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"releaseId":'));
        controller.error(new Error("connection dropped"));
      },
    })));
    await expect(fetchLatestRelease(CHECK_URL, "r10")).rejects.toThrow("connection dropped");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "r12"],
    ["no releaseId", { upgradeAvailable: false }],
    ["an empty releaseId", { releaseId: "", upgradeAvailable: false }],
    ["a numeric releaseId", { releaseId: 12, upgradeAvailable: false }],
    ["no upgradeAvailable", { releaseId: "r12" }],
    ["a string upgradeAvailable", { releaseId: "r12", upgradeAvailable: "true" }],
    ["upgradeAvailable with no availableSince", { releaseId: "r12", upgradeAvailable: true }],
    ["upgradeAvailable with a numeric availableSince",
      { releaseId: "r12", upgradeAvailable: true, availableSince: T0 }],
    ["upgradeAvailable with an unparseable availableSince",
      { releaseId: "r12", upgradeAvailable: true, availableSince: "Oct 3 2026" }],
    ["upgradeAvailable with an impossible availableSince",
      { releaseId: "r12", upgradeAvailable: true, availableSince: "2026-13-45T00:00:00Z" }],
  ])("rejects %s", async (_label, body) => {
    stubFetch(() => Response.json(body));
    await expect(fetchLatestRelease(CHECK_URL, "r10"))
        .rejects.toThrow("The update check did not answer with a release.");
  });

  it("gives up after 5 seconds", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
      }));
    const pending = fetchLatestRelease(CHECK_URL, "r10");
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(fetched.mock.calls[0]![1]!.signal).toBe(timeout.signal);
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    await expect(pending).rejects.toThrow("timed out");
  });
});

describe("deploymentUpdateStatus", () => {
  const checked = (result: UpdateCheck["result"], from = INSTALL.releaseId): UpdateCheck =>
      ({ from, attemptedAt: T0 - HOUR, checkedAt: T0 - HOUR, result });
  const available = (sinceMs: number) => checked(
      { latestReleaseId: "r12", upgradeAvailable: true, availableSince: T0 - sinceMs });

  it("lists the modified and unfinished Workers, sorted, and only modified ones stop the notice",
      () => {
    const status = (versions: [string, VersionAnswer][]) => deploymentUpdateStatus(
        INSTALL, SETTINGS, available(48 * HOUR), new Map(versions), T0);
    const current = INSTALL.versionTag;
    expect(status([["backend", current], ["router", NO_ANSWER], ["slack", NO_ANSWER]]))
        .toMatchObject({ ...UNMODIFIED, notify: true });
    expect(status([["router", current], ["github", "tag-r09:0123abcd"], ["backend", current],
        ["google2", "tag-r09:0123abcd"]])).toMatchObject({
      ...UNMODIFIED, unfinishedWorkers: ["github", "google2"], notify: true,
    });
    expect(status([["slack", undefined], ["router", "other"], ["backend", ""],
        ["github", "tag-r09:0123abcd"], ["google", current]])).toMatchObject({
      modified: true, modifiedWorkers: ["backend", "router", "slack"],
      unfinishedWorkers: ["github"], notify: false,
    });
  });

  it("reports no update before any check", () => {
    expect(deploymentUpdateStatus(INSTALL, SETTINGS, null, CURRENT, T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, updateAvailable: false, notify: false,
      ...REPORTED, ...UNMODIFIED, updateUrl: INSTALL.updateUrl,
    });
  });

  it("ignores a check made for another release", () => {
    const stale = { ...available(48 * HOUR), from: "r09-0000000" };
    expect(deploymentUpdateStatus(INSTALL, SETTINGS, stale, CURRENT, T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, updateAvailable: false, notify: false,
      ...REPORTED, ...UNMODIFIED, updateUrl: INSTALL.updateUrl,
    });
  });

  it("ignores a failed attempt with no success for this release", () => {
    expect(deploymentUpdateStatus(INSTALL, SETTINGS, { from: INSTALL.releaseId, attemptedAt: T0 },
        CURRENT, T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, updateAvailable: false, notify: false,
      ...REPORTED, ...UNMODIFIED, updateUrl: INSTALL.updateUrl,
    });
  });

  it("reports an up-to-date check without notifying", () => {
    const check = checked({ latestReleaseId: INSTALL.releaseId, upgradeAvailable: false });
    expect(deploymentUpdateStatus(INSTALL, SETTINGS, check, CURRENT, T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, latestReleaseId: INSTALL.releaseId,
      updateAvailable: false, notify: false, ...REPORTED, ...UNMODIFIED,
      updateUrl: INSTALL.updateUrl, checkedAt: new Date(T0 - HOUR),
    });
  });

  it("reports an update but does not notify while modified", () => {
    const status = deploymentUpdateStatus(INSTALL, SETTINGS, available(48 * HOUR),
        new Map([["backend", "edited"]]), T0);
    expect(status).toMatchObject({ updateAvailable: true, modified: true, notify: false });
  });

  it.each([
    ["23h59m", 24 * HOUR - 60_000, false],
    ["1ms short of 24h", 24 * HOUR - 1, false],
    ["exactly 24h", 24 * HOUR, true],
    ["25h", 25 * HOUR, true],
  ])("notifies of an update available for %s: %s", (_label, sinceMs, notify) => {
    const status = deploymentUpdateStatus(INSTALL, SETTINGS, available(sinceMs), CURRENT, T0);
    expect(status).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, latestReleaseId: "r12", updateAvailable: true,
      availableSince: new Date(T0 - sinceMs), notify, ...REPORTED, ...UNMODIFIED,
      updateUrl: INSTALL.updateUrl, checkedAt: new Date(T0 - HOUR),
    });
  });

  it("reports the settings it is given", () => {
    const settings =
        { updateChecksEnabled: false, updateMinimumAgeHours: 0, updateNoticeSnoozeHours: 720 };
    expect(deploymentUpdateStatus(INSTALL, settings, null, CURRENT, T0)).toMatchObject({
      checksEnabled: false, minimumAgeHours: 0, noticeSnoozeHours: 720,
    });
  });

  it("does not notify while automatic checks are off", () => {
    const off = { ...SETTINGS, updateChecksEnabled: false };
    expect(deploymentUpdateStatus(INSTALL, off, available(48 * HOUR), CURRENT, T0))
        .toMatchObject({ updateAvailable: true, notify: false, checksEnabled: false });
  });

  it("notifies at once with a minimum age of 0", () => {
    const atOnce = { ...SETTINGS, updateMinimumAgeHours: 0 };
    expect(deploymentUpdateStatus(INSTALL, atOnce, available(0), CURRENT, T0).notify).toBe(true);
  });

  it.each([
    ["1ms short of 3h", 3 * HOUR - 1, false],
    ["exactly 3h", 3 * HOUR, true],
  ])("with a minimum age of 3 hours, notifies of an update available for %s: %s",
      (_label, sinceMs, notify) => {
    const threeHours = { ...SETTINGS, updateMinimumAgeHours: 3 };
    expect(deploymentUpdateStatus(INSTALL, threeHours, available(sinceMs), CURRENT, T0).notify)
        .toBe(notify);
  });
});

let counter = 0;

/**
 * Fresh AdminSettings storage. Each `inDo(vars)` call builds a new AdminSettings over it, with
 * `vars` as its environment, so state held in memory lasts for one call. The pool binds no
 * AdminSettings namespace, so it is constructed on the state of an unrelated Durable Object.
 */
function adminSettingsStorage() {
  const stub = env.TEST_USER_DIRECTORY.getByName(`deployment-updates-${++counter}`);
  return <T>(vars: object, f: (admin: AdminSettings) => T | Promise<T>) => {
    const settingsEnv = { ...vars, BLUEPRINTS: { put: vi.fn(async () => {}), get: async () => null } };
    return runInDurableObject(stub, (_host, state) =>
        f(new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env)));
  };
}

// The entries the logger wrote for the failed update check.
function failures(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter(entry => entry.event === "deployment.update-check.failed");
}

describe("AdminSettings.getUpdateStatus", () => {
  it("is null, with no request, unless the deploy flow installed the deployment", async () => {
    const { spy } = stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    expect(await inDo({}, admin => admin.getUpdateStatus())).toBeNull();
    expect(await inDo({ CLOUDFLARE_OS_DEPLOYMENT: JSON.stringify(INSTALL) },
        admin => admin.getUpdateStatus())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("checks once, serves the check for 6 hours, then checks again", async () => {
    stubClock();
    const { requests } = stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();

    const first = await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(1);
    expect(first).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, latestReleaseId: "r12-ccccccc", updateAvailable: true,
      availableSince: new Date(NEWER.availableSince), notify: true, ...REPORTED,
      ...UNMODIFIED, updateUrl: INSTALL.updateUrl, checkedAt: new Date(T0),
    });

    now = T0 + 6 * HOUR - 1;
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toStrictEqual(first);
    expect(requests).toHaveLength(1);

    now = T0 + 6 * HOUR;
    const third = await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(2);
    expect(third?.checkedAt).toStrictEqual(new Date(T0 + 6 * HOUR));
  });

  it("reports modified when the backend has no version binding", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    const status = await inDo({ CLOUDFLARE_OS_DEPLOYMENT: INSTALL },
        admin => admin.getUpdateStatus());
    expect(status).toMatchObject({
      updateAvailable: true, modified: true, modifiedWorkers: ["backend"], notify: false,
    });
  });

  it("checks again for a new release, and never serves the old release's check", async () => {
    stubClock();
    let failing = false;
    const { requests } = stubFetch(() =>
      failing ? new Response("unavailable", { status: 503 }) : release(NEWER));
    const inDo = adminSettingsStorage();
    await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(1);

    // Upgraded to r11 an hour later, while the deploy service is failing.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    failing = true;
    now = T0 + HOUR;
    const upgraded = {
      CLOUDFLARE_OS_DEPLOYMENT: { ...INSTALL, releaseId: "r11-bbbbbbb", versionTag: "tag-r11:0123abcd" },
      CF_VERSION_METADATA: { ...VERSION, tag: "tag-r11:0123abcd" },
    };
    const status = await inDo(upgraded, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!.url).searchParams.get("from")).toBe("r11-bbbbbbb");
    expect(status).toStrictEqual({
      currentReleaseId: "r11-bbbbbbb", updateAvailable: false, notify: false,
      ...REPORTED, ...UNMODIFIED, updateUrl: INSTALL.updateUrl,
    });

    // The failed attempt is recorded for r11, so it waits to retry like any other.
    now = T0 + HOUR + 1;
    expect(await inDo(upgraded, admin => admin.getUpdateStatus())).toStrictEqual(status);
    expect(requests).toHaveLength(2);
  });

  it("serves the last check after a failure, logs once, and waits 15 minutes to retry",
      async () => {
    stubClock();
    let failing = false;
    let latest = NEWER;
    const { requests } = stubFetch(() =>
      failing ? new Response("<!doctype html>", { status: 502 }) : release(latest));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inDo = adminSettingsStorage();
    const fresh = await inDo(DEPLOYED, admin => admin.getUpdateStatus());

    failing = true;
    now = T0 + 7 * HOUR;
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toStrictEqual(fresh);
    expect(requests).toHaveLength(2);
    const logged = failures(warned);
    expect(logged).toHaveLength(1);
    // The error, but neither the URL nor the answer.
    expect(logged[0]!.error).toContain("status 502");
    expect(JSON.stringify(logged[0])).not.toContain("deploy.example");
    expect(JSON.stringify(logged[0])).not.toContain("doctype");

    now = T0 + 7 * HOUR + 1;
    await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    now = T0 + 7 * HOUR + 15 * 60 * 1000 - 1;
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toStrictEqual(fresh);
    expect(requests).toHaveLength(2);
    expect(failures(warned)).toHaveLength(1);

    failing = false;
    latest = { upgradeAvailable: true, availableSince: "2026-10-05T18:00:00.000Z" };
    now = T0 + 7 * HOUR + 15 * 60 * 1000;
    const retried = await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(3);
    expect(retried?.checkedAt).toStrictEqual(new Date(now));
    expect(retried?.availableSince).toStrictEqual(new Date("2026-10-05T18:00:00.000Z"));
  });

  it("waits 15 minutes after a first check that failed", async () => {
    stubClock();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { requests } = stubFetch(() => new Response("{}", { status: 500 }));
    const inDo = adminSettingsStorage();
    const status = await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(status).toMatchObject({ updateAvailable: false, notify: false });
    expect(status?.checkedAt).toBeUndefined();
    now = T0 + 15 * 60 * 1000 - 1;
    await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(1);
    now = T0 + 15 * 60 * 1000;
    await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    stubClock();
    let respond!: () => void;
    const { requests } = stubFetch(() =>
      new Promise<Response>(resolve => { respond = () => resolve(release(NEWER)); }));
    const inDo = adminSettingsStorage();
    await inDo(DEPLOYED, async admin => {
      const calls = [admin.getUpdateStatus(), admin.getUpdateStatus(), admin.getUpdateStatus()];
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      respond();
      const [a, b, c] = await Promise.all(calls);
      expect(a?.updateAvailable).toBe(true);
      expect(b).toStrictEqual(a);
      expect(c).toStrictEqual(a);
      expect(requests).toHaveLength(1);

      // The shared request is forgotten once it settles.
      now = T0 + 6 * HOUR;
      const later = admin.getUpdateStatus();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      respond();
      await later;
    });
  });
});

describe("AdminSettings update settings", () => {
  const SETTERS = [
    ["minimum age", "setUpdateMinimumAgeHours", "updateMinimumAgeHours"],
    ["notice snooze", "setUpdateNoticeSnoozeHours", "updateNoticeSnoozeHours"],
  ] as const;

  it.each(SETTERS)("stores a %s from 0 to the maximum", async (_name, setter, field) => {
    const inDo = adminSettingsStorage();
    for (const hours of [0, 7, MAX_UPDATE_HOURS]) {
      await inDo({}, admin => admin[setter](hours));
      expect(await inDo({}, admin => admin.getAdminConfig()[field])).toBe(hours);
    }
  });

  it.each(SETTERS)("refuses a %s that is not a whole number of hours in range",
      async (name, setter, field) => {
    const inDo = adminSettingsStorage();
    await inDo({}, admin => admin[setter](5));
    for (const hours of [-1, MAX_UPDATE_HOURS + 1, 1.5, NaN, Infinity, -Infinity]) {
      await expect(inDo({}, admin => admin[setter](hours)), String(hours)).rejects.toThrow(
          `The ${name} must be a whole number of hours from 0 to ${MAX_UPDATE_HOURS}.`);
    }
    expect(await inDo({}, admin => admin.getAdminConfig()[field])).toBe(5);
  });

  it("stores whether automatic checks are on", async () => {
    const inDo = adminSettingsStorage();
    expect(await inDo({}, admin => admin.getAdminConfig().updateChecksEnabled)).toBe(true);
    await inDo({}, admin => admin.setUpdateChecksEnabled(false));
    expect(await inDo({}, admin => admin.getAdminConfig().updateChecksEnabled)).toBe(false);
    await inDo({}, admin => admin.setUpdateChecksEnabled(true));
    expect(await inDo({}, admin => admin.getAdminConfig().updateChecksEnabled)).toBe(true);
  });

  it("reports the settings in the status", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toMatchObject(REPORTED);
    await inDo({}, async admin => {
      await admin.setUpdateMinimumAgeHours(72);
      await admin.setUpdateNoticeSnoozeHours(0);
    });
    // NEWER has been available for 48 hours, short of the new minimum age.
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toMatchObject({
      updateAvailable: true, notify: false,
      checksEnabled: true, minimumAgeHours: 72, noticeSnoozeHours: 0,
    });
    await inDo({}, admin => admin.setUpdateChecksEnabled(false));
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus()))
        .toMatchObject({ checksEnabled: false, minimumAgeHours: 72, noticeSnoozeHours: 0 });
  });
});

describe("AdminSettings.getUpdateStatus with automatic checks off", () => {
  it("asks no one before any check, and does not notify", async () => {
    stubClock();
    const { spy } = stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    await inDo({}, admin => admin.setUpdateChecksEnabled(false));
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, updateAvailable: false, notify: false,
      ...REPORTED, checksEnabled: false, ...UNMODIFIED, updateUrl: INSTALL.updateUrl,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("serves the last check past 6 hours without asking again or notifying", async () => {
    stubClock();
    const { requests } = stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    const first = await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(first?.notify).toBe(true);
    await inDo({}, admin => admin.setUpdateChecksEnabled(false));

    now = T0 + 30 * 24 * HOUR;
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toStrictEqual({
      ...first, notify: false, checksEnabled: false,
    });
    expect(requests).toHaveLength(1);
  });

  it("does not ask for a new release, and never serves the old release's check", async () => {
    stubClock();
    const { requests } = stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    await inDo({}, admin => admin.setUpdateChecksEnabled(false));

    now = T0 + HOUR;
    const upgraded = {
      CLOUDFLARE_OS_DEPLOYMENT: { ...INSTALL, releaseId: "r11-bbbbbbb", versionTag: "tag-r11:0123abcd" },
      CF_VERSION_METADATA: { ...VERSION, tag: "tag-r11:0123abcd" },
    };
    expect(await inDo(upgraded, admin => admin.getUpdateStatus())).toStrictEqual({
      currentReleaseId: "r11-bbbbbbb", updateAvailable: false, notify: false,
      ...REPORTED, checksEnabled: false, ...UNMODIFIED, updateUrl: INSTALL.updateUrl,
    });
    expect(requests).toHaveLength(1);
  });
});

describe("AdminSettings.checkForUpdates", () => {
  it("is null, with no request, unless the deploy flow installed the deployment", async () => {
    const { spy } = stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    expect(await inDo({}, admin => admin.checkForUpdates())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks with automatic checks off, and returns the status it produces", async () => {
    stubClock();
    const { requests } = stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    await inDo({}, admin => admin.setUpdateChecksEnabled(false));
    expect(await inDo(DEPLOYED, admin => admin.checkForUpdates())).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, latestReleaseId: "r12-ccccccc", updateAvailable: true,
      availableSince: new Date(NEWER.availableSince), notify: false, ...REPORTED,
      checksEnabled: false, ...UNMODIFIED, updateUrl: INSTALL.updateUrl, checkedAt: new Date(T0),
    });
    expect(requests).toHaveLength(1);
    // What it stored is what getUpdateStatus serves.
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus()))
        .toMatchObject({ updateAvailable: true, checkedAt: new Date(T0) });
    expect(requests).toHaveLength(1);
  });

  it("asks within 6 hours of a check, and within 15 minutes of a failed one", async () => {
    stubClock();
    let failing = false;
    const { requests } = stubFetch(() =>
      failing ? new Response("unavailable", { status: 503 }) : release(NEWER));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inDo = adminSettingsStorage();
    await inDo(DEPLOYED, admin => admin.getUpdateStatus());

    now = T0 + 1;
    const checked = await inDo(DEPLOYED, admin => admin.checkForUpdates());
    expect(requests).toHaveLength(2);
    expect(checked?.checkedAt).toStrictEqual(new Date(T0 + 1));

    failing = true;
    now = T0 + 2;
    await expect(inDo(DEPLOYED, admin => admin.checkForUpdates())).rejects.toThrow();
    failing = false;
    now = T0 + 3;
    expect((await inDo(DEPLOYED, admin => admin.checkForUpdates()))?.checkedAt)
        .toStrictEqual(new Date(T0 + 3));
    expect(requests).toHaveLength(4);
  });

  it("rejects a failed check with a fixed message, recording the attempt and logging once",
      async () => {
    stubClock();
    let failing = false;
    const { requests } = stubFetch(() =>
      failing ? new Response("<!doctype html>", { status: 502 }) : release(NEWER));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inDo = adminSettingsStorage();
    const fresh = await inDo(DEPLOYED, admin => admin.getUpdateStatus());

    failing = true;
    now = T0 + 7 * HOUR;
    const error = await inDo(DEPLOYED, admin => admin.checkForUpdates()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The update check failed.");
    expect(requests).toHaveLength(2);
    const logged = failures(warned);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.error).toContain("status 502");

    // The attempt holds back the automatic check, which serves the earlier result meanwhile.
    now = T0 + 7 * HOUR + 15 * 60 * 1000 - 1;
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toStrictEqual(fresh);
    expect(requests).toHaveLength(2);
    expect(failures(warned)).toHaveLength(1);
  });

  it("records a failed attempt that holds back automatic checks for 15 minutes", async () => {
    stubClock();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { requests } = stubFetch(() => new Response("{}", { status: 500 }));
    const inDo = adminSettingsStorage();
    await expect(inDo(DEPLOYED, admin => admin.checkForUpdates()))
        .rejects.toThrow("The update check failed.");
    now = T0 + 15 * 60 * 1000 - 1;
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus()))
        .toMatchObject({ updateAvailable: false, notify: false });
    expect(requests).toHaveLength(1);
    now = T0 + 15 * 60 * 1000;
    await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(2);
  });

  it("shares the check in flight", async () => {
    stubClock();
    let respond!: (answer: Response) => void;
    const { requests } = stubFetch(() => new Promise<Response>(resolve => { respond = resolve; }));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inDo = adminSettingsStorage();
    await inDo(DEPLOYED, async admin => {
      const calls = [admin.getUpdateStatus(), admin.checkForUpdates(), admin.checkForUpdates()];
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      respond(release(NEWER));
      const [a, b, c] = await Promise.all(calls);
      expect(a?.updateAvailable).toBe(true);
      expect(b).toStrictEqual(a);
      expect(c).toStrictEqual(a);
      expect(requests).toHaveLength(1);

      // A shared check that fails rejects every Check now waiting on it, and is logged once.
      const failing = [admin.checkForUpdates(), admin.checkForUpdates()];
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      respond(new Response("unavailable", { status: 503 }));
      for (const call of failing) await expect(call).rejects.toThrow("The update check failed.");
      expect(requests).toHaveLength(2);
      expect(failures(warned)).toHaveLength(1);
    });
  });
});

describe("AdminSettings router version", () => {
  it("does not count a router that never reported", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus()))
        .toMatchObject({ ...UNMODIFIED, notify: true });
  });

  it.each([
    ["the recorded tag", INSTALL.versionTag, UNMODIFIED, true],
    ["another release's tag", "tag-r09:0123abcd",
      { ...UNMODIFIED, unfinishedWorkers: ["router"] }, true],
    ["another tag", "edited",
      { modified: true, modifiedWorkers: ["router"], unfinishedWorkers: [] }, false],
    ["no tag", "", { modified: true, modifiedWorkers: ["router"], unfinishedWorkers: [] }, false],
  ])("reports a router that reported %s", async (_label, tag, workers, notify) => {
    stubClock();
    stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    await inDo({}, admin => admin.recordRouterTag(tag));
    const status = await inDo(DEPLOYED, admin => admin.getUpdateStatus());
    expect(status).toMatchObject({ ...workers, notify });
    expect(await inDo(DEPLOYED, admin => admin.checkForUpdates())).toMatchObject(workers);
  });

  it("reports the latest tag the router reported", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    const inDo = adminSettingsStorage();
    await inDo({}, admin => admin.recordRouterTag("tag-r09:0123abcd"));
    await inDo({}, admin => admin.recordRouterTag(INSTALL.versionTag));
    expect(await inDo(DEPLOYED, admin => admin.getUpdateStatus())).toMatchObject(UNMODIFIED);
  });
});

// A gatekeeper vendor binding whose versionTag() records each call and answers with `answer`.
function vendor(answer: () => Promise<string | undefined>) {
  return { versionTag: vi.fn(answer) };
}

// The entries the logger wrote for gatekeepers that did not report their version tags.
function versionTagFailures(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter(entry => entry.event === "gatekeeper.version-tag.read.failed");
}

describe("AdminSettings gatekeeper versions", () => {
  it("asks every gatekeeper, giving up on one after 2 seconds", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Not vi.waitFor(), which advances fake timers while it waits.
    const asked = Promise.withResolvers<void>();
    const gatekeepers = {
      GATEKEEPER_CURRENT: vendor(async () => INSTALL.versionTag),
      GATEKEEPER_GOOGLE2: vendor(async () => "tag-r09:0123abcd"),
      GATEKEEPER_EDITED: vendor(async () => "edited"),
      GATEKEEPER_UNTAGGED: vendor(async () => undefined),
      GATEKEEPER_THROWING: vendor(async () => { throw new Error("unavailable"); }),
      GATEKEEPER_HANGING: vendor(() => {
        asked.resolve();
        return new Promise(() => {});
      }),
      GATEKEEPER_OLD: {},
    };
    const inDo = adminSettingsStorage();
    await inDo({ ...DEPLOYED, ...gatekeepers }, async admin => {
      let settled = false;
      const pending = admin.getUpdateStatus().finally(() => { settled = true; });
      await asked.promise;
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({
        modified: true, modifiedWorkers: ["edited", "untagged"], unfinishedWorkers: ["google2"],
        notify: false,
      });
    });
    expect(versionTagFailures(warned).map(entry => entry.gatekeeperId).toSorted())
        .toEqual(["hanging", "old", "throwing"]);
  });

  it("serves a round in which every gatekeeper answered for 60 seconds", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    const current = vendor(async () => INSTALL.versionTag);
    const untagged = vendor(async () => undefined);
    const inDo = adminSettingsStorage();
    await inDo({ ...DEPLOYED, GATEKEEPER_CURRENT: current, GATEKEEPER_UNTAGGED: untagged },
        async admin => {
      expect(await admin.getUpdateStatus()).toMatchObject({ modifiedWorkers: ["untagged"] });
      now = T0 + 60_000 - 1;
      await admin.getUpdateStatus();
      await admin.checkForUpdates();
      expect(current.versionTag).toHaveBeenCalledOnce();
      expect(untagged.versionTag).toHaveBeenCalledOnce();
      now = T0 + 60_000;
      await admin.getUpdateStatus();
      expect(current.versionTag).toHaveBeenCalledTimes(2);
      expect(untagged.versionTag).toHaveBeenCalledTimes(2);
    });
  });

  it("asks again only the gatekeepers that did not answer", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = true;
    const current = vendor(async () => INSTALL.versionTag);
    const flaky = vendor(async () => {
      if (failing) throw new Error("unavailable");
      return "tag-r09:0123abcd";
    });
    const old = { versionTag: vi.fn(() => { throw new Error("No such method."); }) };
    const inDo = adminSettingsStorage();
    await inDo({ ...DEPLOYED, GATEKEEPER_CURRENT: current, GATEKEEPER_FLAKY: flaky,
      GATEKEEPER_OLD: old }, async admin => {
      expect(await admin.getUpdateStatus()).toMatchObject(UNMODIFIED);
      failing = false;
      expect(await admin.getUpdateStatus())
          .toMatchObject({ ...UNMODIFIED, unfinishedWorkers: ["flaky"] });
      await admin.checkForUpdates();
      expect(current.versionTag).toHaveBeenCalledOnce();
      expect(flaky.versionTag).toHaveBeenCalledTimes(2);
      expect(old.versionTag).toHaveBeenCalledTimes(3);
    });
  });

  it("shares one round between concurrent callers", async () => {
    stubClock();
    stubFetch(() => release(NEWER));
    let answer!: (tag: string) => void;
    const slow = vendor(() => new Promise<string>(resolve => { answer = resolve; }));
    const inDo = adminSettingsStorage();
    await inDo({ ...DEPLOYED, GATEKEEPER_SLOW: slow }, async admin => {
      const calls = [admin.getUpdateStatus(), admin.getUpdateStatus(), admin.checkForUpdates()];
      await vi.waitFor(() => expect(slow.versionTag).toHaveBeenCalled());
      answer("tag-r09:0123abcd");
      for (const status of await Promise.all(calls)) {
        expect(status).toMatchObject({ unfinishedWorkers: ["slow"] });
      }
      expect(slow.versionTag).toHaveBeenCalledOnce();
    });
  });
});

describe("the backend's fetch handler", () => {
  // The deployment's AdminSettings, which the handler reaches through ctx.exports.
  const storedRouterTag = () => runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""),
      (_admin, state) => makeAdminSettingsStorage(state.storage).routerVersionTag.get());
  // Runs the handler for a deployment the deploy flow installed, or one with `vars` instead, and
  // waits for the work it left running.
  const request = async (headers: Record<string, string>,
      vars: Partial<Cloudflare.Env> = { CLOUDFLARE_OS_DEPLOYMENT: INSTALL }) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
        new Request("https://workshop.example/not-a-route", { headers }), { ...env, ...vars }, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };

  it("reports the router's version tag only for a deployment the deploy flow installed",
      async () => {
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""),
        admin => admin.recordRouterTag("stored before"));
    const tag = `tag-${crypto.randomUUID()}:0123abcd`;
    expect((await request({ [ROUTER_VERSION_HEADER]: tag }, {})).status).toBe(404);
    expect((await request({ [ROUTER_VERSION_HEADER]: tag },
        { CLOUDFLARE_OS_DEPLOYMENT: JSON.stringify(INSTALL) })).status).toBe(404);
    expect(await storedRouterTag()).toBe("stored before");

    await request({ [ROUTER_VERSION_HEADER]: tag });
    expect(await storedRouterTag()).toBe(tag);
  });

  it("records each router version tag it is sent, and nothing for a request without one",
      async () => {
    // Unique to this run: the isolate remembers the last tag it reported.
    const tag = `tag-${crypto.randomUUID()}:0123abcd`;
    expect((await request({ [ROUTER_VERSION_HEADER]: tag })).status).toBe(404);
    await vi.waitFor(async () => expect(await storedRouterTag()).toBe(tag));

    expect((await request({})).status).toBe(404);
    expect((await request({ [ROUTER_VERSION_HEADER]: "" })).status).toBe(404);
    await vi.waitFor(async () => expect(await storedRouterTag()).toBe(""));
    await request({});
    expect(await storedRouterTag()).toBe("");
  });

  it("reports a tag again after a minute, replacing an older one another isolate stored later",
      async () => {
    stubClock();
    const tag = `tag-${crypto.randomUUID()}:0123abcd`;
    await request({ [ROUTER_VERSION_HEADER]: tag });
    await vi.waitFor(async () => expect(await storedRouterTag()).toBe(tag));
    // The late report of another isolate, which a request through the old router reached.
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""),
        admin => admin.recordRouterTag("tag-r09:0123abcd"));

    now = T0 + 60_000 - 1;
    await request({ [ROUTER_VERSION_HEADER]: tag });
    expect(await storedRouterTag()).toBe("tag-r09:0123abcd");
    now = T0 + 60_000;
    await request({ [ROUTER_VERSION_HEADER]: tag });
    await vi.waitFor(async () => expect(await storedRouterTag()).toBe(tag));
  });
});
