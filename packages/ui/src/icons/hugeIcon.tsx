import { createElement, useId, type ComponentProps, type ComponentType } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

/**
 * How an icon is drawn: in its line (`regular`), in a heavier one (`bold`, for a small mark such as
 * a caret or a close), solid (`fill`, for one that is on, such as a chosen star), or its line over a
 * faint fill of its shape (`duotone`).
 */
export type IconWeight = 'regular' | 'bold' | 'fill' | 'duotone'

/**
 * What an icon takes: an SVG's own props, and its size and weight. It is 1em, the size of the text
 * it is in, unless given a `size` or a class that sizes it (`size-4`), and takes its colour from the
 * text.
 */
export type IconProps = Omit<ComponentProps<'svg'>, 'children' | 'strokeWidth'> & { size?: number | string; weight?: IconWeight }

/** An icon, as `hugeIcon` makes them. */
export type Icon = ComponentType<IconProps>

/** `mirrored` draws the icon flipped left to right, such as a history arrow that goes clockwise. */
export type HugeIconOptions = { mirrored?: boolean }

// The free set is drawn in one line, 1.5 on its 24px grid; bold is half as heavy again.
const BOLD = 2.25
const MIRROR = 'matrix(-1 0 0 1 24 0)'

type Part = IconSvgElement[number]

const draw = ([tag, attrs]: Part, changes: Record<string, string | number | undefined> = {}) =>
  createElement(tag, { ...attrs, ...changes })

const isFilled = ([, attrs]: Part) => attrs.fill !== undefined && attrs.fill !== 'none'

const span = (values: number[]) => (values.length ? Math.max(...values) - Math.min(...values) : 0)

/** About how much room a closed part takes (its box), or 0 for an open line. */
const sizeOf = ([tag, attrs]: Part) => {
  const n = (key: string) => Number(attrs[key] ?? 0)
  if (tag === 'circle') return (2 * n('r')) ** 2
  if (tag === 'ellipse') return 4 * n('rx') * n('ry')
  if (tag === 'rect') return n('width') * n('height')
  const d = String(attrs.d ?? '')
  if (tag !== 'path' || !/z\s*$/i.test(d)) return 0
  // The free set's paths are absolute, so their numbers, taken in pairs, are about their points.
  const numbers = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
  return span(numbers.filter((_, i) => i % 2 === 0)) * span(numbers.filter((_, i) => i % 2 === 1))
}

/** The part an icon is the shape of (a circle, a shield, a bell): its biggest closed part, else its first. */
const outlineOf = (icon: IconSvgElement) =>
  icon.reduce((biggest, part) => (sizeOf(part) > sizeOf(biggest) ? part : biggest), icon[0])

/**
 * The free set has only lines, so a solid icon is drawn from them: its outline filled, with the
 * other parts cut out of it where they are inside it and drawn as lines where they are outside it,
 * as a solid icon has them.
 */
const Solid = ({ icon }: { icon: IconSvgElement }) => {
  const id = useId().replace(/[^\w-]/g, '')
  const outline = outlineOf(icon)
  const marks = icon.filter((part) => part !== outline)
  const region = { maskUnits: 'userSpaceOnUse', x: -2, y: -2, width: 28, height: 28 } as const
  return (
    <>
      <defs>
        <mask id={`${id}-cut`} {...region}>
          <rect x={-2} y={-2} width={28} height={28} fill="white" />
          {marks.map((part) => draw(part, { stroke: 'black', fill: isFilled(part) ? 'black' : 'none' }))}
        </mask>
        <mask id={`${id}-outside`} {...region}>
          <rect x={-2} y={-2} width={28} height={28} fill="white" />
          {draw(outline, { stroke: 'black', fill: 'black' })}
        </mask>
      </defs>
      {draw(outline, { fill: 'currentColor', mask: `url(#${id}-cut)` })}
      <g mask={`url(#${id}-outside)`}>{marks.map((part) => draw(part))}</g>
    </>
  )
}

/** Drawn by hand, for what `HugeiconsIcon` does not do: a fill, and being mirrored. */
const DrawnIcon = ({ icon, weight, mirrored, size, ...props }: Omit<IconProps, 'size'> & { icon: IconSvgElement; mirrored: boolean; size: number | string }) => {
  const line = weight === 'bold' ? { strokeWidth: BOLD } : {}
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" color="currentColor" {...props}>
      <g transform={mirrored ? MIRROR : undefined}>
        {weight === 'fill' ? <Solid icon={icon} /> : (
          <>
            {weight === 'duotone' && draw(outlineOf(icon), { key: 'tone', fill: 'currentColor', stroke: 'none', opacity: 0.2 })}
            {icon.map((part) => draw(part, line))}
          </>
        )}
      </g>
    </svg>
  )
}

/**
 * A component for one of the Hugeicons (the free set, `@hugeicons/core-free-icons`), the icons the
 * Gadgets frontends are drawn with: drawn as any component is, or handed to what takes an icon
 * component, such as `Button`'s `icon`. Each app makes one for each icon it uses, in one module of
 * its own (workshop-app's `components/icons.ts`, this package's `icons/icons.ts`).
 */
export const hugeIcon = (icon: IconSvgElement, { mirrored = false }: HugeIconOptions = {}): Icon => {
  const HugeIcon = ({ size = '1em', weight = 'regular', ...props }: IconProps) =>
    weight === 'fill' || weight === 'duotone' || mirrored
      ? <DrawnIcon icon={icon} weight={weight} mirrored={mirrored} size={size} {...props} />
      : <HugeiconsIcon icon={icon} size={size} strokeWidth={weight === 'bold' ? BOLD : undefined} {...props} />
  return HugeIcon
}
