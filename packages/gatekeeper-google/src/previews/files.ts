import type { UiFile } from "@gadgets/workshop-shared/gatekeeper";
import type { DriveEditorName } from "../drive-editors";
import DOCS_CLIENT from "./docs/client.txt";
import DOCS_DRAW from "./docs/draw.txt";
import DOCS_MERGE from "./docs/merge.txt";
import DOCS_PAGES from "./docs/pages.txt";
import DRIVE_CLIENT from "./drive/client.txt";
import CHROME from "./shared/chrome.txt";
import SHEETS_CLIENT from "./sheets/client.txt";
import SHEETS_WINDOW from "./sheets/window.txt";
import SLIDES_CLIENT from "./slides/client.txt";
import SLIDES_SHAPES from "./slides/shapes.txt";
import SLIDES_SLIDE from "./slides/slide.txt";

const SHARED: UiFile[] = [{ path: "ui/chrome.js", code: CHROME }];

/** Each kind of file's preview: gadget-format client code, under the paths it is imported by. */
export const PREVIEW_FILES: Record<DriveEditorName, UiFile[]> = {
  docs: [
    { path: "client.js", code: DOCS_CLIENT },
    { path: "draw.js", code: DOCS_DRAW },
    { path: "merge.js", code: DOCS_MERGE },
    { path: "pages.js", code: DOCS_PAGES },
    ...SHARED,
  ],
  sheets: [{ path: "client.js", code: SHEETS_CLIENT }, { path: "window.js", code: SHEETS_WINDOW }, ...SHARED],
  slides: [
    { path: "client.js", code: SLIDES_CLIENT },
    { path: "slide.js", code: SLIDES_SLIDE },
    { path: "shapes.js", code: SLIDES_SHAPES },
    ...SHARED,
  ],
};

/**
 * A Drive connection's preview, of whichever file its session is of: an entry that starts that
 * file's kind of preview, and the three beside it, each client under its kind's name. The modules
 * they import keep their paths, which no two kinds share.
 */
export const DRIVE_PREVIEW_FILES: UiFile[] = [
  { path: "client.js", code: DRIVE_CLIENT },
  ...Object.entries(PREVIEW_FILES).flatMap(([editor, files]) => files
    .filter(file => !SHARED.includes(file))
    .map(file => file.path === "client.js" ? { ...file, path: `${editor}.js` } : file)),
  ...SHARED,
];
