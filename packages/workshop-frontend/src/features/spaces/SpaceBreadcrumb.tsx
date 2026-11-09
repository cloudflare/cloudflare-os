import { Link } from '@tanstack/react-router'
import { CaretRight } from '@phosphor-icons/react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { spaceLabel } from './spaceKinds'

/**
 * The way up from the page of a space that is inside another: a link to each space it is
 * inside, outermost first. It keeps the height of one line while there is none to show, so
 * that the heading under it, which may hold the focus, does not move when the links arrive.
 *
 * Kumo's `Breadcrumbs` is not used: its links are plain anchors unless the whole app adopts
 * Kumo's link provider, so following one would load the app again where a router link
 * navigates.
 */
export const SpaceBreadcrumb = ({ ancestors }: {
  /** The spaces the page's space is inside, outermost first (`useSpaceAncestors`). */
  ancestors: SpaceInfo[]
}) => (
  <div className="min-h-[18px]">
    {ancestors.length > 0 && (
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {ancestors.map(ancestor => (
            <li key={ancestor.id} className="flex min-w-0 items-center gap-1">
              <Link
                to="/spaces/$spaceId"
                params={{ spaceId: ancestor.id }}
                className="max-w-48 truncate hover:text-kumo-default"
              >
                {spaceLabel(ancestor)}
              </Link>
              <CaretRight aria-hidden size={10} className="shrink-0 text-kumo-inactive" />
            </li>
          ))}
        </ol>
      </nav>
    )}
  </div>
)
