import { describe, expect, it, vi } from "vite-plus/test";
import { MAX_SITE_LOGO_BYTES, MAX_SITE_LOGO_DIMENSION } from "@gadgets/workshop-shared/api";
import {
  SITE_LOGO_R2_KEY,
  serveSiteLogo,
  siteLogoImage,
  validateSiteLogo,
} from "../src/site-logo.js";

const REVISION = "550e8400-e29b-41d4-a716-446655440000";

function png(width = 256, height = 128, byteLength = 33): Uint8Array {
  let data = new Uint8Array(byteLength);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  data.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  let view = new DataView(data.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return data;
}

describe("site logo validation", () => {
  it("accepts bounded PNG data", () => {
    expect(() => validateSiteLogo(png())).not.toThrow();
  });

  it("rejects the wrong format, oversized data, and dangerous dimensions", () => {
    expect(() => validateSiteLogo(new Uint8Array())).toThrow("PNG");
    expect(() => validateSiteLogo(new Uint8Array([0xff, 0xd8, 0xff]))).toThrow("PNG");
    expect(() => validateSiteLogo(png(MAX_SITE_LOGO_DIMENSION + 1))).toThrow("dimensions");
    expect(() => validateSiteLogo(png(1, 1, MAX_SITE_LOGO_BYTES + 1))).toThrow("too large");
  });
});

describe("site logo asset", () => {
  it("returns the canonical URL only when a logo is configured", () => {
    expect(siteLogoImage(false)).toBeUndefined();
    expect(siteLogoImage(true)).toEqual({ url: "/api/site-logo" });
  });

  it("serves PNG bytes with short mutable caching and nosniff", async () => {
    let data = png();
    let get = vi.fn().mockResolvedValue({ body: new Blob([data]).stream() });
    let response = await serveSiteLogo(
      new Request(`https://workshop.example/api/site-logo?v=${REVISION}`),
      { get } as Pick<R2Bucket, "get">,
    );

    expect(get).toHaveBeenCalledWith(SITE_LOGO_R2_KEY);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
  });

  it("does not cache missing data and rejects unsupported requests", async () => {
    let get = vi.fn().mockResolvedValue(null);
    let bucket = { get } as Pick<R2Bucket, "get">;
    let missing = await serveSiteLogo(
      new Request(`https://workshop.example/api/site-logo?v=${REVISION}`), bucket);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    expect((await serveSiteLogo(new Request("https://workshop.example/api/site-logo", {
      method: "POST",
    }), bucket)).status).toBe(405);
  });
});
