import type { CSSProperties, ReactNode } from 'react'
import './GadgetSketch.css'

export type GadgetSketchProps = {
  /** The gadget's name. */
  title: string
}

const turn = (at: number) => ({ '--at': at }) as CSSProperties

// A piece of the screen: its outline, drawn in, and what it washes in with once that is closed.
const Piece = ({ at, wash = true, children }: { at: number; wash?: boolean; children: (className: string) => ReactNode }) => (
  <g style={turn(at)}>
    {wash && children('gadget-sketch-wash')}
    {children('gadget-sketch-line')}
  </g>
)

/**
 * A gadget being built that has no screen yet, in its place: a screen sketched in by hand, line by
 * line in the order a layout is blocked out (its frame, a header's mark and title, a large figure,
 * a line of text, two controls), each piece washed in once its outline closes; then rubbed out in
 * that order, and drawn again, until the gadget's own screen takes its place. It is drawn on a
 * sheet laid on dotted paper that fades out at its edges. Still, with every line drawn, for whoever asks for less motion.
 */
export const GadgetSketch = ({ title }: GadgetSketchProps) => (
  <div role="status" className="appears relative flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center text-kumo-default">
    <div aria-hidden="true" className="gadget-sketch-paper pointer-events-none absolute inset-0" />
    <svg aria-hidden="true" viewBox="0 0 176 128" className="relative w-52 overflow-visible">
      {/* The sheet it is drawn on, laid over the paper, so its dots stop at the screen's edge. */}
      <rect x={8} y={8} width={160} height={112} rx={14} style={{ fill: 'var(--color-kumo-tint)' }} />
      <Piece at={0} wash={false}>{(className) => <rect className={className} pathLength={1} x={8} y={8} width={160} height={112} rx={14} />}</Piece>
      <Piece at={0.14}>{(className) => <circle className={className} pathLength={1} cx={27} cy={27} r={6} />}</Piece>
      <Piece at={0.22} wash={false}>{(className) => <path className={className} pathLength={1} d="M40 27h44" />}</Piece>
      <Piece at={0.36}>{(className) => <rect className={className} pathLength={1} x={21} y={42} width={134} height={34} rx={8} />}</Piece>
      <Piece at={0.54} wash={false}>{(className) => <path className={className} pathLength={1} d="M21 88h86" />}</Piece>
      <Piece at={0.68}>{(className) => <rect className={className} pathLength={1} x={21} y={98} width={63} height={11} rx={5.5} />}</Piece>
      <Piece at={0.78}>{(className) => <rect className={className} pathLength={1} x={92} y={98} width={63} height={11} rx={5.5} />}</Piece>
    </svg>
    <div className="relative flex max-w-72 flex-col gap-1">
      <p className="text-base font-medium">Building {title}</p>
      <p className="text-sm text-pretty text-kumo-subtle">It appears here the moment it has a screen.</p>
    </div>
  </div>
)
