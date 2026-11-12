import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";

/** What a Drive binding's label adds to an editor's own: the kind covers every such file it reaches. */
function onDrive(kind: ActionKind, noun: string): ActionKind {
  return { tag: kind.tag, label: `${kind.label}, in any ${noun} this connection reaches` };
}

/** The Slides kinds a user may let apply without asking, as a read and write Drive binding lists them. */
export const DRIVE_SLIDES_KINDS: ActionKind[] = [
  { tag: "editSlidesText", label: "Slide text edits" },
  { tag: "formatSlides", label: "Slide formatting and arrangement" },
  {
    tag: "edit-slides",
    label: "Slide edits that keep every element, table row and column and download no images",
  },
  { tag: "arrange-slides", label: "Adding, copying and reordering slides" },
  { tag: "skipSlides", label: "Skipping slides" },
].map(kind => onDrive(kind, "presentation"));
