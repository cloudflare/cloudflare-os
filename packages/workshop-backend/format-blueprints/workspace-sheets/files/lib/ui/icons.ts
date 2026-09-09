/**
 * The toolbar icons of the document-style gadgets, as the path markup {@link icon} wraps. Every
 * entry but `image` is drawn character for character by at least two of them; `image` is the
 * page's drawing. A gadget keeps its own table for the icons only it uses, typically spread over
 * this one: `const MY_ICONS = { ...ICONS, fill: '<path .../>' }`.
 */

/** Path markup by icon name; pass an entry to `icon()` or straight to `iconBtn()`. */
export const ICONS = {
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H9"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H15"/>',
  bold: '<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>',
  italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
  underline: '<path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
  textcolor: '<path d="M4 20h16"/><path d="M7 16l5-12 5 12"/><path d="M9 11h6"/>',
  alignLeft: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/>',
  alignCenter: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>',
  alignRight: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="6" y1="18" x2="20" y2="18"/>',
  ul: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/>',
  ol: '<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><path d="M4 10V5L2.7 6" stroke-width="1.5"/><path d="M3 14.5c.4-.6 2-.6 2 .5s-2 1.4-2 2.5h2.2" stroke-width="1.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.4"/><path d="M20 15l-4.5-4.5L7 19"/>',
  clear: '<path d="M4 7V5h12v2"/><path d="M9 5l-2 14"/><line x1="14" y1="13" x2="20" y2="19"/><line x1="20" y1="13" x2="14" y2="19"/>',
} as const satisfies Record<string, string>;

/** The names in {@link ICONS}. */
export type IconName = keyof typeof ICONS;
