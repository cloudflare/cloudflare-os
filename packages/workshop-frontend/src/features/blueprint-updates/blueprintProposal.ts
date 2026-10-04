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
 * How many consecutive `changes` messages hold these proposals' change, counting the one that
 * records them (see BlueprintMerge.messageCount).
 */
export const proposalMessageCount = (merges: readonly BlueprintMerge[]): number =>
  Math.max(1, ...merges.map(merge => merge.messageCount ?? 1))

/**
 * What the notice of a proposal says, generated from its record alone. It describes the proposal
 * as it was made, in words that stay true as the chat goes on: whether a conflict it reports
 * has since been resolved is for the accept-time check to say (see mergeConflicts.ts).
 */
export type BlueprintProposalDescription = {
  /** The blueprint and the version of it proposed. */
  heading: string
  /** What accepting the proposal does to the gadget. */
  summary: string
  /** What the user is expected to do about it while it is still proposed. */
  nextStep: string
  /** The files the merge left conflicts in, if any. */
  conflicts?: string
  /** That the merge may have undone the user's own work unreported, if it may have. */
  warning?: string
  /** The bindings the version declares that the gadget had none named for. */
  missingBindings: { name: string; title: string; description: string }[]
  /** What to do about those bindings, where nobody is doing it already. */
  missingBindingsHint?: string
}

// How many conflicted files the notice names before it counts the rest.
const CONFLICT_PATH_LIMIT = 5

const describeConflicts = (paths: readonly string[]): string => {
  const named = paths.slice(0, CONFLICT_PATH_LIMIT).join(', ')
  const rest = paths.length - CONFLICT_PATH_LIMIT
  return (
    `The merge left conflicts in ${paths.length === 1 ? '1 file' : `${paths.length} files`}: ` +
    `${named}${rest > 0 ? ` and ${rest} more` : ''}. Each was marked in the code where the two ` +
    'sides disagree, to be resolved before accepting. A file that one side deleted and the ' +
    'other changed has no marks: it was left holding the changed version.'
  )
}

/**
 * Describes a proposal to merge a blueprint's release into a gadget. `changesFiles` is whether
 * the message that records it carries a change: a merge of two sides that made the same changes
 * has none.
 */
export const describeBlueprintProposal = (
  merge: BlueprintMerge,
  { changesFiles }: { changesFiles: boolean },
): BlueprintProposalDescription => {
  const summary = merge.kind === 'follow'
    ? 'None of this gadget’s files change: it already has everything in this version. ' +
      'Accepting has the gadget take its future updates from this blueprint.'
    : merge.kind === 'fastForward'
      ? 'This gadget has no changes of its own to keep, so its files become this version’s exactly.'
      : changesFiles
        ? 'This gadget and the blueprint have both changed, so the blueprint’s changes were ' +
          'merged with the gadget’s own.'
        : 'This gadget already has every change this version made, so none of its files change.'

  const missingBindings = Object.entries(merge.missingBindings ?? {})
    .map(([name, { title, description }]) => ({ name, title: title || name, description }))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  return {
    heading: `${titleOf(merge.title)}, version ${merge.version}`,
    summary,
    nextStep: changesFiles
      ? 'Nothing changes until you accept. Try this version in the preview first.'
      : 'Nothing changes until you accept.',
    ...(merge.conflictPaths.length > 0 ? { conflicts: describeConflicts(merge.conflictPaths) } : {}),
    // A guessed base can only have misled a merge that changed something.
    ...(merge.unverifiedBase && changesFiles ? {
      warning:
        'This gadget and the blueprint share no history, so the update was worked out against ' +
        'a guess at what the gadget was built from. A change of yours that the guess happens ' +
        'to include looks like something the blueprint removed, and was undone without a ' +
        'conflict being reported. Check the result before accepting.',
    } : {}),
    missingBindings,
    // A merge that changes files goes to the agent for review, which is asked to wire these.
    // No other proposal starts one.
    ...(missingBindings.length > 0 && !(merge.kind === 'merge' && changesFiles)
      ? { missingBindingsHint: 'Ask in this chat to have them set up.' }
      : {}),
  }
}
