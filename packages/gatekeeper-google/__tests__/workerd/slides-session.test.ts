import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unguardedNativeRead } from "../../src/drive-session";
import { GoogleSlidesApi } from "../../src/slides-api";
import { GooglePresentationSessionImpl } from "../../src/slides";
import { presentation, shape, slide, text } from "../slides-fixture";

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
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

let providerFetches: URL[];

beforeEach(() => {
  providerFetches = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    let url = new URL(input instanceof Request ? input.url : input.toString());
    providerFetches.push(url);
    if (url.hostname !== "slides.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
    }
    return Response.json(presentation([
      slide("s1", [shape("t1", text(["Intro"]), { placeholder: "TITLE" })]),
      slide("s2", [shape("b2", text(["Body"]))], { notes: text(["Say hello"]) }),
    ]));
  }));
});
afterEach(() => vi.unstubAllGlobals());

function newSession() {
  let queue = new TestApprovalQueue();
  let queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  let session = new RpcStub(new GooglePresentationSessionImpl(
    new GoogleSlidesApi(async () => "access-token"), "deck-1", queueStub,
    unguardedNativeRead(description => queueStub.authorizeObservation(description)),
  ));
  return { queue, session };
}

describe("Google Slides presentation session", () => {
  it("returns requested slides in request order after authorizing the read", async () => {
    let { queue, session } = newSession();
    using _session = session;

    let slides = await session.getSlides(["s2", "s1"]);

    expect(slides.map(s => [s.id, s.speakerNotes])).toEqual([["s2", "Say hello"], ["s1", ""]]);
    expect(queue.observations).toHaveLength(1);
  });

  // The error says which IDs are not slides, which is itself something read from the deck.
  it("authorizes the read before reporting an unknown slide ID", async () => {
    let { queue, session } = newSession();
    using _session = session;

    await expect(Promise.resolve(session.getSlides(["s1", "missing"])))
      .rejects.toThrow(/No slide with ID "missing"/);
    expect(queue.observations).toHaveLength(1);
  });

  it.each([[[]], [Array.from({ length: 21 }, (_, i) => `s${i}`)]])(
    "refuses %# out-of-bounds slide counts without reading the deck",
    async ids => {
      let { queue, session } = newSession();
      using _session = session;

      await expect(Promise.resolve(session.getSlides(ids)))
        .rejects.toThrow("between 1 and 20 slides");
      expect(providerFetches).toEqual([]);
      expect(queue.observations).toEqual([]);
    },
  );
});
