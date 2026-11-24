import type { Icon } from './icons'

// The outline of the mascot's four lobes (`mascot/shapes.ts`' `cloudLobes`) as one line of four
// arcs, and its sparkle, on the icons' 24px grid, the cloud as far in from the box as they are.
// The sparkle is a little larger about its middle than the mascot's, to read at an icon's size.
const CLOUD = 'M9.38 5.63A5.87 5.87 0 0 1 19.52 9.15A5.87 5.87 0 0 1 13.79 19.11A5.87 5.87 0 0 1 4.5 15.1A5.45 5.45 0 0 1 9.38 5.63Z'
const SPARKLE = 'M15.51 9.88C15.33 9.58 14.98 9.43 14.64 9.49C14.3 9.55 14.03 9.82 13.96 10.16L13.62 11.99C13.59 12.13 13.51 12.25 13.39 12.32L11.8 13.29C11.5 13.47 11.35 13.81 11.41 14.16C11.47 14.5 11.74 14.77 12.08 14.83L13.9 15.18C14.04 15.21 14.17 15.29 14.24 15.41L15.21 17C15.39 17.3 15.73 17.45 16.08 17.39C16.42 17.33 16.69 17.06 16.75 16.72L17.1 14.89C17.13 14.75 17.21 14.63 17.33 14.56L18.92 13.59C19.22 13.41 19.37 13.06 19.31 12.72C19.25 12.38 18.98 12.11 18.64 12.05L16.81 11.7C16.67 11.67 16.55 11.59 16.48 11.47L15.51 9.88Z'

/**
 * An agent, as an icon among icons: the Workshop's cloud in the icons' own line, with its sparkle
 * solid in it, where `AgentMark`'s solid cloud would sit heavy beside them, as in a menu. Drawn as
 * `hugeIcon`'s are: 1em unless sized, in the text's colour, in its line or a `bold` one.
 */
export const AgentIcon: Icon = ({ size = '1em', weight = 'regular', ...props }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" color="currentColor" aria-hidden="true" {...props}>
    <path d={CLOUD} stroke="currentColor" strokeWidth={weight === 'bold' ? 2.25 : 1.5} strokeLinejoin="round" />
    <path d={SPARKLE} fill="currentColor" />
  </svg>
)
