import { Link } from '@tanstack/react-router'
import { Hexagon } from '@phosphor-icons/react'
import SiteLogo from './components/SiteLogo'

type Props = {
  workspaceTitle: string
  // Absent for the owner's own view.
  ownerName?: string
  // Whether the site logo, linking home, leads the title; a preview of the view omits it.
  withLogo: boolean
}

/** The top-bar title a "use" collaborator sees: the site logo, the workspace, and its owner. */
export const GadgetUseTitle = ({ workspaceTitle, ownerName, withLogo }: Props) => (
  <div className="flex items-center gap-2 min-w-0">
    {withLogo && (
      <>
        <Link to="/" aria-label="Home" className="flex-shrink-0 hover:opacity-80 transition-opacity">
          <SiteLogo size={22}>
            <Hexagon size={22} className="text-kumo-brand" weight="bold" />
          </SiteLogo>
        </Link>

        <span className="text-kumo-inactive flex-shrink-0">/</span>
      </>
    )}

    {/* Baseline-aligned, not centred: the two sizes of text would otherwise sit 1px apart. */}
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default truncate">
        {workspaceTitle}
      </span>

      {ownerName && (
        <span className="text-xs text-kumo-inactive flex-shrink-0">
          by {ownerName}
        </span>
      )}
    </span>
  </div>
)
