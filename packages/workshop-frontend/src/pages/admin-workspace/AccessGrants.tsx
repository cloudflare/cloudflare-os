import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@cloudflare/kumo'
import { MAX_ADMIN_GRANTS_LISTED, type AdminAccessGrant } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { EndGrantDialog } from './EndGrantDialog'

const SOURCE_NAMES: Record<AdminAccessGrant['source'], string> = {
  owner: 'Owner',
  admins: 'Second admin',
}

const Detail = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
    <dt className="text-xs text-kumo-subtle">{term}</dt>
    <dd className="min-w-0 text-sm text-kumo-default break-words">{children}</dd>
  </div>
)

/**
 * The live grants a workspace stores, in the order the workspace lists them: those a second admin
 * approved first. Each shows its id whole, as text an admin can select: an audit record names the
 * grant a content read ran under by that id alone. A grant a second admin approved can be ended
 * here; an owner's is the owner's to end.
 */
export const AccessGrants = ({ grants, onEnd }: {
  grants: AdminAccessGrant[]
  /** Ends a grant for the reason given, and settles once `grants` is what that left. */
  onEnd: (grant: AdminAccessGrant, reason: string) => Promise<void>
}) => {
  // The grant the dialog asks about, null while it is closed.
  const [ending, setEnding] = useState<AdminAccessGrant | null>(null)
  // The grant the dialog last asked about, which says once it has closed whether that grant went.
  const asked = useRef<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  return (
    <section className="space-y-3">
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold text-kumo-strong focus:outline-none">
        Access grants
      </h2>
      {grants.length === 0 ? (
        <p className="text-sm text-kumo-subtle">This workspace stores no live grant.</p>
      ) : (
        <ul className="space-y-3">
          {grants.map((grant) => (
            <li key={grant.id} className="bg-kumo-elevated border border-kumo-line rounded-xl px-5 py-4">
              <dl className="space-y-2">
                <Detail term="Grant"><span className="font-mono text-xs break-all">{grant.id}</span></Detail>
                <Detail term="Source">{SOURCE_NAMES[grant.source]}</Detail>
                <Detail term="Given by">
                  {grant.grantedBy.name}
                  <span className="block font-mono text-xs text-kumo-subtle break-all">{grant.grantedBy.id}</span>
                </Detail>
                {grant.requestedBy !== undefined && <Detail term="Asked for by">{grant.requestedBy}</Detail>}
                {grant.reason !== undefined && (
                  <Detail term="Reason"><span className="whitespace-pre-wrap">{grant.reason}</span></Detail>
                )}
                <Detail term="Until">
                  <time dateTime={grant.expiresAt.toISOString()}>{formatFullTimestamp(grant.expiresAt)}</time>
                </Detail>
              </dl>
              {grant.source === 'admins' && (
                <Button
                  variant="secondary-destructive"
                  size="sm"
                  className="mt-3"
                  aria-label={`End access under grant ${grant.id}`}
                  onClick={() => {
                    asked.current = grant.id
                    setEnding(grant)
                  }}
                >
                  End access
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {grants.length === MAX_ADMIN_GRANTS_LISTED && (
        <p className="text-sm text-kumo-subtle">
          Showing {MAX_ADMIN_GRANTS_LISTED} live grants. Every grant a second admin approved is
          listed; the workspace’s owner may have given more than the newest shown here.
        </p>
      )}
      <p className="text-sm text-kumo-subtle">
        The owner’s grant for all of their workspaces is not listed here: a workspace asks for it
        only when a call needs content. An owner’s grant is not in the audit log either. This list
        is where admins see it.
      </p>

      <EndGrantDialog
        grant={ending}
        onEnd={onEnd}
        onClose={() => setEnding(null)}
        // A dialog gives focus back to the button that opened it. That button goes with a grant
        // that was ended, so the list's heading takes focus then, before the dialog lets go of it.
        onClosed={() => {
          if (!grants.some((grant) => grant.id === asked.current)) heading.current?.focus()
        }}
      />
    </section>
  )
}
