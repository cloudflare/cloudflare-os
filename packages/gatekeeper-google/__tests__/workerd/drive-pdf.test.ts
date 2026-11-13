// A scanned PDF read through a Drive binding as a deployment runs it: the Drive gatekeeper's own
// session, which takes the renderer and the model from its bindings, the renderer Worker behind
// its service binding, and Google faked at the fetch layer. The model is the pool's fake.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import {faxMarks, imagePdf} from "../pdf-fixture";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  GoogleDocGatekeeperImpl: DurableObjectNamespace;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const PDF_MIME = "application/pdf";
/** A one-page scan stored as fax, which is rendered to be read. */
const SCAN = imagePdf([faxMarks()]).bytes;
/** What the pool's fake model reads on every image. */
const MODEL_TEXT = "Harbour Ledger";

/**
 * Google Drive as far as reading one PDF uses it: the file's metadata, and its bytes, whole or
 * the range asked for. `ranges` is the `Range` of each download, in order.
 */
function installDrive(bytes: Uint8Array) {
  const ranges: (string | null)[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/drive/v3/files/")) {
      throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
    }
    if (url.searchParams.get("alt") !== "media") {
      return Response.json({
        id: "pdf-1", name: "Scan", mimeType: PDF_MIME, modifiedTime: "2026-08-20T12:00:00Z", trashed: false,
      });
    }
    const range = new Headers(init.headers).get("Range");
    ranges.push(range);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range ?? "")?.map(Number) ?? [];
    if (start === undefined) return new Response(bytes, {headers: {"Content-Type": PDF_MIME}});
    return new Response(bytes.slice(start, end! + 1), {
      status: 206, headers: {"Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`},
    });
  });
  return ranges;
}

/** A Drive binding on a connected account, its session, and what its approval queue was shown. */
async function driveBinding() {
  const name = `drive-pdf-test-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const accountId = testEnv.UserAccount.idFromName(name);
  await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "owner-refresh");
    state.storage.kv.put("accessToken", {token: "owner-token", expires: new Date(Date.now() + 3_600_000)});
  });
  // A facet's ID only names its storage, so any namespace serves.
  const id = testEnv.GoogleDocGatekeeperImpl.idFromName(name).toString();
  const queueId = `queue-${name}`;
  return {
    session: () => hook.openDriveSession(
      `drive-${name}`, id, {userObjectId: accountId.toString(), scope: {kind: "account"}}, queueId),
    observations: async (): Promise<string[]> => {
      const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return (observations as {description: string}[]).map(({description}) => description);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a scanned PDF read through a Drive binding", () => {
  it("is rendered by the renderer Worker the gatekeeper is bound to, and read in bands", async () => {
    const ranges = installDrive(SCAN);
    const binding = await driveBinding();
    using session = await binding.session();

    const result = await session.readPdf("pdf-1", {ocr: true});
    expect(Object.keys(result).toSorted()).toEqual(["hasText", "text", "transcribed"]);
    expect(result).toMatchObject({hasText: false, transcribed: true});
    const text = await new Response(result.text).text();

    // The page is cut into bands, each read by the model on its own, under the page's one heading.
    const [heading, ...bands] = text.split("\n");
    expect(heading).toBe("### Page 1");
    expect(bands.length).toBeGreaterThan(1);
    expect(bands.every(band => band === MODEL_TEXT)).toBe(true);
    // The file was read again, whole, as a content read of its own.
    expect(ranges).toEqual([null, `bytes=0-${SCAN.byteLength - 1}`]);
    expect((await binding.observations()).slice(-2)).toEqual([
      "Read the text of Drive file pdf-1.",
      "Read Drive file pdf-1 whole, to render its pages and transcribe them.",
    ]);
  });
});
