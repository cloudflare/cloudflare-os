import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_FIELDS, GoogleDocsApi } from "../src/docs-api";
import type { GoogleDocsDocument, GoogleDocsTab } from "../src/docs-api";
import { GoogleApiError } from "../src/google-response";
import { buildTab, item, presetLevels } from "./doc-fixture";
import {
  docsGetResponse, parseFieldMask, poisonOutsideMask, rawDocsDocument, selectFields,
} from "./docs-fields";
import { checkDocumentFields, failureText, isBearerToken, main } from "./docs-fields-check";

const TOKEN = "recognisable-token";
const DOCUMENT_ID = "recognisable-document-id";
const LIST_ID = "recognisable-list-id";
const OTHER_LIST_ID = "recognisable-other-list-id";
const USAGE = "usage: pnpm --filter @gadgets/google-gatekeeper check:docs-fields-mask " +
  "<token-file> <document-id>...";

/**
 * A tab of one bold paragraph and one item of a numbered list, with a bulleted list nothing is
 * in, named and placed as given.
 */
function tab(
  name: string, position: Partial<Pick<GoogleDocsTab, "parentTabId" | "index" | "nestingLevel">> = {},
): GoogleDocsTab {
  return {
    ...buildTab([
      { runs: [{ text: `Recognisable text of ${name}\n`, style: { bold: true } }] },
      item(`Recognisable item of ${name}`, LIST_ID),
    ], {
      [LIST_ID]: { listProperties: { nestingLevels: presetLevels(true) } },
      [OTHER_LIST_ID]: { listProperties: { nestingLevels: presetLevels() } },
    }),
    tabId: `recognisable-tab-${name}`, title: `Recognisable tab title ${name}`, ...position,
  };
}

/** A document of two top-level tabs, the first with a child. */
const DOCUMENT: GoogleDocsDocument = {
  documentId: DOCUMENT_ID,
  title: "Recognisable document title",
  revisionId: "recognisable-revision",
  tabs: [
    tab("a"),
    tab("a1", { parentTabId: "recognisable-tab-a", nestingLevel: 1 }),
    tab("b", { index: 1 }),
  ],
};

/** What nothing printed may hold: the token, the ids, the titles and the texts. */
const NEVER_PRINTED = ["recognisable", "Recognisable", "second-line"];

/** Google's whole answer for `document`, with fields throughout that the mask does not ask for. */
function wholeAnswer(document: GoogleDocsDocument): unknown {
  return poisonOutsideMask(rawDocsDocument(document), DOCUMENT_FIELDS);
}

/** `DOCUMENT` after `edit`, as Google's whole answer. */
function edited(edit: (document: GoogleDocsDocument) => void): unknown {
  let document = structuredClone(DOCUMENT);
  edit(document);
  return wholeAnswer(document);
}

const WHOLE = wholeAnswer(DOCUMENT);

/** Google's answer to a read whose field mask it does not take. */
const refusal = () => Response.json({
  error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
}, { status: 400 });

/**
 * An answer Google gives only to the second request for it and to those after: the first gets a
 * 503, which the transport sends again after a wait.
 */
function afterUnavailable(answer: unknown): () => unknown {
  let asked = false;
  return () => {
    if (asked) return answer;
    asked = true;
    return Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });
  };
}

const bytesOf = (answer: unknown) => new TextEncoder().encode(JSON.stringify(answer)).length;
const MASKED_BYTES = bytesOf(selectFields(WHOLE, parseFieldMask(DOCUMENT_FIELDS)));
const WHOLE_BYTES = bytesOf(WHOLE);
const SAVED = Math.round((1 - MASKED_BYTES / WHOLE_BYTES) * 100);
const SIZES = `masked 200, ${MASKED_BYTES} bytes; whole 200, ${WHOLE_BYTES} bytes; saved ${SAVED}%`;
const TAB_IDS = "tab IDs: 2 of 2 top-level, in order";

/** The read a request is: the full read with its mask, the full read without, or the tab IDs'. */
type Read = "masked" | "whole" | "tab IDs";

/**
 * Stubs `fetch` with a Google that holds `WHOLE` and applies field masks as Google does, but
 * for the reads `answers` names, each of which is answered from the document given for it or by
 * the response given; a function given for a read is called for each request, for the one or
 * the other.
 */
function stubGoogle(answers: Partial<Record<Read, unknown>> = {}) {
  let fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(input.toString());
    let headers = new Headers(init?.headers);
    let read: Read = headers.has("X-Goog-FieldMask") ? "masked"
      : url.searchParams.has("fields") ? "tab IDs" : "whole";
    let given = answers[read] ?? WHOLE;
    let answer: unknown = typeof given === "function" ? given() : given;
    return answer instanceof Response ? answer.clone() : docsGetResponse(url, headers, answer);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Silences what the client logs of a refused request. */
function silenceLogs(): void {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

let root = mkdtempSync(join(tmpdir(), "docs-fields-check-"));
let tokenFile = join(root, "token.txt");
writeFileSync(tokenFile, `${TOKEN}\n`);
/** Every line a test printed. */
let printed: string[] = [];

/** Runs the script with `argv`, giving its exit code and the lines it printed. */
async function run(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  let lines: string[] = [];
  let code = await main(argv, line => {
    lines.push(line);
    printed.push(line);
  });
  return { code, lines };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Whatever a test printed, it held neither the token, an id, a title nor any text.
  for (let line of printed.splice(0)) {
    for (let secret of NEVER_PRINTED) expect(line).not.toContain(secret);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the check of the field mask against Google", () => {
  it("reports the sizes of both answers and that the copies are equal", async () => {
    stubGoogle();

    let { code, lines } = await run(tokenFile, DOCUMENT_ID);

    expect(MASKED_BYTES).toBeLessThan(WHOLE_BYTES);
    expect(lines).toEqual([`document 1: ${SIZES}; 3 tabs; copies equal; ${TAB_IDS}`]);
    expect(code).toBe(0);
  });

  it("counts a document of one tab as one tab", async () => {
    let oneTab = wholeAnswer({ ...DOCUMENT, tabs: [tab("a")] });
    stubGoogle({ masked: oneTab, whole: oneTab, "tab IDs": oneTab });

    let { code, lines } = await run(tokenFile, DOCUMENT_ID);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/%; 1 tab; copies equal; tab IDs: 1 of 1 top-level, in order$/);
    expect(code).toBe(0);
  });

  it.each([
    ["a text run's style", (document: GoogleDocsDocument) => {
      document.tabs[0].body.content[1].paragraph!.elements[0].textRun!.textStyle!.bold = false;
    }, "tabs[0].tab.body.content[1].paragraph.elements[0].textRun.textStyle.bold"],
    ["a list's nesting level", (document: GoogleDocsDocument) => {
      document.tabs[1].lists[LIST_ID].listProperties!.nestingLevels![1].glyphType = "ROMAN";
    }, "tabs[1].tab.lists.*.listProperties.nestingLevels[1].glyphType"],
    ["the order of the lists", (document: GoogleDocsDocument) => {
      let [first] = document.tabs;
      first.lists = Object.fromEntries(Object.entries(first.lists).toReversed());
    }, "tabs[0].tab.lists"],
    ["a write marker", (document: GoogleDocsDocument) => {
      document.tabs[2].namedRanges = {
        "gadgets-write-recognisable-write": {
          namedRanges: [{ namedRangeId: "recognisable-range-id", name: "gadgets-write-recognisable-write" }],
        },
      };
    }, "tabs[2].writeMarkers[0]"],
    ["a tab's title", (document: GoogleDocsDocument) => {
      document.tabs[1].title = "Recognisable other tab title";
    }, "outline[1].title"],
  ])("names the first place the copies differ, without a key or a value: %s", async (
    _case, edit, path,
  ) => {
    let masked = edited(edit);
    stubGoogle({ masked });

    expect(await checkDocumentFields(TOKEN, DOCUMENT_ID)).toMatchObject({
      maskedStatus: 200, unmaskedStatus: 200, sameRevision: true, equal: false,
      firstDifference: path,
    });
    let { code, lines } = await run(tokenFile, DOCUMENT_ID);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`; 3 tabs; copies DIFFER, first at ${path}; ${TAB_IDS}`);
    expect(code).toBe(1);
  });

  it("reports a refused mask", async () => {
    silenceLogs();
    let fetch = stubGoogle({ masked: refusal() });

    let check = await checkDocumentFields(TOKEN, DOCUMENT_ID);
    expect(check).toMatchObject({ maskedStatus: 400, unmaskedStatus: 200, equal: false });
    expect(check).not.toHaveProperty("firstDifference");
    // The refused read, the client's own read without the mask, the whole read and the tab IDs.
    expect(fetch).toHaveBeenCalledTimes(4);
    let { code, lines } = await run(tokenFile, DOCUMENT_ID);

    expect(lines).toEqual([
      "document 1: the mask was refused (400); read whole; " +
        `whole 200, ${WHOLE_BYTES} bytes; 3 tabs; ${TAB_IDS}`,
    ]);
    expect(code).toBe(1);
  });

  it("says when the document changed between the two reads", async () => {
    stubGoogle({
      whole: edited(document => {
        document.revisionId = "recognisable-later-revision";
      }),
    });

    let { code, lines } = await run(tokenFile, DOCUMENT_ID);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `; 3 tabs; the document changed between the two reads: run again; ${TAB_IDS}`,
    );
    expect(lines[0]).not.toContain("copies");
    expect(code).toBe(1);
  });

  it("counts a document with no revision as changed", async () => {
    let unrevised = edited(document => {
      delete document.revisionId;
    });
    stubGoogle({ masked: unrevised, whole: unrevised });

    let { code, lines } = await run(tokenFile, DOCUMENT_ID);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `; 3 tabs; the document changed between the two reads: run again; ${TAB_IDS}`,
    );
    expect(code).toBe(1);
  });

  it("reports the last answer of a read Google first answers as unavailable", async () => {
    silenceLogs();
    vi.useFakeTimers();
    let fetch = stubGoogle({ masked: afterUnavailable(WHOLE), whole: afterUnavailable(WHOLE) });

    let running = run(tokenFile, DOCUMENT_ID);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await running).toEqual({
      code: 0, lines: [`document 1: ${SIZES}; 3 tabs; copies equal; ${TAB_IDS}`],
    });
    // Each full read twice, and the tab IDs.
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("refuses to compare two reads when the full read carries no field mask", async () => {
    let fetch = stubGoogle();
    // A client that asks for the same fields in the URL: both of its reads keep their mask.
    vi.spyOn(GoogleDocsApi.prototype, "getDocument").mockImplementation(async documentId => {
      let fields = encodeURIComponent(DOCUMENT_FIELDS);
      await globalThis.fetch(
        `https://docs.googleapis.com/v1/documents/${documentId}?includeTabsContent=true&fields=${fields}`,
      );
      return structuredClone(DOCUMENT);
    });

    let { code, lines } = await run(tokenFile, DOCUMENT_ID);

    expect(lines).toEqual(["document 1: Google Docs get document was sent without a field mask"]);
    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toBe(fetch);
  });

  it("reports how many tab IDs came and whether they are the top-level tabs'", async () => {
    let fetch = stubGoogle();
    let inOrder = await run(tokenFile, DOCUMENT_ID);
    expect(inOrder.lines[0]).toMatch(/; tab IDs: 2 of 2 top-level, in order$/);
    expect(inOrder.code).toBe(0);
    let url = new URL(String(fetch.mock.calls.at(-1)?.[0]));
    expect(url.searchParams.get("fields")).toBe("documentId,tabs(tabProperties(tabId))");

    silenceLogs();
    stubGoogle({ "tab IDs": refusal() });
    let refused = await run(tokenFile, DOCUMENT_ID);
    expect(refused.lines).toEqual([
      `document 1: ${SIZES}; 3 tabs; copies equal; tab IDs: Google Docs get tab IDs failed [http=400]`,
    ]);
    expect(refused.code).toBe(1);

    let [first, child, second] = DOCUMENT.tabs;
    stubGoogle({ "tab IDs": rawDocsDocument({ ...DOCUMENT, tabs: [second, first, child] }) });
    let reordered = await run(tokenFile, DOCUMENT_ID);
    expect(reordered.lines).toEqual([
      `document 1: ${SIZES}; 3 tabs; copies equal; tab IDs: 2, NOT the 2 top-level tabs in order`,
    ]);
    expect(reordered.code).toBe(1);

    stubGoogle({ "tab IDs": rawDocsDocument({ ...DOCUMENT, tabs: [first, child] }) });
    let tooFew = await run(tokenFile, DOCUMENT_ID);
    expect(tooFew.lines).toEqual([
      `document 1: ${SIZES}; 3 tabs; copies equal; tab IDs: 1, NOT the 2 top-level tabs in order`,
    ]);
    expect(tooFew.code).toBe(1);
  });

  it("reports a document that cannot be read and goes on to the next", async () => {
    silenceLogs();
    let fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      let url = new URL(input.toString());
      return url.pathname.endsWith(`/${DOCUMENT_ID}`)
        ? docsGetResponse(url, new Headers(init?.headers), WHOLE)
        : Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);

    let { code, lines } = await run(tokenFile, "recognisable-missing-id", DOCUMENT_ID);

    expect(lines).toEqual([
      "document 1: Google Docs get document failed [http=404]",
      `document 2: ${SIZES}; 3 tabs; copies equal; ${TAB_IDS}`,
    ]);
    expect(code).toBe(1);
    expect(globalThis.fetch).toBe(fetch);
  });

  it("prints neither the token, a document id, a tab id, a title nor any text", async () => {
    // The lines of every case of this file are held to that after it ran; these two more are of
    // a token that is no header value, and of an error whose message quotes one.
    let fetch = stubGoogle();
    let twoLines = join(root, "two-lines.txt");
    writeFileSync(twoLines, `${TOKEN}\nsecond-line\n`);
    let refused = await run(twoLines, DOCUMENT_ID);
    expect(refused).toEqual({
      code: 2, lines: [USAGE, "the token file must hold one line: an access token"],
    });
    expect(fetch).not.toHaveBeenCalled();

    // The transport sends a GET again, after a wait, when `fetch` throws.
    vi.useFakeTimers();
    let throwing = vi.fn(async () => {
      throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
    });
    vi.stubGlobal("fetch", throwing);
    let running = run(tokenFile, DOCUMENT_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await running).toEqual({ code: 1, lines: ["document 1: TypeError"] });
    expect(throwing).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch).toBe(throwing);
  });

  it("tells a failure by the client's message, and anything else by its class", () => {
    class QuotingError extends Error {}

    expect(failureText(new GoogleApiError("Google Docs get document failed [http=404]", "NOT_FOUND", [], false, 404)))
      .toBe("Google Docs get document failed [http=404]");
    expect(failureText(new Error("Google Docs returned an invalid tab")))
      .toBe("Google Docs returned an invalid tab");
    expect(failureText(new TypeError(`"Bearer ${TOKEN}" is an invalid header value.`)))
      .toBe("TypeError");
    expect(failureText(new Error(`fetch failed for /v1/documents/${DOCUMENT_ID}`))).toBe("Error");
    expect(failureText(new QuotingError(`Google Docs ${DOCUMENT_ID}`))).toBe("QuotingError");
    expect(failureText(`a thrown ${TOKEN}`)).toBe("an error");
  });

  it("takes one line of visible ASCII as a token", () => {
    expect(isBearerToken("ya29.a0Af_Byz-abc~123+/=")).toBe(true);
    expect(isBearerToken("first\nsecond")).toBe(false);
    expect(isBearerToken("first second")).toBe(false);
    expect(isBearerToken("first\tsecond")).toBe(false);
    expect(isBearerToken("tokén")).toBe(false);
    expect(isBearerToken("")).toBe(false);
  });

  it("sends the token only as the bearer of its requests, and restores fetch", async () => {
    let fetch = stubGoogle();

    expect((await run(tokenFile, DOCUMENT_ID)).code).toBe(0);

    expect(globalThis.fetch).toBe(fetch);
    let sent = fetch.mock.calls.map(([input, init]) => {
      let headers = new Headers(init?.headers);
      expect(input.toString()).not.toContain(TOKEN);
      expect(init?.body).toBeUndefined();
      expect([...headers].filter(([, value]) => value.includes(TOKEN)))
        .toEqual([["authorization", `Bearer ${TOKEN}`]]);
      return headers.get("X-Goog-FieldMask");
    });
    // The read with the mask, the same read with the mask taken off, and the tab IDs.
    expect(sent).toEqual([DOCUMENT_FIELDS, null, null]);
  });

  it("prints its usage and returns 2 without a token file or a document id", async () => {
    let fetch = stubGoogle();

    for (let argv of [[], [tokenFile], [join(root, "no-such-file.txt"), DOCUMENT_ID], [root, DOCUMENT_ID]]) {
      expect(await run(...argv)).toEqual({ code: 2, lines: [USAGE] });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
