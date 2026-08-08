import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveApi } from "./drive-api";

afterEach(() => vi.unstubAllGlobals());

describe("Google Drive folder API", () => {
  it("reads and validates the selected folder", async () => {
    let requestedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requestedUrl = url;
      return Response.json({
        id: "folder-1",
        name: "Company OS acceptance",
        mimeType: "application/vnd.google-apps.folder",
        webViewLink: "https://drive.google.com/drive/folders/folder-1",
        trashed: false,
      });
    }));
    let folder = await new GoogleDriveApi(async () => "token").getFolder("folder-1");
    expect(folder.name).toBe("Company OS acceptance");
    expect(requestedUrl).toContain("supportsAllDrives=true");
    expect(requestedUrl).toContain("fields=id%2Cname%2CmimeType%2CwebViewLink%2Ctrashed");
  });

  it("lists direct children only", async () => {
    let requestedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requestedUrl = url;
      return Response.json({ files: [{
        id: "file-1",
        name: "invoice.pdf",
        mimeType: "application/pdf",
        size: "2048",
        modifiedTime: "2026-08-08T12:00:00.000Z",
      }] });
    }));
    let files = await new GoogleDriveApi(async () => "token").listFiles("folder-1", 25);
    expect(files[0]).toMatchObject({ name: "invoice.pdf", size: 2048 });
    let url = new URL(requestedUrl);
    expect(url.searchParams.get("q")).toBe("'folder-1' in parents and trashed = false");
    expect(url.searchParams.get("pageSize")).toBe("25");
  });

  it("uploads multipart bytes under the selected folder", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      request = { url, init };
      return Response.json({
        id: "file-1",
        name: "invoice.pdf",
        mimeType: "application/pdf",
        size: "4",
        webViewLink: "https://drive.google.com/file/d/file-1/view",
      });
    }));
    let file = await new GoogleDriveApi(async () => "token").uploadFile("folder-1", {
      name: "invoice.pdf",
      mimeType: "application/pdf",
      bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
      convertToGoogleDoc: false,
    });

    expect(file.webViewLink).toContain("file-1");
    expect(request?.url).toContain("uploadType=multipart");
    expect(request?.url).toContain("supportsAllDrives=true");
    expect(request?.init?.method).toBe("POST");
    expect(new Headers(request?.init?.headers).get("Content-Type"))
      .toMatch(/^multipart\/related; boundary=company_os_/);
    let body = request?.init?.body as Blob;
    let bytes = new Uint8Array(await body.arrayBuffer());
    let text = new TextDecoder().decode(bytes);
    expect(text).toContain('"name":"invoice.pdf","parents":["folder-1"]');
    expect([...bytes]).toEqual(expect.arrayContaining([0x25, 0x50, 0x44, 0x46]));
  });

  it("rejects an oversized response before parsing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      headers: { "Content-Length": String(1024 * 1024 + 1) },
    })));
    await expect(new GoogleDriveApi(async () => "token").getFolder("folder-1"))
      .rejects.toThrow(/response exceeded/);
  });
});
