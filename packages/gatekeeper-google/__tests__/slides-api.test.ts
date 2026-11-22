import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleSlidesApi } from "../src/slides-api";
import { LABEL_FIELDS, SLIDE_FIELDS } from "../src/slides-fields";
import { titleOf } from "../src/slides-model";

const token = async () => "access-token";

/** One page request the stubbed `fetch` holds until the test answers it. */
type Asked = {
  id: string;
  fields: string | null;
  open: boolean;
  /** Answers with the page, or with `status` and no page. */
  answer(status?: number): void;
};

/**
 * Stubs `fetch` with one that answers no page request until the test does. `asked` holds the
 * requests in the order they were made, and `most` the most that were open at once under each
 * `fields`.
 */
function holdPages() {
  let asked: Asked[] = [];
  let most: Record<string, number> = { [SLIDE_FIELDS]: 0, [LABEL_FIELDS]: 0 };
  let open = (fields: string | null) => asked.filter(page => page.open && page.fields === fields).length;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => new Promise<Response>(resolve => {
    let url = new URL(String(input));
    let id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    let fields = url.searchParams.get("fields");
    asked.push({
      id, fields, open: true,
      answer(status = 200) {
        this.open = false;
        resolve(status === 200 ? Response.json({ objectId: id })
          : Response.json({ error: { code: status } }, { status }));
      },
    });
    most[fields!] = Math.max(most[fields!], open(fields));
  })));
  /** Resolves once `count` requests have been made, and fails if more were. */
  let reaches = (count: number) => vi.waitFor(() => expect(asked).toHaveLength(count), { interval: 1 });
  /** Answers the open requests one by one, oldest first, each as `status` says, until none is made. */
  let answerAll = async (status: (page: Asked) => number = () => 200) => {
    for (let page: Asked | undefined; (page = asked.find(next => next.open));) {
      page.answer(status(page));
      await turns();
    }
  };
  return { asked, most, open, reaches, answerAll };
}

/** Lets the client run as far as it can on the answers it has. */
async function turns(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** The message `read` fails with. It is caught at once, so a failure the test has yet to await is handled. */
const failureOf = (read: Promise<unknown>) =>
  read.then(() => "the read did not fail", (error: Error) => error.message);

const ids = (count: number) => Array.from({ length: count }, (_page, at) => `s${at + 1}`);

describe("GoogleSlidesApi.getSlides", () => {
  const api = new GoogleSlidesApi(token);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts every request at once, whole pages and labels together, in the order of the IDs", async () => {
    let pages = holdPages();
    let wanted = ids(30);
    let whole = ["s3", "s8", "s12", "s17", "s24", "s30"];
    let read = api.getSlides("deck-1", wanted, wanted, new Set(wanted.filter(id => !whole.includes(id))));

    await pages.reaches(30);
    await turns();
    expect(pages.asked).toHaveLength(30);
    expect(pages.asked.map(page => [page.id, page.fields]))
      .toEqual(wanted.map(id => [id, whole.includes(id) ? SLIDE_FIELDS : LABEL_FIELDS]));
    expect(pages.most).toEqual({ [SLIDE_FIELDS]: 6, [LABEL_FIELDS]: 24 });

    for (let page of pages.asked.toReversed()) page.answer();
    expect([...(await read).keys()]).toEqual(wanted);
  });

  it("returns the slides in the order of the IDs, whatever order the answers come in", async () => {
    let pages = holdPages();
    let wanted = ["s3", "s1", "s2", "s5", "s4"];
    let read = api.getSlides("deck-1", wanted, ids(5), new Set(["s1", "s5"]));

    await pages.reaches(5);
    for (let page of pages.asked.toReversed()) page.answer();

    let labelled = new Set(["s1", "s5"]);
    expect([...await read]).toEqual(wanted.map(id =>
      [id, labelled.has(id) ? { objectId: id, pageElements: [] } : { objectId: id }]));
  });

  it("keeps of a label page the title and the slide numbers, and lets the rest of its text go", async () => {
    // Twenty label pages, each a title that shows its number and a body of about 1 MiB of text.
    let body = Array.from({ length: 10_000 }, (_run, at) => ({ textRun: { content: `${"x".repeat(99)}${at}\n` } }));
    let page = (id: string, number: number) => ({
      objectId: id,
      slideProperties: { isSkipped: number % 2 === 0 },
      pageElements: [
        { objectId: `${id}-body`, shape: { placeholder: { type: "BODY" }, text: { textElements: body } } },
        { objectId: `${id}-title`, shape: { placeholder: { type: "TITLE" }, text: { textElements: [
          { textRun: { content: "Part " } }, { autoText: { type: "SLIDE_NUMBER", content: `${number}` } },
          { textRun: { content: `${"y".repeat(300)}\n` } },
        ] } } },
        { objectId: `${id}-footer`, shape: { placeholder: { type: "FOOTER" }, text: { textElements: [
          { textRun: { content: "Page " } }, { autoText: { type: "SLIDE_NUMBER", content: `${number}` } },
        ] } } },
      ],
    });
    let ids = Array.from({ length: 20 }, (_id, at) => `s${at + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      let id = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!);
      return Response.json(page(id, ids.indexOf(id) + 1));
    }));

    let read = await api.getSlides("deck-1", ids, ids, new Set(ids));

    for (let [id, kept] of read) {
      let whole = page(id, ids.indexOf(id) + 1);
      expect(titleOf(kept)).toBe(titleOf(whole));
      expect(kept.slideProperties).toEqual({ isSkipped: whole.slideProperties.isSkipped });
      let numbers = kept.pageElements!.flatMap(element =>
        (element.shape?.text?.textElements ?? []).filter(text => text.autoText?.type === "SLIDE_NUMBER"));
      expect(numbers.map(text => text.autoText!.content)).toEqual([`${ids.indexOf(id) + 1}`, `${ids.indexOf(id) + 1}`]);
      expect(JSON.stringify(kept).length).toBeLessThan(1_024);
    }
  });

  it("skips the IDs the deck's order no longer has, and asks for nothing when none is left", async () => {
    let pages = holdPages();
    let read = api.getSlides("deck-1", ["s1", "gone", "s2"], ["s2", "s1"], new Set(["gone"]));
    await pages.reaches(2);
    await pages.answerAll();

    expect([...(await read).keys()]).toEqual(["s1", "s2"]);
    expect(pages.asked.map(page => page.id)).toEqual(["s1", "s2"]);

    expect(await api.getSlides("deck-1", ["gone", "s9"], ["s1", "s2"], new Set(["s9"]))).toEqual(new Map());
    expect(await api.getSlides("deck-1", [], ["s1", "s2"])).toEqual(new Map());
    expect(pages.asked).toHaveLength(2);
  });

  it("fails with the first failure to arrive when two fail", async () => {
    let pages = holdPages();
    let wanted = ids(4);
    let failure = failureOf(api.getSlides("deck-1", wanted, wanted));
    await pages.reaches(4);

    pages.asked[2].answer(403);
    await turns();
    pages.asked[1].answer(404);
    await turns();
    pages.asked[3].answer();
    pages.asked[0].answer();

    expect(await failure).toBe("Google Slides get slide failed [http=403]");
  });

  it("fails at once on a failure, whatever is still running before or after it", async () => {
    let pages = holdPages();
    let wanted = ids(10);
    let settled = false;
    let failure = failureOf(api.getSlides("deck-1", wanted, wanted)).finally(() => { settled = true; });
    await pages.reaches(10);

    // s1 and s2 are still held, before it, and s4 to s10 after it.
    pages.asked[2].answer(404);
    await turns();
    expect(settled).toBe(true);
    expect(await failure).toBe("Google Slides get slide failed [http=404]");
    expect(pages.open(SLIDE_FIELDS)).toBe(9);

    // Their answers, a failure among them, are dropped.
    await pages.answerAll(page => page.id === "s1" ? 403 : 200);
    expect(pages.asked).toHaveLength(10);
  });

  it("asks for label fields of the IDs it is told to, and the full page of the others", async () => {
    let pages = holdPages();
    let wanted = ids(4);
    let read = api.getSlides("deck-1", wanted, wanted, new Set(["s2", "s4", "s9"]));
    await pages.reaches(4);
    await pages.answerAll();

    expect([...(await read).keys()]).toEqual(wanted);
    expect(pages.asked.map(page => [page.id, page.fields])).toEqual([
      ["s1", SLIDE_FIELDS], ["s2", LABEL_FIELDS], ["s3", SLIDE_FIELDS], ["s4", LABEL_FIELDS],
    ]);
  });

  it("fails with the first failure to arrive, whether that slide is read whole or by label", async () => {
    // s2 fails with 403 and s5 with 404, s5 first; one of the two is read whole, the other by label.
    for (let whole of ["s2", "s5"]) {
      let pages = holdPages();
      let wanted = ids(8);
      let failure = failureOf(api.getSlides("deck-1", wanted, wanted, new Set(wanted.filter(id => id !== whole))));
      await pages.reaches(8);
      pages.asked[4].answer(404);
      await turns();
      await pages.answerAll(page => page.id === "s2" ? 403 : 200);

      expect(await failure).toBe("Google Slides get slide failed [http=404]");
      expect(pages.asked.filter(page => page.fields === SLIDE_FIELDS).map(page => page.id)).toEqual([whole]);
      vi.unstubAllGlobals();
    }
  });
});
