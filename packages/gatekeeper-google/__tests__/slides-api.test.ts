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
  /** Whole pages that were open when this request was made. */
  wholeOpen: number;
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
      id, fields, open: true, wholeOpen: open(SLIDE_FIELDS),
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

  it("starts no more than four page requests at a time", async () => {
    let pages = holdPages();
    let wanted = ids(10);
    let read = api.getSlides("deck-1", wanted, wanted);

    for (let answered = 0; answered < wanted.length; answered++) {
      await pages.reaches(Math.min(wanted.length, 4 + answered));
      await turns();
      expect(pages.open(SLIDE_FIELDS)).toBe(Math.min(4, wanted.length - answered));
      pages.asked[answered].answer();
    }

    expect([...(await read).keys()]).toEqual(wanted);
    expect(pages.asked.map(page => page.id)).toEqual(wanted);
    expect(pages.most).toEqual({ [SLIDE_FIELDS]: 4, [LABEL_FIELDS]: 0 });
  });

  it("returns the slides in the order of the IDs, whatever order the answers come in", async () => {
    let pages = holdPages();
    let wanted = ["s3", "s1", "s2", "s5", "s4"];
    let read = api.getSlides("deck-1", wanted, ids(5), new Set(["s1", "s5"]));

    // Each round's answers come newest first: the whole pages, then the labels.
    await pages.reaches(3);
    for (let page of pages.asked.slice(0, 3).toReversed()) page.answer();
    await pages.reaches(5);
    for (let page of pages.asked.slice(3).toReversed()) page.answer();

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

  it("fails with the earliest failed page's error when two fail, whichever answers first", async () => {
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

    expect(await failure).toBe("Google Slides get slide failed [http=404]");
  });

  it("starts no request after one fails, and fails once every earlier ID has answered", async () => {
    let pages = holdPages();
    let wanted = ids(10);
    let settled = false;
    let failure = failureOf(api.getSlides("deck-1", wanted, wanted)).finally(() => { settled = true; });
    await pages.reaches(4);
    pages.asked[0].answer();
    await pages.reaches(5);

    pages.asked[2].answer(404);
    await turns();
    // The request for s2, before the failed one, could still fail first by the IDs' order.
    expect(settled).toBe(false);
    expect(pages.open(SLIDE_FIELDS)).toBe(3);

    pages.asked[1].answer();
    await turns();
    // Those for s4 and s5 come after it and cannot change the error: the read fails while they run.
    expect(settled).toBe(true);
    expect(await failure).toBe("Google Slides get slide failed [http=404]");
    expect(pages.open(SLIDE_FIELDS)).toBe(2);

    // Their answers are dropped, and no other request starts.
    pages.asked[3].answer();
    pages.asked[4].answer(403);
    await turns();
    expect(pages.asked.map(page => page.id)).toEqual(wanted.slice(0, 5));
  });

  it("fails at once on the first ID's failure, whatever is still running", async () => {
    let pages = holdPages();
    let wanted = ids(6);
    let settled = false;
    let failure = failureOf(api.getSlides("deck-1", wanted, wanted)).finally(() => { settled = true; });
    await pages.reaches(4);

    pages.asked[0].answer(404);
    await turns();
    expect(settled).toBe(true);
    expect(await failure).toBe("Google Slides get slide failed [http=404]");
    expect(pages.open(SLIDE_FIELDS)).toBe(3);
    await pages.answerAll();
    expect(pages.asked).toHaveLength(4);
  });

  it("asks for label fields of the IDs it is told to, and the full page of the others", async () => {
    let pages = holdPages();
    let wanted = ids(4);
    let read = api.getSlides("deck-1", wanted, wanted, new Set(["s2", "s4", "s9"]));
    await pages.reaches(2);
    await pages.answerAll();

    expect([...(await read).keys()]).toEqual(wanted);
    expect(pages.asked.map(page => [page.id, page.fields])).toEqual([
      ["s1", SLIDE_FIELDS], ["s3", SLIDE_FIELDS], ["s2", LABEL_FIELDS], ["s4", LABEL_FIELDS],
    ]);
  });

  it("starts up to six requests at a time when it asks only for labels", async () => {
    let pages = holdPages();
    let wanted = ids(30);
    let read = api.getSlides("deck-1", wanted, wanted, new Set(wanted));

    for (let answered = 0; answered < wanted.length; answered++) {
      await pages.reaches(Math.min(wanted.length, 6 + answered));
      await turns();
      expect(pages.open(LABEL_FIELDS)).toBe(Math.min(6, wanted.length - answered));
      pages.asked[answered].answer();
    }

    expect([...(await read).keys()]).toEqual(wanted);
    expect(pages.most).toEqual({ [SLIDE_FIELDS]: 0, [LABEL_FIELDS]: 6 });
  });

  it("fetches a mixed read's whole pages four at a time, then its labels six at a time", async () => {
    let pages = holdPages();
    let wanted = ids(30);
    let whole = ["s3", "s8", "s12", "s17", "s24", "s30"];
    let read = api.getSlides("deck-1", wanted, wanted, new Set(wanted.filter(id => !whole.includes(id))));

    for (let answered = 0; answered < wanted.length; answered++) {
      // The whole pages, four open; once the last has answered, the labels, six open.
      await pages.reaches(answered < 6 ? Math.min(6, 4 + answered) : Math.min(wanted.length, 6 + answered));
      await turns();
      pages.asked[answered].answer();
    }

    expect([...(await read).keys()]).toEqual(wanted);
    expect(pages.asked.slice(0, 6).map(page => [page.id, page.fields]))
      .toEqual(whole.map(id => [id, SLIDE_FIELDS]));
    let labels = pages.asked.slice(6);
    expect(labels.map(page => page.id)).toEqual(wanted.filter(id => !whole.includes(id)));
    expect(labels.every(page => page.fields === LABEL_FIELDS && page.wholeOpen === 0)).toBe(true);
    expect(pages.most).toEqual({ [SLIDE_FIELDS]: 4, [LABEL_FIELDS]: 6 });
  });

  it("asks for no label once a whole page fails, and reports the whole page's error", async () => {
    let pages = holdPages();
    let wanted = ids(12);
    let whole = ["s2", "s5", "s9"];
    let failure = failureOf(
      api.getSlides("deck-1", wanted, wanted, new Set(wanted.filter(id => !whole.includes(id)))));
    await pages.reaches(3);
    await pages.answerAll(page => page.id === "s5" ? 404 : 200);

    expect(await failure).toBe("Google Slides get slide failed [http=404]");
    expect(pages.asked.map(page => [page.id, page.fields]))
      .toEqual(whole.map(id => [id, SLIDE_FIELDS]));
  });
});
