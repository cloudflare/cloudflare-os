import { type ReactNode, useState } from 'react'
import { Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, LockSimpleIcon } from '@phosphor-icons/react'
import Avatar from '../../components/Avatar'

export type ResourceItem = {
  key: string | number
  title: string
  vendorName: string
  logoUrl?: string
  /** The backdrop the vendor's logo was drawn for. */
  logoBackground?: string
  url?: string
  /** Shown on the right in place of the vendor's name, e.g. the result of checking it. */
  trailing?: ReactNode
}

// Longer lists show this many and fold the rest behind one row, so ten resources never push a
// dialog's actions out of view.
const FOLDED = 4
const FOLD_ABOVE = 5

/**
 * The resources a gadget reads, one flat row each in the share dialog's row style: the vendor's
 * logo, the resource, and the vendor's name (or a status) on the right; the URL, when known, is the
 * row's tooltip. A list that shows results must never hide one, so instead of folding (`fold`) it
 * scrolls past a height.
 */
const ResourceList = ({ items, label, fold }: { items: ResourceItem[]; label: string; fold: boolean }) => {
  const [expanded, setExpanded] = useState(false)
  const folds = fold && items.length > FOLD_ABOVE
  const shown = folds && !expanded ? items.slice(0, FOLDED) : items

  return (
    <div>
      <ul
        aria-label={label}
        aria-live="polite"
        className={fold ? undefined : 'chat-panel max-h-[min(324px,40dvh)] overflow-y-auto overscroll-contain'}
      >
        {shown.map(item => {
          const title = (
            <span className="min-w-0 flex-1 truncate text-[13px] tracking-[-0.25px] text-kumo-default">
              {item.title}
            </span>
          )
          return (
            <li key={item.key} className="flex h-9 items-center gap-2.5">
              <Avatar
                src={item.logoUrl}
                background={item.logoBackground}
                size={18}
                className="rounded-[5px]!"
                fallback={<LockSimpleIcon size={11} className="text-kumo-subtle" />}
              />
              {item.url ? (
                <Tooltip asChild content={<span className="block max-w-xs break-all">{item.url}</span>}>
                  <span tabIndex={0} className="flex min-w-0 flex-1 rounded outline-offset-2">{title}</span>
                </Tooltip>
              ) : title}
              <span className="shrink-0 text-xs text-kumo-subtle">{item.trailing ?? item.vendorName}</span>
            </li>
          )
        })}
      </ul>
      {folds && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded text-xs font-medium text-kumo-subtle transition-colors hover:text-kumo-default"
        >
          <CaretDownIcon
            aria-hidden
            size={11}
            weight="bold"
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          {expanded ? 'Show fewer' : `Show ${items.length - FOLDED} more`}
        </button>
      )}
    </div>
  )
}

export default ResourceList
