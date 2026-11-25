/// <reference types="node" />

// Checks, against Google itself, the field mask a full read of a Google Doc sends
// (`DOCUMENT_FIELDS`): that `documents.get` takes it, that the copy pruned from the masked
// answer is the copy pruned from the whole one, and that the read of a document's tab IDs gives
// the top-level tabs' IDs. `scripts/check-docs-fields-mask.ts` runs it against Google; the tests
// run it against the fake of `docs-fields.ts`.
//
// The lines it prints are safe to paste anywhere: sizes, statuses and paths of field names. The
// token, a document's id, a tab's id, a title and a document's text never reach `print`. The
// client it reads through writes its own log lines beside them, and one for a mask Google refuses
// carries an error's stack, which names paths of the checkout: paste the lines printed, not the
// whole terminal.

import { existsSync, readFileSync } from "node:fs";
import { GoogleDocsApi } from "../src/docs-api";
import type { GoogleDocsDocument } from "../src/docs-api";
import { fetchedDoc, pruneTab } from "../src/docs-replica";
import { heldDoc, type HeldDoc } from "../src/docs-store";
import { GoogleApiError } from "../src/google-response";

/** What one document's check found; sizes are bytes of compact JSON. */
export type FieldsCheck = {
  /** Google's HTTP status for the read with the mask and for the read without it. */
  maskedStatus: number;
  unmaskedStatus: number;
  maskedBytes: number;
  unmaskedBytes: number;
  /**
   * The tabs the whole answer holds, how many of them are top-level, and whether the revision
   * was the same for both reads.
   */
  tabs: number;
  topLevelTabs: number;
  sameRevision: boolean;
  /** Whether the copies pruned from the two answers are the same bytes. */
  equal: boolean;
  /**
   * What `getTopLevelTabIds` gave: how many IDs, and whether they are the IDs of the whole
   * read's top-level tabs in their order; or what its failure may be told by (`failureText`).
   */
  tabIds: { count: number; match: boolean } | { error: string };
  /**
   * Where the two copies first differ, as a path of field names and list positions with every
   * map key and every value left out (`tabs[2].tab.body.content[14].paragraph.elements[0].textRun`).
   */
  firstDifference?: string;
};

/** The header `getDocument` sends its field mask in. */
const FIELD_MASK_HEADER = "X-Goog-FieldMask";

/** The fields of a tab that are maps keyed by an id, whose keys a path writes as `*`. */
const ID_KEYED_FIELDS: ReadonlySet<string> = new Set(["lists", "namedRanges"]);

/** One request a read made, as the wrapped `fetch` saw it. */
type SeenRequest = { status: number; bytes: number; masked: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first place `masked` and `whole` differ, depth first in key order, as a path of field names
 * and list positions, or `undefined` where they are the same JSON. `keyedById` says `masked` and
 * `whole` are maps keyed by an id, whose keys are written `*`.
 */
function firstDifference(
  masked: unknown, whole: unknown, path: string, keyedById = false,
): string | undefined {
  if (Array.isArray(masked) && Array.isArray(whole)) {
    for (let index = 0; index < Math.max(masked.length, whole.length); index++) {
      let at = `${path}[${index}]`;
      if (index >= masked.length || index >= whole.length) return at;
      let found = firstDifference(masked[index], whole[index], at);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(masked) && isRecord(whole)) {
    let keys = Object.keys(masked);
    let wholeKeys = Object.keys(whole);
    for (let key of new Set([...keys, ...wholeKeys])) {
      let name = keyedById ? "*" : key;
      let at = path === "" ? name : `${path}.${name}`;
      if (!(key in masked) || !(key in whole)) return at;
      let found = firstDifference(masked[key], whole[key], at, ID_KEYED_FIELDS.has(key));
      if (found !== undefined) return found;
    }
    // The same fields in another order are other bytes.
    return keys.every((key, index) => key === wholeKeys[index]) ? undefined : path;
  }
  return masked === whole ? undefined : path;
}

/** A document as the copy keeps it: each tab pruned, and the document as a read holds it. */
type KeptAnswer = { readonly content: unknown; readonly held: HeldDoc };

/**
 * What the copy keeps of `document`: each tab pruned with the write markers the walk of a
 * fetched document reads, as the plain value `firstDifference` walks, and the document held,
 * whose id names what is stored of its tabs. `document` is left as it is: the walk reads a copy.
 */
function keptAnswer(document: GoogleDocsDocument): KeptAnswer {
  // Held under no revision: whether the two answers are of one revision is reported apart.
  let held = heldDoc("", fetchedDoc({ ...structuredClone(document), revisionId: undefined }, 0));
  return {
    content: {
      outline: held.tabs.map(tab => tab.identity),
      tabs: document.tabs.map((tab, at) =>
        ({ tab: pruneTab(tab), writeMarkers: held.tabs[at].writeMarkers })),
    },
    held,
  };
}

/**
 * Whether two answers are stored as the same text: the JSON of what the copy keeps of each,
 * which has the same fields in the same order and the same values, and the same stored copy.
 */
function sameStoredCopy(masked: KeptAnswer, whole: KeptAnswer): boolean {
  return JSON.stringify(masked.content) === JSON.stringify(whole.content) &&
    masked.held.id === whole.held.id;
}

/**
 * Reads `documentId` as `token` with `DOCUMENT_FIELDS` and without, compares the copies, and
 * reads its top-level tab IDs: three reads, or four when Google refuses the mask.
 */
export async function checkDocumentFields(token: string, documentId: string): Promise<FieldsCheck> {
  // The token goes into the client's `Authorization` header and nowhere else.
  let docs = new GoogleDocsApi(async () => token);
  let seen: SeenRequest[] = [];
  let unmask = false;
  let send = globalThis.fetch;
  // Both reads are the production client's, so the masked one is the request production makes
  // and both answers are normalised by production code. The client hands its headers to `fetch`
  // in `init`; the read without the mask is the same request with that one header taken off.
  globalThis.fetch = async (input, init) => {
    let headers = new Headers(init?.headers);
    if (unmask) headers.delete(FIELD_MASK_HEADER);
    let masked = headers.has(FIELD_MASK_HEADER);
    let response = await send(input, { ...init, headers });
    let { byteLength } = await response.clone().arrayBuffer();
    seen.push({ status: response.status, bytes: byteLength, masked });
    return response;
  };
  let masked: GoogleDocsDocument;
  let whole: GoogleDocsDocument;
  let maskedRead: SeenRequest | undefined;
  let wholeRead: SeenRequest | undefined;
  try {
    masked = await docs.getDocument(documentId);
    // The client sends a refused request once and any other until it is answered, so the last
    // request that carried the mask is the one whose answer says what Google did with it.
    maskedRead = seen.findLast(request => request.masked);
    seen = [];
    unmask = true;
    whole = await docs.getDocument(documentId);
    wholeRead = seen.at(-1);
  } finally {
    globalThis.fetch = send;
  }
  if (!maskedRead || !wholeRead) {
    // A check that compared two whole answers would call any mask equal.
    throw new Error("Google Docs get document was sent without a field mask");
  }

  let topLevel = whole.tabs.filter(tab => tab.parentTabId === undefined).map(tab => tab.tabId);
  let tabIds: FieldsCheck["tabIds"];
  try {
    let ids = await docs.getTopLevelTabIds(documentId);
    tabIds = {
      count: ids.length,
      match: ids.length === topLevel.length && ids.every((id, index) => id === topLevel[index]),
    };
  } catch (caught) {
    tabIds = { error: failureText(caught) };
  }

  let check: FieldsCheck = {
    maskedStatus: maskedRead.status,
    unmaskedStatus: wholeRead.status,
    maskedBytes: maskedRead.bytes,
    unmaskedBytes: wholeRead.bytes,
    tabs: whole.tabs.length,
    topLevelTabs: topLevel.length,
    sameRevision: masked.revisionId !== undefined && masked.revisionId === whole.revisionId,
    equal: false,
    tabIds,
  };
  // A refused mask was answered by the client's own unmasked read: two whole answers, which say
  // nothing of the mask.
  if (maskedRead.status === 400) return check;
  let maskedCopy = keptAnswer(masked);
  let wholeCopy = keptAnswer(whole);
  check.equal = sameStoredCopy(maskedCopy, wholeCopy);
  if (!check.equal) {
    let difference = firstDifference(maskedCopy.content, wholeCopy.content, "");
    if (difference !== undefined) check.firstDifference = difference;
  }
  return check;
}

/**
 * Whether `token` may be sent as a bearer token: one line of visible ASCII, with no space. A
 * value a header refuses makes `fetch` throw an error whose message quotes the whole header,
 * so such a token is refused before any request is made.
 */
export function isBearerToken(token: string): boolean {
  return /^[\x21-\x7e]+$/.test(token);
}

/**
 * What may be printed of a failure: the message of a `GoogleApiError` (the operation and the
 * HTTP status) and of the Docs client's own errors, which are fixed texts that begin with
 * `Google Docs `; of anything else only the name of its class, since the message of an error
 * the runtime throws can quote the request, its `Authorization` header included.
 */
export function failureText(caught: unknown): string {
  if (!(caught instanceof Error)) return "an error";
  let ownText = caught instanceof GoogleApiError ||
    (caught.constructor === Error && caught.message.startsWith("Google Docs "));
  return ownText ? caught.message : caught.constructor.name;
}

const USAGE = "usage: pnpm --filter @gadgets/google-gatekeeper check:docs-fields-mask " +
  "<token-file> <document-id>...";

/** The text of the token file, trimmed, or `undefined` where there is no such file to read. */
function readToken(tokenFile: string | undefined): string | undefined {
  try {
    return tokenFile !== undefined && existsSync(tokenFile)
      ? readFileSync(tokenFile, "utf8").trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a document's check found nothing wrong. */
function passed(check: FieldsCheck): boolean {
  return check.maskedStatus !== 400 && check.sameRevision && check.equal &&
    "match" in check.tabIds && check.tabIds.match;
}

/** What `main` prints of one document's check, after the document's number. */
function checkLine(check: FieldsCheck): string {
  let { maskedStatus, maskedBytes, unmaskedStatus, unmaskedBytes, tabIds, topLevelTabs } = check;
  let whole = `whole ${unmaskedStatus}, ${unmaskedBytes} bytes`;
  let parts = maskedStatus === 400
    ? [`the mask was refused (${maskedStatus})`, "read whole", whole]
    : [
      `masked ${maskedStatus}, ${maskedBytes} bytes`, whole,
      `saved ${Math.round((1 - maskedBytes / unmaskedBytes) * 100)}%`,
    ];
  parts.push(check.tabs === 1 ? "1 tab" : `${check.tabs} tabs`);
  if (maskedStatus !== 400) {
    if (!check.sameRevision) parts.push("the document changed between the two reads: run again");
    else if (check.equal) parts.push("copies equal");
    else {
      let { firstDifference: at } = check;
      parts.push(at === undefined ? "copies DIFFER" : `copies DIFFER, first at ${at}`);
    }
  }
  if ("error" in tabIds) parts.push(`tab IDs: ${tabIds.error}`);
  else if (tabIds.match) parts.push(`tab IDs: ${tabIds.count} of ${topLevelTabs} top-level, in order`);
  else parts.push(`tab IDs: ${tabIds.count}, NOT the ${topLevelTabs} top-level tabs in order`);
  return parts.join("; ");
}

/**
 * The script: `<token-file> <document-id>...`. Prints one line for each document, numbered in the
 * order given, with the statuses, the sizes, the saving, whether the copies are equal and
 * where they first differ, and what the read of the tab IDs gave; never the token, a document
 * id, a tab id, a title or any text of a document, and of a failure only `failureText`.
 * Returns the exit code: 0 when every document's copies are equal and its tab IDs match, 1
 * otherwise, 2 for bad usage, which a token that is not `isBearerToken` is: nothing is
 * requested with it.
 */
export async function main(
  argv: readonly string[], print: (line: string) => void = line => console.log(line),
): Promise<number> {
  let [tokenFile, ...documentIds] = argv;
  let token = readToken(tokenFile);
  if (token === undefined || !isBearerToken(token) || documentIds.length === 0) {
    print(USAGE);
    if (token !== undefined && !isBearerToken(token)) {
      print("the token file must hold one line: an access token");
    }
    return 2;
  }
  let failed = false;
  for (let [index, documentId] of documentIds.entries()) {
    let line: string;
    // Nothing a caught value holds is printed but through `failureText`, and nothing is thrown
    // from here: whoever awaits `main` would print an error whole.
    try {
      let check = await checkDocumentFields(token, documentId);
      line = checkLine(check);
      if (!passed(check)) failed = true;
    } catch (caught) {
      line = failureText(caught);
      failed = true;
    }
    print(`document ${index + 1}: ${line}`);
  }
  return failed ? 1 : 0;
}
