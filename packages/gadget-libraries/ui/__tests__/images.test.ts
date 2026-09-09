import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IMAGE_LIMITS,
  IMAGE_TYPES,
  altFromFileName,
  imageFilesFrom,
  isImageFile,
  loadImage,
  prepareImage,
  readFileAsDataURL,
} from "../src/images.ts";

/**
 * jsdom neither decodes images nor draws on a canvas, so the browser's two decoding steps are
 * stood in for: an `Image` that reports the size encoded in its source, and a canvas whose data
 * URL is as long as the requested quality and pixel count say.
 */
function stubDecoding({ webp = true }: { webp?: boolean } = {}) {
  class FakeImage extends EventTarget {
    naturalWidth = 0;
    naturalHeight = 0;
    width = 0;
    height = 0;
    set src(value: string) {
      // The size is written in the file's bytes, which a reader delivers base64-encoded.
      const size = /(\d+)x(\d+)/.exec(atob(value.slice(value.indexOf(",") + 1)));
      queueMicrotask(() => {
        if (!size) return this.dispatchEvent(new Event("error"));
        this.naturalWidth = Number(size[1]);
        this.naturalHeight = Number(size[2]);
        this.dispatchEvent(new Event("load"));
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ drawImage }) as unknown as CanvasRenderingContext2D);
  const encodings: Array<{ type: string; quality: number; width: number; height: number }> = [];
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement, type = "image/png", quality = 0.92) {
    encodings.push({ type, quality, width: this.width, height: this.height });
    const mime = type === "image/webp" && !webp ? "image/png" : type;
    return `data:${mime};base64,` + "A".repeat(Math.round((this.width * this.height * quality) / 100));
  });
  return { drawImage, encodings };
}

/** A file whose data URL, once base64-decoded, announces the image size the fake decoder reports. */
function imageFile(name: string, type: string, size: string, padTo = 0): File {
  return new File([size.padEnd(padTo, "-")], name, { type });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isImageFile and IMAGE_TYPES", () => {
  it("accepts the raster types and nothing else", () => {
    expect([...IMAGE_TYPES].toSorted()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
    expect(isImageFile(new File([""], "a.png", { type: "image/png" }))).toBe(true);
    expect(isImageFile(new File([""], "a.svg", { type: "image/svg+xml" }))).toBe(false);
    expect(isImageFile(new File([""], "a.txt", { type: "text/plain" }))).toBe(false);
    expect(isImageFile(null)).toBe(false);
    expect(isImageFile(undefined)).toBe(false);
  });
});

describe("imageFilesFrom", () => {
  const png = new File([""], "a.png", { type: "image/png" });
  const txt = new File([""], "a.txt", { type: "text/plain" });

  it("returns the image files of the payload", () => {
    const transfer = { files: [png, txt], items: [] } as unknown as DataTransfer;
    expect(imageFilesFrom(transfer)).toEqual([png]);
  });

  it("falls back to the file items when files is empty", () => {
    const items = [
      { kind: "file", type: "image/png", getAsFile: () => png },
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "text/plain", getAsFile: () => txt },
    ];
    expect(imageFilesFrom({ files: [], items } as unknown as DataTransfer)).toEqual([png]);
  });

  it("is empty for no transfer", () => {
    expect(imageFilesFrom(null)).toEqual([]);
  });
});

describe("altFromFileName", () => {
  it("drops the extension and separators", () => {
    expect(altFromFileName("team-photo_2026.JPG")).toBe("team photo 2026");
    expect(altFromFileName("diagram.webp")).toBe("diagram");
    expect(altFromFileName("no-extension")).toBe("no extension");
  });

  it("falls back to Image", () => {
    expect(altFromFileName("")).toBe("Image");
    expect(altFromFileName(".png")).toBe("Image");
    expect(altFromFileName("--_")).toBe("Image");
  });
});

describe("readFileAsDataURL", () => {
  it("reads a file as a data URL", async () => {
    const url = await readFileAsDataURL(new File(["hello"], "a.txt", { type: "text/plain" }));
    expect(url).toBe("data:text/plain;base64,aGVsbG8=");
  });
});

describe("loadImage", () => {
  it("resolves the image once it has loaded", async () => {
    stubDecoding();
    const image = await loadImage(`data:image/png;base64,${btoa("800x600")}`);
    expect(image.naturalWidth).toBe(800);
    expect(image.naturalHeight).toBe(600);
  });

  it("rejects what the browser cannot decode", async () => {
    stubDecoding();
    await expect(loadImage(`data:image/png;base64,${btoa("garbage")}`)).rejects.toThrow(/not an image/);
  });
});

describe("prepareImage", () => {
  it("re-encodes a fitting image as WebP at full size and the first quality", async () => {
    const { encodings, drawImage } = stubDecoding();
    const prepared = await prepareImage(imageFile("team-photo.png", "image/png", "800x600"));
    expect(prepared).toMatchObject({ alt: "team photo", width: 800, height: 600 });
    expect(prepared.src.startsWith("data:image/webp;base64,")).toBe(true);
    expect(encodings).toEqual([{ type: "image/webp", quality: 0.86, width: 800, height: 600 }]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
  });

  it("downscales to the longest edge", async () => {
    stubDecoding();
    const prepared = await prepareImage(imageFile("wide.png", "image/png", "4000x1000"));
    expect(prepared.width).toBe(1600);
    expect(prepared.height).toBe(400);
  });

  it("steps down quality, then size, until the data URL fits, and rejects when nothing does", async () => {
    const { encodings } = stubDecoding();
    // 1000x1000 at 0.86 is 8600 characters plus the prefix; 0.5 is 5000.
    const prepared = await prepareImage(imageFile("big.png", "image/png", "1000x1000"), { maxDataUrlLength: 5100 });
    expect(encodings.map((encoding) => encoding.quality)).toEqual([0.86, 0.74, 0.62, 0.5]);
    expect(prepared.width).toBe(1000);

    encodings.length = 0;
    const smaller = await prepareImage(imageFile("big.png", "image/png", "1000x1000"), { maxDataUrlLength: 3000 });
    expect(smaller.width).toBe(700);
    expect(encodings.at(-1)).toMatchObject({ width: 700, height: 700 });

    await expect(prepareImage(imageFile("big.png", "image/png", "1000x1000"), { maxDataUrlLength: 100 })).rejects.toThrow(/too large/);
  });

  it("falls back to JPEG where WebP is not encodable", async () => {
    const { encodings } = stubDecoding({ webp: false });
    const prepared = await prepareImage(imageFile("a.png", "image/png", "10x10"));
    expect(prepared.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(encodings.map((encoding) => encoding.type)).toEqual(["image/webp", "image/jpeg"]);
  });

  it("keeps a GIF that fits as it is, and re-encodes one that does not", async () => {
    const { encodings } = stubDecoding();
    const kept = await prepareImage(imageFile("anim.gif", "image/gif", "200x100"));
    expect(kept.src.startsWith("data:image/gif;base64,")).toBe(true);
    expect(kept).toMatchObject({ width: 200, height: 100, alt: "anim" });
    expect(encodings).toEqual([]);

    const shrunk = await prepareImage(imageFile("huge.gif", "image/gif", "3200x1600"));
    expect(shrunk.src.startsWith("data:image/webp;base64,")).toBe(true);
    expect(shrunk.width).toBe(1600);

    const heavy = await prepareImage(imageFile("heavy.gif", "image/gif", "200x100", 400), { maxGifDataUrlLength: 300 });
    expect(heavy.src.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("gives a GIF its own byte budget, wider than a re-encodable image's", async () => {
    const { encodings } = stubDecoding();
    // Over the general budget but within the GIF one: kept animated.
    const kept = await prepareImage(imageFile("anim.gif", "image/gif", "200x100", 400), { maxDataUrlLength: 300, maxGifDataUrlLength: 700 });
    expect(kept.src.startsWith("data:image/gif;base64,")).toBe(true);
    expect(encodings).toEqual([]);

    // A PNG of the same weight is over its budget, and re-encoded.
    const png = await prepareImage(imageFile("still.png", "image/png", "200x100", 400), { maxDataUrlLength: 300, maxGifDataUrlLength: 700 });
    expect(png.src.startsWith("data:image/webp;base64,")).toBe(true);

    // Passed as undefined, the GIF budget keeps its default.
    const defaulted = await prepareImage(imageFile("anim.gif", "image/gif", "200x100", 400), { maxDataUrlLength: 300, maxGifDataUrlLength: undefined });
    expect(defaulted.src.startsWith("data:image/gif;base64,")).toBe(true);
  });

  it("takes the alt text and limits from its options", async () => {
    stubDecoding();
    const prepared = await prepareImage(imageFile("a.png", "image/png", "800x800"), { alt: "a.png", maxDimension: 400 });
    expect(prepared.alt).toBe("a.png");
    expect(prepared.width).toBe(400);
    expect(DEFAULT_IMAGE_LIMITS).toEqual({ maxDimension: 1600, maxDataUrlLength: 1_400_000, maxGifDataUrlLength: 2_700_000 });
  });

  it("keeps a default for a limit passed as undefined", async () => {
    stubDecoding();
    const prepared = await prepareImage(imageFile("wide.png", "image/png", "4000x1000"), { maxDimension: undefined, maxDataUrlLength: undefined });
    expect(prepared.width).toBe(1600);
    expect(prepared.src.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("rejects a file the browser cannot decode", async () => {
    stubDecoding();
    await expect(prepareImage(imageFile("a.png", "image/png", "garbage"))).rejects.toThrow(/not an image/);
  });

  it("rejects when the canvas has no 2d context", async () => {
    stubDecoding();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    await expect(prepareImage(imageFile("a.png", "image/png", "10x10"))).rejects.toThrow(/cannot process/);
  });
});
