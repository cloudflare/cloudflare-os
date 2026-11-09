/**
 * The composer's text pickers (Figma "Frame 732", the "No workspace" control): an icon, a 13px label
 * and a chevron, all at half opacity, with no box until hovered. The model and workspace pickers
 * share it so the row reads as one set of controls.
 */
export const COMPOSER_CHIP_CLASS =
  "group inline-flex h-[26px] min-w-0 max-w-[180px] cursor-pointer items-center gap-1 rounded-full px-1.5 text-[13px] leading-4 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default";
