import { describe, expect, it, vi } from "vitest";
import {
  defaultExportFormats,
  exportServerFormat,
  readCustomExportFormats,
  validateExportFormats,
} from "../src/gadget-export";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe("Gadget export formats", () => {
  it("provides fresh HTML and PDF defaults", () => {
    const first = defaultExportFormats();
    const second = defaultExportFormats();

    expect(first.map(format => format.id)).toEqual(["html", "pdf"]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });

  it("accepts browser and server formats", () => {
    const formats = validateExportFormats([
      {
        id: "png",
        label: "Image",
        mode: "browser",
        contentType: "image/png",
        fileExtension: ".png",
      },
      {
        id: "csv",
        label: "CSV",
        mode: "server",
        contentType: "text/csv",
        fileExtension: ".csv",
        ignored: "value",
      },
    ]);

    expect(formats.map(format => format.id)).toEqual(["png", "csv"]);
    expect(formats[1]).not.toHaveProperty("ignored");
  });

  it("rejects duplicate ids and unsupported browser content types", () => {
    const format = {
      id: "data",
      label: "Data",
      mode: "server",
      contentType: "text/csv",
      fileExtension: ".csv",
    };
    expect(() => validateExportFormats([format, format])).toThrow("id is not unique");
    expect(() => validateExportFormats([{
      ...format,
      mode: "browser",
    }])).toThrow("unsupported content type");
  });

  it("rejects unsafe file extensions and invalid media types", () => {
    const format = {
      id: "data",
      label: "Data",
      mode: "server",
      contentType: "text/csv",
      fileExtension: ".csv",
    };
    expect(() => validateExportFormats([{
      ...format,
      fileExtension: "/report.csv",
    }])).toThrow("invalid file extension");
    expect(() => validateExportFormats([{
      ...format,
      fileExtension: ".1234567890123456",
    }])).toThrow("between 1 and 16 characters");
    expect(() => validateExportFormats([{
      ...format,
      fileExtension: ".csv.",
    }])).toThrow("invalid file extension");
    expect(() => validateExportFormats([{
      ...format,
      contentType: "not a media type",
    }])).toThrow("invalid content type");
  });

  it("uses defaults for missing-entrypoint errors and propagates other failures", async () => {
    const missing = {
      async getExportFormats() {
        throw new Error("Worker has no such entrypoint: ExportHandler");
      },
    };
    await expect(readCustomExportFormats(missing, {})).resolves.toBeNull();

    const broken = {
      async getExportFormats() {
        throw new Error("handler failed");
      },
    };
    await expect(readCustomExportFormats(broken, {})).rejects.toThrow("handler failed");

    const internalError = {
      async getExportFormats() {
        throw new Error("internal error; reference = 9fcjmb0apkauhvfiron4rfaj");
      },
    };
    await expect(readCustomExportFormats(internalError, {})).resolves.toBeNull();
  });

  it("times out format discovery", async () => {
    vi.useFakeTimers();
    try {
      const result = readCustomExportFormats({
        getExportFormats: () => new Promise<never>(() => {}),
      }, {});
      const rejection = expect(result).rejects.toThrow(
        "Listing Gadget export formats timed out.",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("exportServerFormat", () => {
  it("streams server-generated content", async () => {
    const stream = await exportServerFormat(async () => streamOf(["a", "bc"]));
    expect(await new Response(stream).text()).toBe("abc");
  });

  it("times out while waiting for the handler", async () => {
    vi.useFakeTimers();
    try {
      const result = exportServerFormat(() => new Promise(() => {}));
      const rejection = expect(result).rejects.toThrow("Gadget export timed out.");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stream returned after the handler deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<ReadableStream<Uint8Array>>();
      const result = exportServerFormat(() => pending.promise);
      const rejection = expect(result).rejects.toThrow("Gadget export timed out.");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;

      const cancel = vi.fn();
      pending.resolve(new ReadableStream({cancel}));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
