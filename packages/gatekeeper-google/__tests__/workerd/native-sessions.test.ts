import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, HookController, HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  applyDriveCreation, DriveCreationStore, type DriveCreationStorage,
} from "../../src/drive-creation";
import type { DriveBindingScope } from "../../src/drive-session";
import type {
  DriveCreationHandle, GoogleDriveReadSession, GoogleDriveSession,
} from "../../src/drive-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../../src/docs-api";
import { DriveApi } from "../../src/drive-api";
import { GoogleDriveSessionImpl } from "../../src/google";
import { GoogleSheetsApi } from "../../src/sheets-api";

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";
let providerUrls: string[];
let createdFiles: Map<string, Record<string, unknown>>;

async function getAccessToken(): Promise<string> {
  return "access-token";
}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];
  readonly actions: { id: number; description: ActionDescription }[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.actions.push({ id: action, description });
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

function providerFile(
  id: string, mimeType: string, overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id === "doc-1" ? "Quarterly plan" : "Forecast",
    mimeType,
    modifiedTime: "2026-08-20T12:00:00Z",
    trashed: false,
    ...overrides,
  };
}

function installProvider() {
  const urls: string[] = [];
  createdFiles = new Map();
  vi.stubGlobal("fetch", vi.fn(async (
    input: string | URL | Request, init?: RequestInit,
  ) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    urls.push(url.toString());
    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/drive/v3/files")) {
      if (request.method === "GET") return Response.json({ files: [] });
      if (request.method === "POST") {
        const body = await request.json() as {
          name: string; mimeType: string; parents: string[];
        };
        const created = providerFile(`created-${createdFiles.size + 1}`, body.mimeType, {
          name: body.name,
          parents: body.parents,
          capabilities: { canTrash: true },
        });
        createdFiles.set(created.id, created);
        return Response.json(created);
      }
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.includes("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (request.method === "PATCH") {
        const current = createdFiles.get(id);
        if (!current) throw new Error(`Unknown created file: ${id}`);
        const trashed = { ...current, trashed: true };
        createdFiles.set(id, trashed);
        return Response.json(trashed);
      }
      const created = createdFiles.get(id);
      if (created) return Response.json(created);
      if (id === "root") {
        return Response.json(providerFile(id, FOLDER_MIME, {
          name: "My Drive", capabilities: { canAddChildren: true },
        }));
      }
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

class TestStorage implements DriveCreationStorage {
  entries = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }

  put<T>(key: string, value: T): void {
    this.entries.set(key, value);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
    return [...this.entries]
      .filter(([key]) => key.startsWith(prefix)) as [string, T][];
  }
}

function newSession(scope: DriveBindingScope = { kind: "account" }) {
  const queue = new TestApprovalQueue();
  const queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  const storage = new TestStorage();
  const driveApi = new DriveApi(getAccessToken);
  const session = new GoogleDriveSessionImpl(
    driveApi,
    new GoogleDocsApi(getAccessToken),
    new GoogleSheetsApi(getAccessToken),
    scope,
    storage,
    queueStub,
  );
  return { driveApi, queue, session, storage };
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

describe("Drive creation RPC", () => {
  it("round-trips handles and authoritative created outcomes through a real RPC stub", async () => {
    const { driveApi, queue, session, storage } = newSession();
    const rpc = new RpcStub(session);

    const doc = await rpc.createGoogleDoc({ name: "Quarterly plan" });
    const sheet = await rpc.createGoogleSheet({ name: "Forecast" });
    const folder = await rpc.createFolder({ name: "Planning" });

    expect([doc, sheet, folder]).toEqual([
      { id: 1, kind: "googleDoc", name: "Quarterly plan" },
      { id: 2, kind: "googleSheet", name: "Forecast" },
      { id: 3, kind: "folder", name: "Planning" },
    ]);
    expect(queue.actions.map(({ description }) => description)).toEqual(
      Array(3).fill(expect.objectContaining({
        implementsRevert: true, awaitDecision: true,
      })),
    );
    expect(queue.actions.every(({ description }) => !("actionKind" in description))).toBe(true);

    await applyDriveCreation(
      { storage, api: driveApi, scope: { kind: "account" } }, doc.id,
    );
    providerUrls.splice(0);
    const tampered = { ...doc, kind: "folder", name: "Forged" } as DriveCreationHandle;

    await expect(rpc.getCreationResult(tampered)).resolves.toEqual({
      status: "created",
      kind: "googleDoc",
      entry: expect.objectContaining({
        id: "created-1", name: "Quarterly plan", mimeType: DOC_MIME,
      }),
    });
    expect(providerUrls.some(url => url.includes("/drive/v3/files/created-1"))).toBe(true);
    rpc[Symbol.dispose]();
  });

  it("denies a cast file-scoped creation before provider access or action submission", async () => {
    const { queue, session, storage } = newSession({ kind: "file", fileId: "doc-1" });
    const readSession: GoogleDriveReadSession = session;
    const bypass = readSession as unknown as GoogleDriveSession;
    providerUrls.splice(0);

    await expect(bypass.createFolder({ name: "Not allowed" }))
      .rejects.toThrow(/outside this Drive binding/);
    expect(providerUrls).toEqual([]);
    expect(queue.actions).toEqual([]);
    expect(new DriveCreationStore(storage).pendingCount()).toBe(0);
    session[Symbol.dispose]();
  });
});
