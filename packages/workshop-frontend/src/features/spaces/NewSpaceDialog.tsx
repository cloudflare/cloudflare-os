import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Dialog, Input } from '@cloudflare/kumo'
import { isValidTeamSpaceKey } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { useFieldErrorAlert } from '../ai-models/useFieldErrorAlert'
import { SpaceDialogFrame } from './SpaceDialogFrame'
import { isKeyTakenError, isNotAMemberError } from './spaceErrors'
import { suggestSpaceKey, TEAM_SPACE_KEY_RULE } from './spaceKey'

const takenKeyError = (key: string) =>
  `A space with the key “${key}” already exists. Choose another key.`

/**
 * Creates a team space from a name and a key. The key follows the name until the user edits it,
 * and is held to the grammar the server applies (`isValidTeamSpaceKey`). A key that is already
 * taken is the server's to refuse, and is shown against the key, which takes focus so that the
 * refusal is heard; so is anything else it refuses, such as a name that is too long, shown as it
 * words it.
 */
export const NewSpaceDialog = ({ onClose, onCreated }: {
  onClose: () => void
  /** The space exists, with the user as its first admin. Closing the dialog is the caller's. */
  onCreated: (key: string) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [name, setName] = useState('')
  // Null until the user edits the key field; until then the key is derived from the name.
  const [editedKey, setEditedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // The key the server last refused as taken. Keys are never released, so it stays refused.
  const [takenKey, setTakenKey] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // The latest attempt that ended with no answer, which may have created the space all the same.
  const unanswered = useRef<{ key: string; name: string } | null>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const keyAlert = useFieldErrorAlert()

  const key = editedKey ?? suggestSpaceKey(name)
  const trimmedName = name.trim()
  // A suggested key is valid or empty, so only a key the user typed, or emptied, can break the
  // grammar.
  const keyError = editedKey !== null && !isValidTeamSpaceKey(editedKey)
    ? `Use ${TEAM_SPACE_KEY_RULE}.`
    : key !== '' && key === takenKey
      ? takenKeyError(key)
      : undefined
  const canCreate = trimmedName !== '' && key !== '' && keyError === undefined && !creating

  const handleKeyChange = ({ target: input }: ChangeEvent<HTMLInputElement>) => {
    const lowered = input.value.toLowerCase()
    // Lowered in the field itself, with the caret put back: a controlled value that differs from
    // what was typed is written back by React after the render, which sends the caret to the end.
    if (lowered !== input.value) {
      const { selectionStart, selectionEnd } = input
      input.value = lowered
      input.setSelectionRange(selectionStart, selectionEnd)
    }
    setEditedKey(lowered)
    keyAlert.clear()
  }

  // Creates the space, resolving to whether it now exists as the user's, and to false for a key
  // that is someone else's. A key refused as taken may be this dialog's own: an attempt that
  // ended with no answer may have created the space, and a key is never released, not even to
  // whoever claimed it. The space then has the user as its admin, under the name that attempt
  // gave it, and opening it to ask is also what puts it in the user's list. A name alone proves
  // nothing: anyone signed in may read the info of a space that lists a published workspace, with
  // no role in it.
  const createSpace = async (): Promise<boolean> => {
    try {
      const space = await authenticatedApi.createSpace(key, trimmedName)
      space[Symbol.dispose]()
      return true
    } catch (err) {
      if (!isKeyTakenError(err)) throw err
      const lost = unanswered.current
      if (lost?.key !== key) return false
      // Not awaited: the read is pipelined on the open, and disposing the promise disposes the
      // space it resolves to.
      const space = authenticatedApi.openSpace(key)
      try {
        const info = await space.getInfo()
        return info.role === 'admin' && info.name === lost.name
      } catch (openErr) {
        if (isNotAMemberError(openErr)) return false
        throw openErr
      } finally {
        space[Symbol.dispose]()
      }
    }
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canCreate) return
    setCreating(true)
    setFailure(null)
    keyAlert.clear()
    try {
      if (await createSpace()) {
        onCreated(key)
      } else {
        setTakenKey(key)
        keyAlert.pointAt(keyRef.current, takenKeyError(key))
      }
    } catch (err) {
      if (logRpcFailure('Failed to create space:', err)) unanswered.current = { key, name: trimmedName }
      setFailure(rpcFailureDescription(err) ?? 'Couldn’t create the space. Try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <SpaceDialogFrame
      layout="form"
      title="New space"
      description="A space groups workspaces and has members, who can open the workspaces it lists. You will be its first admin."
      busy={creating}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-4 px-5 py-4">
          <Input
            label="Name"
            placeholder="e.g. Platform team"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              keyAlert.clear()
            }}
            autoFocus
          />
          <Input
            ref={keyRef}
            label="Key"
            description={`Identifies the space and cannot be changed later. ${TEAM_SPACE_KEY_RULE}.`}
            placeholder="platform-team"
            value={key}
            onChange={handleKeyChange}
            error={keyError}
            aria-invalid={keyError !== undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {keyAlert.alert}
          {failure && (
            <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} className="!h-9" disabled={creating}>Cancel</WorkshopButton>
            )}
          />
          <WorkshopButton type="submit" tone="primary" className="min-w-[80px]" disabled={!canCreate}>
            {creating ? 'Creating…' : 'Create'}
          </WorkshopButton>
        </div>
      </form>
    </SpaceDialogFrame>
  )
}
