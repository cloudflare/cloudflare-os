import type { UiFile } from "@gadgets/workshop-shared/gatekeeper";
import CHROME from "./shared/chrome.txt";

/** The files every preview of this gatekeeper imports, under the paths it imports them by. */
export const SHARED_PREVIEW_FILES: UiFile[] = [{ path: "ui/chrome.js", code: CHROME }];
