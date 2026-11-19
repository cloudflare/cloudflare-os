// What a switch looks like, apart from what it does, for the control (`Switch`) and for what only shows
// the state (`SwitchIndicator`), so that the two are the same shape and colour.

/** The track: fully round, on in Kumo's own switch's blue, which is its `info`, as the brand here is orange. */
export const SWITCH_TRACK = [
  'relative inline-flex h-5 w-8.5 shrink-0 items-center rounded-full p-0.5',
  'bg-kumo-contrast/12 data-checked:bg-kumo-info',
  'transition-colors duration-150 ease-out motion-reduce:transition-none',
].join(' ')

/** The thumb: the light theme's surface in either, so it is white on the track whatever it is on. */
export const SWITCH_THUMB = [
  'block size-4 rounded-full bg-kumo-base scheme-light shadow-[0_1px_2px_rgb(0_0_0/0.15)]',
  'transition-transform duration-150 ease-out data-checked:translate-x-3.5 motion-reduce:transition-none',
].join(' ')
