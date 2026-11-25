import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '../LinkButton'
import { Tag } from '../Tag'

export type FilePreviewCardProps = {
  /** Where it is in what it belongs to: "templates/report.md". */
  path: string
  /** A line about it, across from its path: what it is, and how big. */
  detail?: string
  /** What it is to what it belongs to, where it is more than one of its files: "Instructions". */
  role?: string
  /** Where it opens, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
  /** More of it is shown before it is cut off: for the file the rest are there for. */
  tall?: boolean
  /** The start of what is in it, as it reads: rendered text, a picture. Nothing, for a file there is nothing to show of. */
  children?: ReactNode
}

/**
 * A file as a card that opens it: its path, over the start of what is in it, which fades out where
 * there is more than the card has room for. All of it opens the file, so what is in it is only
 * looked at: its links go nowhere from here.
 */
export const FilePreviewCard = ({ path, detail, role, href, onSelect, tall = false, children }: FilePreviewCardProps) => {
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // There is more of it than is shown.
  const [clipped, setClipped] = useState(false)
  const shows = children !== undefined && children !== null
  useEffect(() => {
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content) return
    const measure = () => setClipped(content.offsetHeight > body.clientHeight + 1)
    measure()
    // What is in it may grow after it is drawn, as a picture does once it has loaded.
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [shows])

  return (
    <li className="group relative flex flex-col rounded-3xl bg-kumo-tint">
      {/* Its path apart from what is in it, by a line that stops short of the card's sides, as between a surface's rows. */}
      <div className={cn('mx-5 flex items-center gap-3 py-3.5 text-base leading-snug', shows && 'border-b border-kumo-line')}>
        <LinkButton
          href={href}
          onClick={onSelect}
          // The whole card opens the file, which is drawn as pointed at where any of it is.
          className="min-w-0 truncate rounded-md text-left font-medium text-kumo-default outline-none after:absolute after:inset-0 after:rounded-3xl after:content-[''] hover:after:bg-kumo-contrast/5 focus-visible:after:ring-2 focus-visible:after:ring-kumo-focus"
        >
          {/* The folders it is in, quieter than its name. */}
          <span className="font-normal text-kumo-subtle">{path.slice(0, path.lastIndexOf('/') + 1)}</span>
          {path.slice(path.lastIndexOf('/') + 1)}
        </LinkButton>
        {/* Kumo rings a badge in a link that is pointed at; this one is beside it. */}
        {role && <Tag className="shrink-0">{role}</Tag>}
        {detail && <span className="ms-auto shrink-0 text-sm text-kumo-subtle">{detail}</span>}
      </div>
      {shows && (
        <div
          ref={bodyRef}
          // Looked at, not used: whatever is in it takes no click and no focus.
          inert
          className={cn('overflow-hidden px-5 pt-4 text-base text-kumo-default', tall ? 'max-h-96' : 'max-h-44', clipped && 'mask-[linear-gradient(to_bottom,black_calc(100%-4rem),transparent)]')}
        >
          <div ref={contentRef} className="pb-5">{children}</div>
        </div>
      )}
    </li>
  )
}
