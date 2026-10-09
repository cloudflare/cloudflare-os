// Records what a presentation session reads of a brand-new Google Slides presentation into
// `src/blank-presentation.json`, which `BlankPresentation` serves while a presentation awaits
// creation. Of the default theme's layouts it keeps only OFFERED_LAYOUTS, so the recording holds
// few pages that could fall out of step with Google's.
//
//   node scripts/record-blank-presentation.ts <token-file> [--check]
//
// The token file holds an OAuth access token with the `presentations` and `drive.file` scopes; it
// is never printed. Two presentations are created, read through the session's own field masks,
// and deleted. The two recordings must agree: that is what shows Google gives every new
// presentation the same object IDs, so changes queued against the recording apply unchanged to the
// presentation a user's approval creates. With `--check` the recording is compared with the
// committed file rather than written, exiting 1 if a new presentation no longer matches it.

import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  LAYOUT_PAGE_FIELDS, OUTLINE_FIELDS, SLIDE_FIELDS, SUMMARY_FIELDS,
} from "../src/slides-fields.ts";

const OUTPUT = new URL("../src/blank-presentation.json", import.meta.url);
const SLIDES_API = "https://slides.googleapis.com/v1/presentations";
const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";
// The layouts a presentation offers before it is created: the title slide's own, and the few
// a deck is mostly built from. Every other layout appears once the presentation exists.
const OFFERED_LAYOUTS = ["TITLE", "SECTION_HEADER", "TITLE_AND_BODY", "TITLE_ONLY", "BLANK"];

type Read = Record<string, unknown> & {
  presentationId?: string;
  title?: string;
  revisionId?: string;
  slides?: { objectId: string }[];
  layouts?: { objectId: string }[];
};

type Recording = {
  presentation: Read;
  outline: Read;
  slides: Record<string, Read>;
  layouts: Record<string, Read>;
};

let [tokenFile, ...flags] = process.argv.slice(2);
if (tokenFile === undefined || flags.some(flag => flag !== "--check")) {
  console.error("usage: node scripts/record-blank-presentation.ts <token-file> [--check]");
  process.exit(2);
}
let token = (await readFile(tokenFile, "utf8")).trim();

async function google(method: string, url: string, body?: unknown): Promise<Read> {
  let response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${new URL(url).pathname} failed [http=${response.status}]: ` +
      await response.text());
  }
  return response.status === 204 ? {} : await response.json() as Read;
}

/** A read with what names this one presentation removed: its ID, title and revision. */
function anonymous(read: Read): Read {
  let rest = { ...read };
  delete rest.presentationId;
  delete rest.title;
  delete rest.revisionId;
  return rest;
}

async function create(title: string): Promise<string> {
  let { presentationId } = await google("POST", `${SLIDES_API}?fields=presentationId`, { title });
  if (presentationId === undefined) throw new Error("Google Slides returned no presentation ID");
  return presentationId;
}

async function record(title: string): Promise<Recording> {
  let presentationId = await create(title);
  try {
    let read = (fields: string, page?: string) => google("GET",
      `${SLIDES_API}/${encodeURIComponent(presentationId)}` +
      `${page === undefined ? "" : `/pages/${encodeURIComponent(page)}`}` +
      `?fields=${encodeURIComponent(fields)}`);
    let pages = async (ids: string[], fields: string) =>
      Object.fromEntries(await Promise.all(ids.map(async id => [id, await read(fields, id)] as const)));
    // The offered layouts, picked by their PredefinedLayout name rather than by object ID, which the
    // recording exists to check. Their display names would not do either: Google translates them.
    let { layouts: named = [] } = await read("layouts(objectId,layoutProperties(name))") as
      { layouts?: { objectId: string; layoutProperties?: { name?: string } }[] };
    let offered = new Set(named.filter(layout => OFFERED_LAYOUTS.includes(layout.layoutProperties?.name ?? ""))
      .map(layout => layout.objectId));
    if (offered.size !== OFFERED_LAYOUTS.length) {
      throw new Error(`A new presentation lacks one of the layouts ${OFFERED_LAYOUTS.join(", ")}`);
    }
    let offeredOnly = (presentation: Read): Read => ({
      ...presentation, layouts: (presentation.layouts ?? []).filter(layout => offered.has(layout.objectId)),
    });
    let outline = offeredOnly(await read(OUTLINE_FIELDS));
    let recording: Recording = {
      presentation: anonymous(offeredOnly(await read(SUMMARY_FIELDS))),
      outline: anonymous(outline),
      slides: await pages((outline.slides ?? []).map(slide => slide.objectId), SLIDE_FIELDS),
      layouts: await pages([...offered], LAYOUT_PAGE_FIELDS),
    };
    let text = JSON.stringify(recording);
    if (text.includes(presentationId) || text.includes(title)) {
      throw new Error("A new presentation's reads name it outside its ID and title fields");
    }
    return recording;
  } finally {
    await google("DELETE", `${DRIVE_FILES_API}/${encodeURIComponent(presentationId)}`);
  }
}

let first = await record("Gadgets blank presentation recording 1 (safe to delete)");
let second = await record("Gadgets blank presentation recording 2 (safe to delete)");
if (!isDeepStrictEqual(first, second)) {
  console.error("Two new presentations read differently, so neither can stand in for the next.");
  process.exit(1);
}

if (flags.includes("--check")) {
  let committed = JSON.parse(await readFile(OUTPUT, "utf8")) as Recording;
  let stale = (Object.keys(first) as (keyof Recording)[])
    .filter(part => !isDeepStrictEqual(first[part], committed[part]));
  if (stale.length > 0) {
    console.error(`A new presentation no longer matches src/blank-presentation.json: ` +
      `${stale.join(", ")} differ. Re-run without --check to record it again.`);
    process.exit(1);
  }
  console.log("src/blank-presentation.json matches a new presentation.");
} else {
  await writeFile(OUTPUT, `${JSON.stringify(first, null, 2)}\n`);
  console.log(`Recorded a new presentation: ${Object.keys(first.slides).length} slide(s), ` +
    `${Object.keys(first.layouts).length} layout(s).`);
}
