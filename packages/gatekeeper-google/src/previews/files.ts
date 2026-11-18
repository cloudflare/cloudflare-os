import type { UiFile } from "@gadgets/workshop-shared/gatekeeper";
import type { DriveEditorName } from "../drive-editors";
import DOCS_CLIENT from "./docs/client.txt";
import DOCS_DRAW from "./docs/draw.txt";
import DOCS_PAGES from "./docs/pages.txt";
import DOCS_TEXT from "./docs/text.txt";
import CHROME from "./shared/chrome.txt";
import SHEETS_CLIENT from "./sheets/client.txt";
import SLIDES_CLIENT from "./slides/client.txt";
import SLIDES_SHAPES from "./slides/shapes.txt";
import SLIDES_SLIDE from "./slides/slide.txt";

const SHARED: UiFile[] = [{ path: "ui/chrome.js", code: CHROME }];

/** Each kind of file's preview: gadget-format client code, under the paths it is imported by. */
export const PREVIEW_FILES: Record<DriveEditorName, UiFile[]> = {
  docs: [
    { path: "client.js", code: DOCS_CLIENT },
    { path: "draw.js", code: DOCS_DRAW },
    { path: "pages.js", code: DOCS_PAGES },
    { path: "text.js", code: DOCS_TEXT },
    ...SHARED,
  ],
  sheets: [{ path: "client.js", code: SHEETS_CLIENT }, ...SHARED],
  slides: [
    { path: "client.js", code: SLIDES_CLIENT },
    { path: "slide.js", code: SLIDES_SLIDE },
    { path: "shapes.js", code: SLIDES_SHAPES },
    ...SHARED,
  ],
};
