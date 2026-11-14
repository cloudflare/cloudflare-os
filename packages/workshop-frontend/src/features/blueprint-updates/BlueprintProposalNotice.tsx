import { Badge, Banner, Collapsible } from '@cloudflare/kumo'
import { Blueprint } from '@phosphor-icons/react'
import type { BlueprintMerge } from '@gadgets/workshop-shared/api'
import { describeBlueprintProposal, type BlueprintProposalDetails } from './blueprintProposal'

type BlueprintProposalNoticeProps = {
  merge: BlueprintMerge
  /** Whether the proposal is still to be decided, or which way it was. */
  status: 'pending' | 'merged' | 'reverted'
  /** Whether an agent is taking part in the chat, and so reviewing a merge. */
  reviewed: boolean
}

const BODY_TEXT = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'

const AdvancedDetails = ({ details, bindingNames }: {
  details: BlueprintProposalDetails
  bindingNames: string[]
}) => (
  <Collapsible.Root>
    <Collapsible.DefaultTrigger>Advanced details</Collapsible.DefaultTrigger>
    <Collapsible.DefaultPanel>
      <div className="space-y-2">
        <dl className={`${BODY_TEXT} m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1`}>
          <dt>Method</dt>
          <dd className="m-0 text-kumo-default">{details.method}</dd>
          {details.baseCommit && (
            <>
              <dt>Common base</dt>
              <dd className="m-0 font-mono text-kumo-default">{details.baseCommit}</dd>
            </>
          )}
          <dt>Release</dt>
          <dd className="m-0 font-mono text-kumo-default">{details.releaseCommit}</dd>
          {details.conflictPaths.length > 0 && (
            <>
              <dt>Conflicts</dt>
              <dd className="m-0">
                <ul className="m-0 list-none space-y-0.5 p-0">
                  {details.conflictPaths.map(path => (
                    <li key={path} className="break-all font-mono text-kumo-default">{path}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {bindingNames.length > 0 && (
            <>
              <dt>New bindings</dt>
              <dd className="m-0 break-all font-mono text-kumo-default">{bindingNames.join(', ')}</dd>
            </>
          )}
        </dl>
        {details.notes.map(note => <p key={note} className={BODY_TEXT}>{note}</p>)}
      </div>
    </Collapsible.DefaultPanel>
  </Collapsible.Root>
)

/**
 * The transcript's account of a blueprint release that someone proposed merging into a gadget
 * (see GadgetClient.applyBlueprint()). Everything it says comes from the record of the
 * proposal, so it reads the same however the blueprint has moved since. Once the proposal is
 * decided the notice stays, as a record of what the update was, marked with which way it went
 * and without what was still to do.
 *
 * TODO: Name the gadget. The record gives only its id (`merge.gadgetId`) and the chat is not
 * told workpiece titles, so the notice says "this gadget", which a workspace of several
 * gadgets leaves the reader to work out.
 */
export const BlueprintProposalNotice = ({
  merge,
  status,
  reviewed,
}: BlueprintProposalNoticeProps) => {
  const description = describeBlueprintProposal(
    merge, { reviewed, decided: status !== 'pending' })

  return (
    <section
      aria-label={`Blueprint update: ${description.heading}`}
      className="space-y-2.5 rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-subtle" aria-hidden="true">
          <Blueprint size={18} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-[11px] font-medium uppercase leading-4 tracking-[0.06em] text-kumo-inactive">
              Blueprint update
            </p>
            {status !== 'pending' && (
              <Badge variant={status === 'merged' ? 'success' : 'secondary'}>
                {status === 'merged' ? 'Accepted' : 'Discarded'}
              </Badge>
            )}
          </div>
          <p className="m-0 text-[14px] font-medium leading-5 tracking-[-0.25px] text-kumo-default">
            {description.heading}
          </p>
          {description.summary && <p className={BODY_TEXT}>{description.summary}</p>}
        </div>
      </div>

      {description.customizations && (
        <Banner variant="alert" size="sm" description={description.customizations} />
      )}
      {description.warning && (
        <Banner variant="alert" size="sm" {...description.warning} />
      )}

      {description.missingBindings.length > 0 && (
        <div className="space-y-1">
          <p className={BODY_TEXT}>
            This version uses connections that the gadget did not have when it was proposed:
          </p>
          <ul className="m-0 list-disc space-y-0.5 pl-5">
            {description.missingBindings.map(binding => (
              <li key={binding.name} className={BODY_TEXT}>
                <span className="font-medium text-kumo-default">{binding.title}</span>
                {binding.description && `: ${binding.description}`}
              </li>
            ))}
          </ul>
          {description.missingBindingsHint && (
            <p className={BODY_TEXT}>{description.missingBindingsHint}</p>
          )}
        </div>
      )}

      {description.nextStep && <p className={BODY_TEXT}>{description.nextStep}</p>}

      <AdvancedDetails
        details={description.details}
        bindingNames={description.missingBindings.map(binding => binding.name)}
      />
    </section>
  )
}
