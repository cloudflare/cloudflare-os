import type { MouseEventHandler, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { WorkspaceAddress } from './workspaceAddress'

/**
 * A link that opens a workspace: at its address within a space when the caller knows one, and at
 * /workspace/<id> otherwise. Both lead to the same editor, which opens the workspace under the
 * same authorization either way.
 */
export const WorkspaceLink = ({ id, address, describedBy, className, onClick, children }: {
  id: string
  /** The workspace's address in a space that lists it, when its entry there has a slug. */
  address: WorkspaceAddress | undefined
  /** The id of an element outside the link that describes it, such as the space it is in. */
  describedBy?: string
  className: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
  children: ReactNode
}) => (address
  ? (
      <Link
        to="/spaces/$spaceKey/$slug"
        params={address}
        aria-describedby={describedBy}
        className={className}
        onClick={onClick}
      >
        {children}
      </Link>
    )
  : (
      <Link to="/workspace/$id" params={{ id }} aria-describedby={describedBy} className={className} onClick={onClick}>
        {children}
      </Link>
    ))
