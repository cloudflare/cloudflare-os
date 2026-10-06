import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AdminSettings } from "../src/admin-settings.js";
import {
  deployServiceInstall, deploymentUpdateStatus, fetchLatestRelease, type DeployServiceInstall,
} from "../src/deployment-updates.js";
import type { UpdateCheck } from "../src/storage-schema/admin-settings-storage.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const HOUR = 60 * 60 * 1000;
const CHECK_URL = "https://deploy.example/api/releases/latest";
const INSTALL: DeployServiceInstall = {
  releaseId: "r10-aaaaaaa",
  versionTag: "tag-r10",
  updateUrl: "https://deploy.example/#flow=upgrade&account=acct&installation=0123abcd&name=os",
  updateCheckUrl: CHECK_URL,
};
const VERSION = { id: "version-id", tag: "tag-r10", timestamp: "2026-10-01T00:00:00.000Z" };
const DEPLOYED = { CLOUDFLARE_OS_DEPLOYMENT: INSTALL, CF_VERSION_METADATA: VERSION };
const T0 = Date.UTC(2026, 9, 5, 12);

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

  it.each([
    ["the recorded tag", "tag-r10", "tag-r10", false],
    ["another tag", "tag-r09", "tag-r10", true],
    ["an empty tag, where an empty one is recorded", "", "", false],
    ["no binding, where an empty tag is recorded", undefined, "", false],
    ["an empty tag, where one is recorded", "", "tag-r10", true],
    ["no binding, where a tag is recorded", undefined, "tag-r10", true],
  ])("with %s, modified is %s", (_label, runningTag, versionTag, modified) => {
    const status = deploymentUpdateStatus(
        { ...INSTALL, versionTag }, available(48 * HOUR), runningTag, T0);
    expect(status.modified).toBe(modified);
    expect(status.notify).toBe(!modified);
  });

  it("reports no update before any check", () => {
    expect(deploymentUpdateStatus(INSTALL, null, "tag-r10", T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, updateAvailable: false, notify: false,
      noticeSnoozeHours: 24, modified: false, updateUrl: INSTALL.updateUrl,
    });
  });

  it("ignores a check made for another release", () => {
    const stale = { ...available(48 * HOUR), from: "r09-0000000" };
    expect(deploymentUpdateStatus(INSTALL, stale, "tag-r10", T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, updateAvailable: false, notify: false,
      noticeSnoozeHours: 24, modified: false, updateUrl: INSTALL.updateUrl,
    });
  });

  it("ignores a failed attempt with no success for this release", () => {
    expect(deploymentUpdateStatus(INSTALL, { from: INSTALL.releaseId, attemptedAt: T0 },
        "tag-r10", T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, updateAvailable: false, notify: false,
      noticeSnoozeHours: 24, modified: false, updateUrl: INSTALL.updateUrl,
    });
  });

  it("reports an up-to-date check without notifying", () => {
    const check = checked({ latestReleaseId: INSTALL.releaseId, upgradeAvailable: false });
    expect(deploymentUpdateStatus(INSTALL, check, "tag-r10", T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, latestReleaseId: INSTALL.releaseId,
      updateAvailable: false, notify: false, noticeSnoozeHours: 24, modified: false,
      updateUrl: INSTALL.updateUrl, checkedAt: new Date(T0 - HOUR),
    });
  });

  it("reports an update but does not notify while modified", () => {
    const status = deploymentUpdateStatus(INSTALL, available(48 * HOUR), "edited", T0);
    expect(status).toMatchObject({ updateAvailable: true, modified: true, notify: false });
  });

  it.each([
    ["23h59m", 24 * HOUR - 60_000, false],
    ["1ms short of 24h", 24 * HOUR - 1, false],
    ["exactly 24h", 24 * HOUR, true],
    ["25h", 25 * HOUR, true],
  ])("notifies of an update available for %s: %s", (_label, sinceMs, notify) => {
    expect(deploymentUpdateStatus(INSTALL, available(sinceMs), "tag-r10", T0)).toStrictEqual({
      currentReleaseId: INSTALL.releaseId, latestReleaseId: "r12", updateAvailable: true,
      availableSince: new Date(T0 - sinceMs), notify, noticeSnoozeHours: 24, modified: false,
      updateUrl: INSTALL.updateUrl, checkedAt: new Date(T0 - HOUR),
    });
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
      availableSince: new Date(NEWER.availableSince), notify: true, noticeSnoozeHours: 24,
      modified: false, updateUrl: INSTALL.updateUrl, checkedAt: new Date(T0),
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
    expect(status).toMatchObject({ updateAvailable: true, modified: true, notify: false });
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
      CLOUDFLARE_OS_DEPLOYMENT: { ...INSTALL, releaseId: "r11-bbbbbbb", versionTag: "tag-r11" },
      CF_VERSION_METADATA: { ...VERSION, tag: "tag-r11" },
    };
    const status = await inDo(upgraded, admin => admin.getUpdateStatus());
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!.url).searchParams.get("from")).toBe("r11-bbbbbbb");
    expect(status).toStrictEqual({
      currentReleaseId: "r11-bbbbbbb", updateAvailable: false, notify: false,
      noticeSnoozeHours: 24, modified: false, updateUrl: INSTALL.updateUrl,
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
