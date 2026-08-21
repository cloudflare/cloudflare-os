import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, HookController, HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../../src/docs-api";
import { DriveApi } from "../../src/drive-api";
import { GoogleDriveSessionImpl } from "../../src/google";
import { GoogleSheetsApi } from "../../src/sheets-api";

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
let providerUrls: string[];

async function getAccessToken(): Promise<string> {
  return "access-token";
}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async submitAction(_action: number, _description: ActionDescription): Promise<void> {
    throw new Error("Unexpected action submission");
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

function providerFile(id: string, mimeType: string) {
  return {
    id,
    name: id === "doc-1" ? "Quarterly plan" : "Forecast",
    mimeType,
    modifiedTime: "2026-08-20T12:00:00Z",
  };
}

function installProvider() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url.toString());
    if (url.hostname === "www.googleapis.com" && url.pathname.includes("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const mimeType = id === "doc-1" ? DOC_MIME : SHEET_MIME;
      return Response.json(providerFile(id, mimeType));
    }
    if (url.hostname === "docs.googleapis.com") {
      return Response.json({
        documentId: "doc-1",
        title: "Quarterly plan",
        revisionId: "revision-1",
        body: { content: [] },
        lists: {},
      });
    }
    throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
  }));
  return urls;
}

function newSession() {
  const queue = new TestApprovalQueue();
  const queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  const session = new GoogleDriveSessionImpl(
    new DriveApi(getAccessToken),
    new GoogleDocsApi(getAccessToken),
    new GoogleSheetsApi(getAccessToken),
    { kind: "account" },
    queueStub,
  );
  return { queue, session };
}

beforeEach(() => {
  providerUrls = installProvider();
});
afterEach(() => vi.unstubAllGlobals());

describe("Drive nested native sessions", () => {
  it("returns a Doc target with only the read surface", async () => {
    const { session } = newSession();

    const doc = await session.openGoogleDoc("doc-1");

    expect(await doc.getMetadata()).toEqual({
      title: "Quarterly plan",
      lastModified: new Date("2026-08-20T12:00:00Z"),
    });
    expect(await doc.getContent()).toBe("");
    expect("replaceText" in doc).toBe(false);
    expect("appendText" in doc).toBe(false);
  });

  it("returns the existing Sheet target with bounded range validation", async () => {
    const { session } = newSession();

    const sheet = await session.openGoogleSheet("sheet-1");

    await expect(sheet.readRange("A:A")).rejects.toThrow(/Invalid or unbounded A1 range/);
    expect(providerUrls.some(url => url.includes("sheets.googleapis.com"))).toBe(false);
  });

  it("gives each child an independently disposable approval-queue stub", async () => {
    const { queue, session } = newSession();
    const doc = await session.openGoogleDoc("doc-1");

    session[Symbol.dispose]();
    await expect(doc.getMetadata()).resolves.toEqual(expect.objectContaining({
      title: "Quarterly plan",
    }));
    expect(queue.observations).toHaveLength(2);

    (doc as typeof doc & Disposable)[Symbol.dispose]();
    await expect(doc.getContent()).rejects.toThrow();
  });
});
