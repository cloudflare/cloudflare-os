import { beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ launch }));

const { BrowserRpcTransport, limitStream, makeExportHtml, renderGadgetPdf } =
    await import("../src/browser-export.js");

type Harness = {
  browserClosed: () => boolean;
  clientInitialized: () => boolean;
  gadgetDisposed: () => boolean;
  pdfRequested: () => boolean;
  renderSettled: () => boolean;
};

function makeHarness(pdfChunks = ["%PDF-1.4"], closePdf = true) {
  let browserClosed = false;
  let clientInitialized = false;
  let documentTitle: string | undefined;
  let gadgetDisposed = false;
  let pdfRequested = false;
  let renderSettled = false;

  let page = {
    setRequestInterception: async () => {},
    on: () => {},
    goto: async () => {},
    mainFrame: () => ({}),
    emulateMediaType: async () => {},
    evaluate: (fn: (...args: never[]) => unknown, ...args: unknown[]) => {
      if (fn.toString().includes("__workshopExportModulePromise")) {
        clientInitialized = true;
        renderSettled = fn.toString().includes("MutationObserver");
        return Promise.resolve();
      }
      if (fn.toString().includes("document.title")) {
        documentTitle = typeof args[0] === "string" ? args[0] : undefined;
        return Promise.resolve();
      }
      // The RPC transport polls this; the fake page never has a message to deliver.
      return new Promise(() => {});
    },
    createPDFStream: async () => {
      expect(clientInitialized).toBe(true);
      expect(renderSettled).toBe(true);
      expect(documentTitle).toBe("Test Gadget");
      pdfRequested = true;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let chunk of pdfChunks) controller.enqueue(new TextEncoder().encode(chunk));
          if (closePdf) controller.close();
        },
      });
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
  };
  return { gadget, harness };
}

function render(pdfChunks?: string[], closePdf = true) {
  let { gadget, harness } = makeHarness(pdfChunks, closePdf);
  let stream = renderGadgetPdf(
    {} as BrowserRun,
    "export default {}",
    "Test Gadget",
    gadget as never,
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
    expect(await collect(limitStream(streamOf(["abc", "de"]), 5))).toBe("abcde");
  });

  it("fails as soon as the cap is exceeded rather than buffering the whole export", async () => {
    let reader = limitStream(streamOf(["abcd", "efgh"]), 6).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).rejects.toThrow("may not exceed 6 bytes");
  });
});

describe("renderGadgetPdf", () => {
  it("installs the shared light theme before running exported Gadget code", () => {
    let html = makeExportHtml("document.body.textContent = 'ready'");
    let decoded = decodeURIComponent(decodeURIComponent(html));

    expect(decoded).toContain("--gadget-color-accent: #ff4801");
    expect(decoded).toContain(".gadget-panel");
    expect(decoded.indexOf("__workshopApplyTheme")).toBeLessThan(
      decoded.indexOf("document.body.textContent = 'ready'"),
    );
  });

  it("settles the client render, streams a PDF, and releases the browser", async () => {
    let { stream, harness } = render();

    expect(await collect(await stream)).toBe("%PDF-1.4");
    expect(harness.clientInitialized()).toBe(true);
    expect(harness.renderSettled()).toBe(true);
    expect(harness.pdfRequested()).toBe(true);
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

      await vi.advanceTimersByTimeAsync(30_000);

      expect(harness.browserClosed()).toBe(true);
      await reader.cancel();
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
      let result = renderGadgetPdf(
        {} as BrowserRun,
        "export default {}",
        "Test Gadget",
        { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
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

    await expect(renderGadgetPdf(
      {} as BrowserRun,
      "export default {}",
      "Test Gadget",
      { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
    )).rejects.toThrow("no browser available");
    expect(gadgetDisposed).toBe(true);
  });
});
