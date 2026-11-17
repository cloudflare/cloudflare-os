import type { ReactNode } from 'react'

export type Fact = {
  /** What it is a fact of: "Version". */
  label: string
  /** The fact, in a word, a number or an icon. */
  value: ReactNode
  /** What the value is of, or the rest of it, in a few words: "times", a name. */
  detail?: string
}

/**
 * What there is to know of something at a glance, on one surface: a fact each, side by side, its
 * value large between what it is of and the rest of it, with a line between one and the next
 * that stops short of the surface's edges. On a surface too narrow for them they are scrolled
 * along it.
 */
export const FactStrip = ({ facts }: { facts: Fact[] }) => (
  <dl className="flex overflow-x-auto rounded-3xl bg-kumo-tint py-4 [scrollbar-width:none]">
    {facts.map(({ label, value, detail }) => (
      <div key={label} className="flex min-w-28 flex-1 flex-col items-center gap-1 border-kumo-line px-2 text-center not-first:border-s">
        <dt className="text-sm whitespace-nowrap text-kumo-subtle">{label}</dt>
        {/* Icons as tall as the figures, and as heavy, so that a line of both reads as one. */}
        <dd className="flex h-8 items-center text-xl font-semibold whitespace-nowrap text-kumo-default tabular-nums [&>svg]:size-6">{value}</dd>
        {/* One line, so that the facts stay level; all of it when pointed at. */}
        {detail && <dd title={detail} className="max-w-full truncate text-sm text-kumo-subtle">{detail}</dd>}
      </div>
    ))}
  </dl>
)
