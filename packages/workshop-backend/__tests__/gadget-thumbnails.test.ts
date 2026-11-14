// A gadget's thumbnail (GadgetClient.getThumbnail()) is drawn in a browser once for each version of
// its code and kept, so a Library showing it again costs nothing; a failure is kept too, and two
// looks at once share one drawing. Runs against a real OverseerDurableObject with a real commit;
// only the browser is faked.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

const renderGadgetInBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/browser-export.js", async (original) => ({
  ...await original<typeof import("../src/browser-export.js")>(),
  renderGadgetInBrowser,
}));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];

const GADGET = 100;
const SERVER_JS = `
import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {}
`;

let doCounter = 0;

async function withImpl(fn: (impl: Impl) => Promise<void>, browser = true): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-thumbnails-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = instance["impl"];
    impl.env = {...impl.env, BROWSER: browser ? {} as BrowserRun : undefined} as Cloudflare.Env;
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET, title: "Tip Jar", created: new Date(0), bindingName: "TIP_JAR", bindings: {},
    });
    await fn(impl);
  });
}

// Gives the gadget code at a new commit, as a merge does.
async function commit(impl: Impl, clientJs: string): Promise<void> {
  let commitId = await impl.gitCache.writeFilesAsCommit(
      new Map([["server.js", SERVER_JS], ["client.js", clientJs]]), {
        parents: [], author: { name: "Ada", email: "ada@example.com" },
        message: "gadget", timestamp: new Date(1700000000_000),
      });
  impl.storage.gadgets.put({ ...impl.getGadgetRecord(GADGET), commitId });
}

// The browser draws whatever bytes are next, or fails.
function draws(...results: Array<string | Error>): void {
  renderGadgetInBrowser.mockReset();
  for (let result of results) {
    renderGadgetInBrowser.mockImplementationOnce(async (_browser, _code, _title, gadget: Disposable) => {
      gadget[Symbol.dispose]();
      if (result instanceof Error) throw result;
      return new Response(result).body;
    });
  }
}

const text = (image: Uint8Array | null) => (image ? new TextDecoder().decode(image) : null);

describe("GadgetClient.getThumbnail()", () => {
  it("draws the gadget's UI on a page of its own size once for its code, then keeps it", () =>
    withImpl(async (impl) => {
      await commit(impl, "render('one')");
      draws("first picture", "second picture");

      expect(text(await impl.getGadgetThumbnail(GADGET))).toBe("first picture");
      expect(text(await impl.getGadgetThumbnail(GADGET))).toBe("first picture");
      expect(renderGadgetInBrowser).toHaveBeenCalledOnce();
      let [, code, title, , format, viewport] = renderGadgetInBrowser.mock.calls[0]!;
      expect({ code, title, contentType: format.contentType, viewport })
        .toEqual({ code: "render('one')", title: "Tip Jar", contentType: "image/jpeg", viewport: { width: 1280, height: 800 } });

      // New code is drawn again.
      await commit(impl, "render('two')");
      expect(text(await impl.getGadgetThumbnail(GADGET))).toBe("second picture");
      expect(renderGadgetInBrowser).toHaveBeenCalledTimes(2);
    }));

  it("shares one drawing between looks at once", () =>
    withImpl(async (impl) => {
      await commit(impl, "render()");
      draws("picture");

      let [a, b] = await Promise.all([impl.getGadgetThumbnail(GADGET), impl.getGadgetThumbnail(GADGET)]);
      expect([text(a), text(b)]).toEqual(["picture", "picture"]);
      expect(renderGadgetInBrowser).toHaveBeenCalledOnce();
    }));

  it("keeps a failure, so a gadget that can't be drawn isn't tried on every look", () =>
    withImpl(async (impl) => {
      await commit(impl, "render()");
      draws(new Error("Browser export timed out."), "picture");

      expect(await impl.getGadgetThumbnail(GADGET)).toBeNull();
      expect(await impl.getGadgetThumbnail(GADGET)).toBeNull();
      expect(renderGadgetInBrowser).toHaveBeenCalledOnce();
      expect(impl.storage.thumbnails.get(GADGET)?.failedAt).toBeInstanceOf(Date);
    }));

  it("has nothing for a gadget with no commit, or a deployment with no browser", async () => {
    draws("picture");
    await withImpl(async (impl) => {
      expect(await impl.getGadgetThumbnail(GADGET)).toBeNull();
    });
    await withImpl(async (impl) => {
      await commit(impl, "render()");
      expect(await impl.getGadgetThumbnail(GADGET)).toBeNull();
    }, false);
    expect(renderGadgetInBrowser).not.toHaveBeenCalled();
  });

  it("forgets the picture with the gadget", () =>
    withImpl(async (impl) => {
      await commit(impl, "render()");
      draws("picture");
      await impl.getGadgetThumbnail(GADGET);
      expect(impl.storage.thumbnails.get(GADGET)).toBeDefined();

      await impl.removeWorkpiece(GADGET);
      expect(impl.storage.thumbnails.get(GADGET)).toBeUndefined();
    }));
});
