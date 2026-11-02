import { cn } from "@cloudflare/kumo/utils";

/** A radio's state as drawn: chosen, choosable, or `none`, room for one so icons line up. */
export type RadioMark = "checked" | "unchecked" | "none";

/**
 * A radio's ring, and a dot inside it when chosen, in Kumo's contrast colour as its own Radio is:
 * near-black in light mode, white in dark. The dot is the radio's own fill showing through an inset
 * ring of the background, so it stays centred however the browser rounds the border (1.5px draws as
 * 1px at 1x); a 3px gap keeps its edges on whole pixels at 1x and 2x. Unchosen, the ring is Kumo's
 * interactive border and takes the subtle text colour while the nearest `group/choice` is hovered,
 * which shows against a hovered row in dark mode as Kumo's own hover colour does not.
 */
export const radioMark = (mark: RadioMark) => cn("size-4 shrink-0 rounded-full",
  mark !== "none" && "border-[1.5px]",
  mark === "checked" && "border-kumo-contrast bg-kumo-contrast inset-ring-3 inset-ring-kumo-base",
  mark === "unchecked" && "border-kumo-interact bg-kumo-base group-hover/choice:border-(color:--text-color-kumo-subtle)");
