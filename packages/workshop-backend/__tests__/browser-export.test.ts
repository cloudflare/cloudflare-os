import { beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ launch }));

const { BrowserRpcTransport, renderGadgetInBrowser } =
    await import("../src/browser-export.js");
const { createExportDeadline, limitExportStream } =
    await import("../src/export-limits.js");

type Harness = {
  browserClosed: () => boolean;
  clientInitialized: () => boolean;
  gadgetDisposed: () => boolean;
  pdfRequested: () => boolean;
  renderSettled: () => boolean;
  exportDocument: () => string;
  exportDocumentCsp: () => string | undefined;
  blobRequestContinued: () => boolean;
  htmlSanitized: () => boolean;
  sanitizerInstalled: () => boolean;
  sanitizedInIsolatedRealm: () => boolean;
  mediaType: () => string | undefined;
  screenshotType: () => string | undefined;
  screenshotClip: () => {x: number; y: number; width: number; height: number} | undefined;
  screenshotCaptureBeyondViewport: () => boolean | undefined;
  setDocumentDimensions: (width: number, height: number) => void;
  setSnapshot: (value: string) => void;
};

function makeHarness(pdfChunks = ["%PDF-1.4"], closePdf = true) {
  let browserClosed = false;
  let clientInitialized = false;
  let documentTitle: string | undefined;
  let gadgetDisposed = false;
  let pdfRequested = false;
  let renderSettled = false;
  let exportDocument = "";
  let exportDocumentCsp: string | undefined;
  let blobRequestContinued = false;
  let htmlSanitized = false;
  let sanitizerInstalled = false;
  let sanitizedInIsolatedRealm = false;
  let mediaType: string | undefined;
  let screenshotType: string | undefined;
  let screenshotClip: {x: number; y: number; width: number; height: number} | undefined;
  let screenshotCaptureBeyondViewport: boolean | undefined;
  let documentDimensions = {width: 1000, height: 1000};
  let snapshot = "<!DOCTYPE html>\n<html><head></head><body>Snapshot</body></html>";
  let navigated = false;
  let requestHandler: ((request: unknown) => void) | undefined;
  const evaluate = (
    isolated: boolean,
    fn: ((...args: never[]) => unknown) | string,
    ...args: unknown[]
  ) => {
    if (typeof fn === "string") {
      if (!isolated) throw new Error("HTML sanitizer was installed in the main world.");
      sanitizerInstalled = true;
      return Promise.resolve();
    }
    if (fn.toString().includes("__workshopExportModulePromise")) {
      if (isolated) throw new Error("Client module was awaited outside the main world.");
      clientInitialized = true;
      return Promise.resolve();
    }
    if (fn.toString().includes("MutationObserver")) {
      if (!isolated) throw new Error("DOM settling ran in the main world.");
      expect(clientInitialized).toBe(true);
      renderSettled = true;
      return Promise.resolve();
    }
    if (fn.toString().includes("document.title")) {
      if (!isolated) throw new Error("Document title was assigned in the main world.");
      expect(clientInitialized).toBe(true);
      expect(renderSettled).toBe(true);
      documentTitle = typeof args[0] === "string" ? args[0] : undefined;
      return Promise.resolve();
    }
    if (fn.toString().includes("__workshopExportSanitizeHtml")) {
      if (!isolated) throw new Error("Main-world sanitizer was invoked.");
      expect(sanitizerInstalled).toBe(true);
      sanitizedInIsolatedRealm = true;
      htmlSanitized = typeof args[0] === "string" &&
        args[0].includes("script-src 'none'") &&
        fn.toString().includes("ownerDocument") &&
        !fn.toString().includes("DOMParser") &&
        fn.toString().includes("charset");
      if (new TextEncoder().encode(snapshot).byteLength > Number(args[1])) {
        return Promise.reject(new Error(`Gadget exports may not exceed ${args[1]} bytes.`));
      }
      return Promise.resolve(snapshot);
    }
    if (fn.toString().includes("scrollWidth")) {
      if (!isolated) throw new Error("Document dimensions were measured in the main world.");
      const maxPixels = Number(args[0]);
      const {width, height} = documentDimensions;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
          width <= 0 || height <= 0 || width > Math.floor(maxPixels / height)) {
        return Promise.reject(new Error(
          `Gadget screenshots may not exceed ${maxPixels} pixels.`,
        ));
      }
      return Promise.resolve({x: 0, y: 0, width, height});
    }
    // The RPC transport polls this; the fake page never has a message to deliver.
    return new Promise(() => {});
  };
  const mainFrame = {
    isolatedRealm: () => ({
      evaluate: (fn: (...args: never[]) => unknown, ...args: unknown[]) =>
        evaluate(true, fn, ...args),
    }),
  };

  let page = {
    setRequestInterception: async () => {},
    on: (event: string, handler: (request: unknown) => void) => {
      if (event === "request") requestHandler = handler;
    },
    goto: async () => {
      navigated = true;
      requestHandler?.({
        url: () => "https://gadget-export.invalid/",
        isNavigationRequest: () => true,
        frame: () => mainFrame,
        respond: async (response: {body: string, headers?: Record<string, string>}) => {
          exportDocument = response.body;
          exportDocumentCsp = response.headers?.["Content-Security-Policy"];
        },
      });
      requestHandler?.({
        url: () => "blob:https://gadget-export.invalid/test",
        isNavigationRequest: () => false,
        frame: () => mainFrame,
        continue: async () => { blobRequestContinued = true; },
      });
    },
    mainFrame: () => mainFrame,
    emulateMediaType: async (value: string) => {
      expect(navigated).toBe(false);
      mediaType = value;
    },
    evaluate: (fn: (...args: never[]) => unknown, ...args: unknown[]) =>
      evaluate(false, fn, ...args),
    createPDFStream: async () => {
      expect(clientInitialized).toBe(true);
      expect(documentTitle).toBe("Test Gadget");
      pdfRequested = true;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let chunk of pdfChunks) controller.enqueue(new TextEncoder().encode(chunk));
          if (closePdf) controller.close();
        },
      });
    },
    screenshot: async ({type, clip, captureBeyondViewport}: {
      type: string;
      clip?: {x: number; y: number; width: number; height: number};
      captureBeyondViewport?: boolean;
    }) => {
      screenshotType = type;
      screenshotClip = clip;
      screenshotCaptureBeyondViewport = captureBeyondViewport;
      return new TextEncoder().encode(type);
    },
  };

  launch.mockResolvedValue({
    newPage: async () => page,
    close: async () => {
      browserClosed = true;
    },
  });

  let gadget = {
    [Symbol.dispose]: () => {
      gadgetDisposed = true;
    },
  };

  let harness: Harness = {
    browserClosed: () => browserClosed,
    clientInitialized: () => clientInitialized,
    gadgetDisposed: () => gadgetDisposed,
    pdfRequested: () => pdfRequested,
    renderSettled: () => renderSettled,
    exportDocument: () => exportDocument,
    exportDocumentCsp: () => exportDocumentCsp,
    blobRequestContinued: () => blobRequestContinued,
    htmlSanitized: () => htmlSanitized,
    sanitizerInstalled: () => sanitizerInstalled,
    sanitizedInIsolatedRealm: () => sanitizedInIsolatedRealm,
    mediaType: () => mediaType,
    screenshotType: () => screenshotType,
    screenshotClip: () => screenshotClip,
    screenshotCaptureBeyondViewport: () => screenshotCaptureBeyondViewport,
    setDocumentDimensions: (width, height) => { documentDimensions = {width, height}; },
    setSnapshot: value => { snapshot = value; },
  };
  return { gadget, harness };
}

function render(
  pdfChunks?: string[],
  closePdf = true,
  contentType = "application/pdf",
) {
  let { gadget, harness } = makeHarness(pdfChunks, closePdf);
  let stream = renderGadgetInBrowser(
    {} as BrowserRun,
    "export default {}",
    "Test Gadget",
    gadget as never,
    {
      id: "test-format",
      label: "Test",
      mode: "browser",
      contentType,
      fileExtension: ".test",
    },
  );
  return { stream, harness };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let reader = stream.getReader();
  let text = "";
  let decoder = new TextDecoder();
  for (;;) {
    let { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

beforeEach(() => {
  launch.mockReset();
});

describe("BrowserRpcTransport", () => {
  it("aborts all queued sends when stalled browser delivery exceeds the count limit", async () => {
    let transport = new BrowserRpcTransport({
      evaluate: () => new Promise(() => {}),
    } as never);
    let pending = Array.from({ length: 1024 }, () => transport.send("message"));
    let pendingResults = Promise.allSettled(pending);

    await expect(transport.send("overflow")).rejects.toThrow("send queue overflowed");
    expect((await pendingResults).every(result => result.status === "rejected")).toBe(true);
  });
});

describe("limitStream", () => {
  it("passes through output that stays within the cap", async () => {
    expect(await collect(limitExportStream(
      streamOf(["abc", "de"]),
      createExportDeadline("timed out"),
      undefined,
      5,
    ))).toBe("abcde");
  });

  it("fails as soon as the cap is exceeded rather than buffering the whole export", async () => {
    let reader = limitExportStream(
      streamOf(["abcd", "efgh"]),
      createExportDeadline("timed out"),
      undefined,
      6,
    ).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).rejects.toThrow("may not exceed 6 bytes");
  });

  it("releases resources when a hostile source never settles cancellation", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => {});
      const source = new ReadableStream<Uint8Array>({
        pull() { return new Promise(() => {}); },
        cancel() { return new Promise(() => {}); },
      });
      const reader = limitExportStream(
        source,
        createExportDeadline("timed out", 10),
        release,
      ).getReader();
      const rejection = expect(reader.read()).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(10);

      await rejection;
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("renderGadgetInBrowser", () => {
  it("waits for the client module and DOM to settle, then streams a PDF", async () => {
    let { stream, harness } = render();

    expect(await collect(await stream)).toBe("%PDF-1.4");
    expect(harness.clientInitialized()).toBe(true);
    expect(harness.renderSettled()).toBe(true);
    expect(harness.pdfRequested()).toBe(true);
    expect(harness.mediaType()).toBe("print");
    expect(harness.browserClosed()).toBe(true);
    expect(harness.exportDocument()).toContain(
      'globalThis.gadgetExportFormatId%20%3D%20%22test-format%22',
    );
    expect(harness.exportDocumentCsp()).toContain("img-src data: blob:");
    expect(harness.exportDocumentCsp()).toContain("media-src data: blob:");
    expect(harness.blobRequestContinued()).toBe(true);
  });

  it("exports an inert snapshot with locally bundled DOMPurify", async () => {
    let { stream, harness } = render(undefined, true, "text/html");

    expect(await collect(await stream)).toContain("Snapshot");
    expect(harness.htmlSanitized()).toBe(true);
    expect(harness.sanitizerInstalled()).toBe(true);
    expect(harness.sanitizedInIsolatedRealm()).toBe(true);
    expect(harness.mediaType()).toBe("screen");
    expect(harness.browserClosed()).toBe(true);
  });

  it("rejects oversized HTML before transferring it from the browser", async () => {
    let { gadget, harness } = makeHarness();
    harness.setSnapshot("x".repeat(100 * 1024 * 1024 + 1));

    let stream = renderGadgetInBrowser(
      {} as BrowserRun,
      "export default {}",
      "Test Gadget",
      gadget as never,
      {
        id: "html",
        label: "HTML",
        mode: "browser",
        contentType: "text/html",
        fileExtension: ".html",
      },
    );

    await expect(stream).rejects.toThrow("may not exceed 104857600 bytes");
    expect(harness.browserClosed()).toBe(true);
  });

  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
  ])("captures bounded full-page %s screenshots", async (contentType, screenshotType) => {
    let { stream, harness } = render(undefined, true, contentType);

    expect(await collect(await stream)).toBe(screenshotType);
    expect(harness.screenshotType()).toBe(screenshotType);
    expect(harness.screenshotClip()).toEqual({x: 0, y: 0, width: 1000, height: 1000});
    expect(harness.screenshotCaptureBeyondViewport()).toBe(true);
    expect(harness.mediaType()).toBe("screen");
    expect(harness.browserClosed()).toBe(true);
  });

  it("rejects oversized screenshots before capture", async () => {
    let { gadget, harness } = makeHarness();
    harness.setDocumentDimensions(5001, 5000);

    let stream = renderGadgetInBrowser(
      {} as BrowserRun,
      "export default {}",
      "Test Gadget",
      gadget as never,
      {
        id: "png",
        label: "PNG",
        mode: "browser",
        contentType: "image/png",
        fileExtension: ".png",
      },
    );

    await expect(stream).rejects.toThrow("may not exceed 25000000 pixels");
    expect(harness.screenshotType()).toBeUndefined();
    expect(harness.browserClosed()).toBe(true);
  });

  it("releases the browser when the consumer cancels the stream", async () => {
    let { stream, harness } = render(["first", "second"]);

    let reader = (await stream).getReader();
    await reader.read();
    await reader.cancel("no longer needed");

    expect(harness.browserClosed()).toBe(true);
  });

  it("releases the browser when the export stream exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      let { stream, harness } = render(["first"], false);
      let reader = (await stream).getReader();
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      let timedOut = expect(reader.read()).rejects.toThrow("Browser export timed out.");

      await vi.advanceTimersByTimeAsync(30_000);

      await timedOut;
      expect(harness.browserClosed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the Gadget and closes a browser that launches after the deadline", async () => {
    vi.useFakeTimers();
    try {
      let pendingLaunch = Promise.withResolvers<{ close(): Promise<void> }>();
      let browserClosed = false;
      let gadgetDisposed = false;
      launch.mockReturnValue(pendingLaunch.promise);
      let result = renderGadgetInBrowser(
        {} as BrowserRun,
        "export default {}",
        "Test Gadget",
        { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
        {
          id: "pdf",
          label: "PDF",
          mode: "browser",
          contentType: "application/pdf",
          fileExtension: ".pdf",
        },
      );
      let rejection = expect(result).rejects.toThrow("Browser export timed out.");

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(gadgetDisposed).toBe(true);

      pendingLaunch.resolve({
        close: async () => { browserClosed = true; },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(browserClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the browser and disposes the Gadget when launching fails", async () => {
    let gadgetDisposed = false;
    launch.mockRejectedValue(new Error("no browser available"));

    await expect(renderGadgetInBrowser(
      {} as BrowserRun,
      "export default {}",
      "Test Gadget",
      { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
      {
        id: "pdf",
        label: "PDF",
        mode: "browser",
        contentType: "application/pdf",
        fileExtension: ".pdf",
      },
    )).rejects.toThrow("no browser available");
    expect(gadgetDisposed).toBe(true);
  });
});
