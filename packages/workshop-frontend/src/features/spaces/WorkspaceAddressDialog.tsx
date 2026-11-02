import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Dialog, Input } from '@cloudflare/kumo'
import { MAX_SLUG_LENGTH, slugify, type SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { useFieldErrorAlert } from '../ai-models/useFieldErrorAlert'
import { SpaceDialogFrame } from './SpaceDialogFrame'
import { isSlugInUseError } from './spaceErrors'
import { workspaceAddressPath } from './workspaceAddress'

const SLUG_RULE =
  `Lowercase letters and digits, in groups joined by single dashes, ${MAX_SLUG_LENGTH} characters at most.`

const TOO_LONG = `An address is ${MAX_SLUG_LENGTH} characters at most.`

const inUseError = (slug: string) =>
  `Another workspace of this space is at “${slug}”. Choose another address.`

/**
 * What the field holds for what was typed: `slugify()`'s own steps, less its fallback for a
 * title that leaves nothing and its cut to `MAX_SLUG_LENGTH`, and with a dash kept at the end,
 * where the next character joins it. Nothing typed is dropped for its length: an address that
 * is too long is refused against the field, with all of it there to edit.
 */
const slugAsTyped = (typed: string): string =>
  typed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')

// Holds the field to slug form and returns what it then holds. Written to the field itself, with
// the caret kept after what was typed before it: a controlled value that differs from what was
// typed is written back by React after the render, which sends the caret to the end.
const holdToSlugForm = (input: HTMLInputElement): string => {
  const typed = slugAsTyped(input.value)
  if (typed !== input.value) {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length)
    const caret = Math.min(slugAsTyped(before).length, typed.length)
    input.value = typed
    input.setSelectionRange(caret, caret)
  }
  return typed
}

/**
 * Changes the address a workspace has within a space: the slug of its entry in the space's
 * listing (`Space.setWorkspaceSlug`). The field keeps what is typed in slug form, says so when
 * that is too long, and what is submitted is held to the check the server applies. A slug
 * another workspace of the space uses is the server's to refuse. Either refusal is shown against
 * the field, which takes focus so that it is heard. Links to the address the workspace had keep
 * leading to it, so nothing else has to change when it does.
 */
export const WorkspaceAddressDialog = ({ spaceKey, workspace, onClose, onChanged }: {
  spaceKey: string
  /** The workspace's entry in the space's listing, as last read. */
  workspace: SpaceWorkspaceInfo
  onClose: () => void
  /** The entry now has this address. Closing the dialog is the caller's. */
  onChanged: (workspace: SpaceWorkspaceInfo) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [slug, setSlug] = useState(workspace.slug ?? '')
  const [saving, setSaving] = useState(false)
  // Why the slug in the field was refused. Dropped on an edit, also for a slug that was in use:
  // the workspace that has it may give it up.
  const [refusal, setRefusal] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const slugRef = useRef<HTMLInputElement>(null)
  const slugAlert = useFieldErrorAlert()

  const title = workspace.title || 'Untitled Workspace'
  const fieldError = refusal ?? (slug.length > MAX_SLUG_LENGTH ? TOO_LONG : null)
  const changed = slug !== '' && slug !== workspace.slug
  const canSave = changed && fieldError === null && !saving

  const edit = (edited: string) => {
    setSlug(edited)
    setRefusal(null)
    slugAlert.clear()
  }

  // What an input method is composing stays as typed, since writing to the field would end the
  // composition. The field is held to slug form when the composition ends.
  const handleSlugChange = ({ target: input, nativeEvent }: ChangeEvent<HTMLInputElement>) =>
    edit((nativeEvent as InputEvent).isComposing ? input.value : holdToSlugForm(input))

  const refuse = (error: string) => {
    setRefusal(error)
    slugAlert.pointAt(slugRef.current, error)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSave) return
    setFailure(null)
    slugAlert.clear()
    // The field leaves one thing for this check to find: the dash it keeps at the end.
    if (slugify(slug) !== slug) {
      refuse('An address ends with a letter or a digit.')
      return
    }
    setSaving(true)
    // Not awaited: the change is pipelined on the open, and disposing the promise disposes the
    // space it resolves to.
    const space = authenticatedApi.openSpace(spaceKey)
    try {
      onChanged(await space.setWorkspaceSlug(workspace.id, slug))
    } catch (err) {
      if (isSlugInUseError(err)) {
        refuse(inUseError(slug))
      } else {
        logRpcFailure('Failed to change a workspace’s address:', err)
        setFailure(rpcFailureDescription(err) ?? 'Couldn’t change the address. Try again.')
      }
    } finally {
      space[Symbol.dispose]()
      setSaving(false)
    }
  }

  return (
    <SpaceDialogFrame
      layout="form"
      title="Change address"
      description={
        `Where “${title}” is found in this space. `
        + 'Links to an address it had before keep leading to it.'
      }
      busy={saving}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="break-all text-[13px] leading-[18px] text-kumo-default">
            {workspace.slug === undefined
              ? 'It has no address in this space yet.'
              : `Current address: ${workspaceAddressPath({ spaceKey, slug: workspace.slug })}`}
          </p>
          <Input
            ref={slugRef}
            label="Address"
            description={
              changed && slugify(slug) === slug
                ? `It will be at ${workspaceAddressPath({ spaceKey, slug })}`
                : SLUG_RULE
            }
            placeholder="e.g. roadmap"
            value={slug}
            onChange={handleSlugChange}
            onCompositionEnd={({ currentTarget: input }) => edit(holdToSlugForm(input))}
            error={fieldError ?? undefined}
            aria-invalid={fieldError !== null}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
          {slugAlert.alert}
          {failure && (
            <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} className="!h-9" disabled={saving}>Cancel</WorkshopButton>
            )}
          />
          <WorkshopButton type="submit" tone="primary" className="min-w-[80px]" disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </WorkshopButton>
        </div>
      </form>
    </SpaceDialogFrame>
  )
}
