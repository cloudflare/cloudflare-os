import type { AiChatMessage, BlueprintMerge } from '@gadgets/workshop-shared/api'
import { titleOf } from './blueprintChoices'

/**
 * The blueprint proposals this message records that a person applied (see
 * GadgetClient.applyBlueprint()), which the transcript shows as a notice. The agent's
 * `createGadget` records an entry too, on a message of its own: that one is part of a gadget's
 * creation, which the transcript already shows as a card.
 */
export const appliedBlueprintMerges = (message: AiChatMessage): BlueprintMerge[] =>
  message.type === 'changes' && message.author.type === 'user' ? message.blueprintMerges ?? [] : []

/**
 * What the notice of a proposal says, generated from its record alone. It describes the proposal
 * as it was made, in words that stay true as the chat goes on: whether a conflict it reports
 * has since been resolved is for the accept-time check to say (see mergeConflicts.ts).
 *
 * The notice is read by people who are not developers, so everything above `details` avoids
 * version-control terms. `details` is the technical account, shown only on request.
 */
export type BlueprintProposalDescription = {
  /** The blueprint and the version of it proposed. */
  heading: string
  /** What accepting the proposal does to the gadget, unless `customizations` says it. */
  summary?: string
  /**
   * For a proposal that combines the update with the gadget's own changes: that it does, and
   * who makes sure the two are compatible. Shown as a warning, since it is the case that needs
   * the user's attention.
   */
  customizations?: string
  /** That the update may have undone the user's own work unreported, if it may have. */
  warning?: { title: string; description: string }
  /** What the user is expected to do about it, while it is still proposed. */
  nextStep?: string
  /** The connections the version needs that the gadget had none set up for. */
  missingBindings: { name: string; title: string; description: string }[]
  /** What to do about those connections, where nobody is doing it already and it is not too late. */
  missingBindingsHint?: string
  details: BlueprintProposalDetails
}

/** The technical account of a proposal, for the notice's "Advanced details". */
export type BlueprintProposalDetails = {
  /** How the files were combined. */
  method: string
  /** Short ids of the commits involved. */
  baseCommit?: string
  releaseCommit: string
  /** The files the merge left conflicts in, all of them. */
  conflictPaths: readonly string[]
  /** Explanations of what the facts above imply. */
  notes: string[]
}

const shortCommit = (commitId: string) => commitId.slice(0, 7)

const METHODS: Record<BlueprintMerge['kind'], string> = {
  follow: 'Follow only: the release is recorded, no file changes',
  fastForward: 'Fast-forward: the files are replaced by the release’s',
  merge: 'Three-way merge',
}

const CONFLICTS_NOTE =
  'Each file with conflicts holds conflict markers where the two sides disagree, to be ' +
  'resolved before accepting. A file that one side deleted and the other changed has no ' +
  'markers: it holds the changed version.'

const UNVERIFIED_BASE_NOTE =
  'The gadget and the blueprint share no history, so the merge base is a guess at what the ' +
  'gadget was built from. A change of the gadget’s that the guess happens to include looks ' +
  'like something the blueprint removed, and is undone without a conflict being reported.'

/**
 * Describes a proposal to merge a blueprint's release into a gadget. Its `kind` says what it does
 * to the gadget's files: a "follow" changes none, and a "merge" always has something to review,
 * a changed file or a conflict (see BlueprintMerge.kind). `reviewed` is whether an agent is
 * taking part in the chat, which for a merge means it was asked to review the result (see
 * GadgetClient.applyBlueprint()). `decided` is whether the proposal has been accepted or
 * discarded, after which the notice stays as a record and says nothing about what is still to do.
 */
export const describeBlueprintProposal = (
  merge: BlueprintMerge,
  { reviewed, decided }: { reviewed: boolean; decided: boolean },
): BlueprintProposalDescription => {
  const combined = merge.kind === 'merge'
  const changesFiles = merge.kind !== 'follow'
  const conflicted = merge.conflictPaths.length > 0

  const summary = merge.kind === 'follow'
    ? 'This gadget already has everything in this version, so nothing in it changes. ' +
      'Accepting means it gets its future updates from this blueprint.'
    : 'This gadget hasn’t been changed since it was last updated, so it simply becomes this version.'

  const missingBindings = Object.entries(merge.missingBindings ?? {})
    .map(([name, { title, description }]) => ({ name, title: title || name, description }))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  const notes = [
    ...(conflicted ? [CONFLICTS_NOTE] : []),
    ...(merge.unverifiedBase ? [UNVERIFIED_BASE_NOTE] : []),
  ]

  return {
    heading: `${titleOf(merge.title)}, version ${merge.version}`,
    ...(combined ? {
      customizations:
        'You’ve customized this gadget beyond what was in the original blueprint. ' + (
          reviewed
            ? decided
              ? 'An agent was asked to make sure your customizations are compatible with the new version.'
              : 'An agent is now making sure your customizations are compatible with the new version.'
            : conflicted
              ? 'Some of your customizations clash with the new version, and no agent is ' +
                'checking them.' + (decided ? '' : ' Ask in this chat to have them sorted out before accepting.')
              : 'No agent is checking that your customizations are compatible with the new version.'
        ),
    } : { summary }),
    // A guessed base can only have misled a merge that changed something.
    ...(merge.unverifiedBase && changesFiles ? {
      warning: {
        title: 'Some of your changes may have been undone',
        description:
          'This gadget’s history doesn’t connect to the blueprint’s, so the update may have ' +
          'quietly undone changes made to this gadget.' +
          (decided ? '' : ' Check the result carefully before accepting.'),
      },
    } : {}),
    ...(decided ? {} : {
      nextStep: changesFiles
        ? 'Nothing changes until you accept. Try this version in the preview first.'
        : 'Nothing changes until you accept.',
    }),
    missingBindings,
    // The agent that reviews a merge is asked to set these up. No other proposal starts one.
    ...(missingBindings.length > 0 && !(combined && reviewed) && !decided
      ? { missingBindingsHint: 'Ask in this chat to have them set up.' }
      : {}),
    details: {
      method: METHODS[merge.kind],
      ...(merge.baseCommit === undefined ? {} : { baseCommit: shortCommit(merge.baseCommit) }),
      releaseCommit: shortCommit(merge.commitId),
      conflictPaths: merge.conflictPaths,
      notes,
    },
  }
}
