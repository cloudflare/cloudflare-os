import { Banner } from '@cloudflare/kumo'
import { Blueprint } from '@phosphor-icons/react'
import type { BlueprintMerge } from '@gadgets/workshop-shared/api'
import { describeBlueprintProposal } from './blueprintProposal'

type BlueprintProposalNoticeProps = {
  merge: BlueprintMerge
  /** Whether the proposal is still to be decided, or which way it was. */
  status: 'pending' | 'merged' | 'reverted'
  /** Whether the message that records the proposal carries a change to the gadget's files. */
  changesFiles: boolean
}

const BODY_TEXT = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'

/**
 * The transcript's account of a blueprint release that someone proposed merging into a gadget
 * (see GadgetClient.applyBlueprint()). Everything it says comes from the record of the
 * proposal, so it reads the same however the blueprint has moved since. Once the proposal is
 * decided, only a line saying which way remains.
 *
 * TODO: Name the gadget. The record gives only its id (`merge.gadgetId`) and the chat is not
 * told workpiece titles, so the notice says "this gadget", which a workspace of several
 * gadgets leaves the reader to work out.
 */
export const BlueprintProposalNotice = ({ merge, status, changesFiles }: BlueprintProposalNoticeProps) => {
  const description = describeBlueprintProposal(merge, { changesFiles })

  if (status !== 'pending') {
    return (
      <div className="py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        <span className="inline-flex items-center gap-3 px-1.5">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
            <Blueprint size={16} />
          </span>
          <span className="font-medium">
            Blueprint update: {description.heading} ·{' '}
            {status === 'merged' ? 'accepted' : 'discarded'}
          </span>
        </span>
      </div>
    )
  }

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
          <p className="m-0 text-[11px] font-medium uppercase leading-4 tracking-[0.06em] text-kumo-inactive">
            Blueprint update
          </p>
          <p className="m-0 text-[14px] font-medium leading-5 tracking-[-0.25px] text-kumo-default">
            {description.heading}
          </p>
          <p className={BODY_TEXT}>{description.summary}</p>
        </div>
      </div>

      {description.conflicts && (
        <Banner variant="alert" size="sm" title="Merge conflicts" description={description.conflicts} />
      )}
      {description.warning && (
        <Banner
          variant="alert"
          size="sm"
          title="Your own changes may have been undone"
          description={description.warning}
        />
      )}

      {description.missingBindings.length > 0 && (
        <div className="space-y-1">
          <p className={BODY_TEXT}>
            This version uses connections that the gadget did not have when it was proposed:
          </p>
          <ul className="m-0 list-disc space-y-0.5 pl-5">
            {description.missingBindings.map(binding => (
              <li key={binding.name} className={BODY_TEXT}>
                <span className="font-medium text-kumo-default">{binding.title}</span>{' '}
                (<span className="font-mono">{binding.name}</span> in the code)
                {binding.description && `: ${binding.description}`}
              </li>
            ))}
          </ul>
          {description.missingBindingsHint && (
            <p className={BODY_TEXT}>{description.missingBindingsHint}</p>
          )}
        </div>
      )}

      <p className={BODY_TEXT}>{description.nextStep}</p>
    </section>
  )
}
