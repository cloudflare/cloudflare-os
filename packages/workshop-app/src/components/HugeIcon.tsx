import type { ComponentType } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

/** What an icon made by `hugeIcon` takes: a class, for its size and colour. */
export type HugeIconProps = { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }

/**
 * A component for one of the Hugeicons (the free set, `@hugeicons/core-free-icons`), taking what the
 * app's icons take: a class, such as `size-4 text-kumo-subtle`, which sets its size, as the icon draws
 * to fit its box, and its colour, which it takes from the text. `strokeWidth` is its line, 1.5 unless
 * told otherwise (a small, bold mark such as a caret has more).
 */
export const hugeIcon = (icon: IconSvgElement, strokeWidth = 1.5): ComponentType<HugeIconProps> => {
  const Icon = (props: HugeIconProps) => <HugeiconsIcon icon={icon} strokeWidth={strokeWidth} {...props} />
  return Icon
}
