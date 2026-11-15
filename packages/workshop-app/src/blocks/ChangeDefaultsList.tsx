import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { Segmented } from '@/components/Segmented'
import { ServiceLogo } from '@/components/ServiceLogo'

/** One kind of change, and whether it may, and does, go ahead without asking. */
export type ChangeDefault = {
  kind: ActionKind
  /** It can be made automatic; one that cannot always asks. */
  autoApprovable: boolean
  automatic: boolean
  /** Workspaces that let it go ahead though the service asks first ("Always approve" on a request). */
  alsoIn?: string[]
}

/** The changes one kind of thing on the service makes: "Gmail", "Google Doc". */
export type ChangeDefaultsGroup = {
  key: string
  title: string
  iconUrl?: string
  changes: ChangeDefault[]
}

export type ChangeDefaultsListProps = {
  groups: ChangeDefaultsGroup[]
  /** The service's logo, for a group with no icon of its own. */
  logoUrl?: string
  onChange: (kind: ActionKind, automatic: boolean) => void
  /** Has the workspaces in `alsoIn` ask first too. */
  onAskEverywhere?: (kind: ActionKind) => void
  /** Still reading which are automatic: the choices wait. */
  loading?: boolean
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

const CHOICES = [{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Automatic' }]

/**
 * A kind's label as a row says it: what it is, then how far it reaches, which gatekeepers write
 * after ", in ": "Document edits" and "In any Doc this connection reaches".
 */
export const kindLabel = (label: string): { title: string; reach?: string } => {
  const at = label.indexOf(', in ')
  if (at === -1) return { title: label }
  const reach = label.slice(at + 2)
  return { title: label.slice(0, at), reach: reach.charAt(0).toUpperCase() + reach.slice(1) }
}

/**
 * Every kind of change a service makes, under each kind of thing on it, each with "Ask first" or
 * "Automatic" (`Segmented`); one that can never go ahead on its own says "Always requires approval" in place of
 * the choice, so nothing the service can do is left unsaid. A kind a workspace lets go ahead though the service asks
 * first says where, with the way to have it ask there too.
 */
export const ChangeDefaultsList = ({ groups, logoUrl, onChange, onAskEverywhere, loading }: ChangeDefaultsListProps) => (
  <div className="flex flex-col gap-2">
    {groups.map((group) => (
      <section key={group.key} aria-label={group.title} className="rounded-3xl bg-kumo-tint px-4">
        <h3 className="flex items-center gap-2.5 py-3 text-base/5 font-medium text-kumo-default">
          <ServiceLogo name={group.title} src={group.iconUrl ?? logoUrl} />
          {group.title}
        </h3>
        <ul className="[&>li]:border-t [&>li]:border-kumo-line">
          {group.changes.map(({ kind, autoApprovable, automatic, alsoIn }) => {
            const { title, reach } = kindLabel(kind.label)
            const id = `${group.key}-${kind.tag}`
            return (
              <li key={kind.tag} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                  <span className={autoApprovable ? 'text-base/5 text-kumo-default' : 'text-base/5 text-kumo-subtle'}>{title}</span>
                  {reach && <span id={`${id}-reach`} className="text-sm/5 text-kumo-subtle">{reach}</span>}
                  {alsoIn && (
                    <span className="appears flex flex-wrap items-baseline gap-x-2 text-sm/5 text-kumo-subtle">
                      Automatic in {LIST.format(alsoIn)}
                      {onAskEverywhere && (
                        <button
                          type="button"
                          className="rounded-sm font-medium text-kumo-default underline-offset-2 outline-none hover:underline focus-visible:underline"
                          onClick={() => onAskEverywhere(kind)}
                        >
                          {alsoIn.length === 1 ? 'Ask there too' : 'Ask in those too'}
                        </button>
                      )}
                    </span>
                  )}
                </span>
                {autoApprovable ? (
                  <Segmented
                    aria-label={title}
                    aria-describedby={reach ? `${id}-reach` : undefined}
                    value={automatic ? 'auto' : 'ask'}
                    options={CHOICES}
                    disabled={loading}
                    onValueChange={(value) => onChange(kind, value === 'auto')}
                  />
                ) : (
                  <span className="shrink-0 rounded-full bg-kumo-contrast/5 px-3 py-1 text-sm font-medium text-kumo-subtle">Always requires approval</span>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    ))}
  </div>
)
