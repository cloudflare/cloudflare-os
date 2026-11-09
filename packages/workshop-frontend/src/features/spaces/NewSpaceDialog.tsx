import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Dialog, Input } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { BusyButton } from './BusyButton'
import { SpaceDialogFrame } from './SpaceDialogFrame'
import type { Spaces } from './useSpaces'

// A creation that ended with no answer: the name it asked for, and the ids of the spaces the
// user's list had when it began.
type UnansweredCreation = { name: string; knownIds: ReadonlySet<string> }

/**
 * Creates a team space from a name. Anything the server refuses, such as a name that is too
 * long, is shown as it words it. A creation that got no answer may have made the space, so the
 * next one under the same name first looks for it among the user's spaces, and the list is read
 * again when the dialog closes after such a creation. Nothing is asked of a session that has not
 * said that the `spaces` flag is on.
 */
export const NewSpaceDialog = ({ spaces, onClose, onCreated }: {
  /**
   * The user's spaces (`useSpaces`), from the caller: what tells the space a creation with no
   * answer made from the ones that were there before, and how the list is read again.
   */
  spaces: Spaces
  onClose: () => void
  /**
   * The space with this id exists, with the user as its first admin. Closing the dialog is the
   * caller's. Never called once the dialog has been unmounted.
   */
  onCreated: (id: string) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const formId = useId()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const unanswered = useRef<UnansweredCreation | null>(null)
  // A creation got no answer, so a space may exist that the list on the page behind lacks,
  // whether or not there were ids to tell that space by.
  const mayHaveCreated = useRef(false)
  // A session that replaces another (a reconnect) reads as having the flag off until its own
  // flags arrive, and the dialog outlasts that. `Create` waits for them as it waits for its own
  // call, so that no space is made, or looked for, under a session that turns out to have the
  // flag off: the page takes the dialog away then.
  const sessionReady = useUiFeatureFlag('spaces').enabled

  // `creating` holds the dialog open against its own controls, not against a navigation, which
  // unmounts it with the page. Set by the effect and not only cleared by its cleanup: a
  // development build runs the cleanup once right after the mount, and the effect again.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const trimmedName = name.trim()

  // A creation that got no answer may have made the space all the same. The server makes another
  // on every call and names need not be unique, so the only trace of the first is a team space of
  // that name, with the user as its admin, that the list did not have before. A space whose
  // record in the user's list was lost with the answer is not found this way.
  const findSpaceMadeBy = async ({ name: asked, knownIds }: UnansweredCreation) =>
    (await authenticatedApi.listSpaces()).find(space =>
      space.kind === 'team' && space.role === 'admin' && space.name === asked && !knownIds.has(space.id))?.id

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (trimmedName === '' || creating || !sessionReady) return
    setCreating(true)
    setFailure(null)
    const sameName = unanswered.current?.name === trimmedName ? unanswered.current : null
    // With no list there is nothing to tell a space this attempt makes from one that was there.
    const knownIds = spaces.loading || spaces.failed ? null : new Set(spaces.spaces.map(space => space.id))
    let creationAsked = false
    try {
      let id = sameName ? await findSpaceMadeBy(sameName) : undefined
      if (id === undefined) {
        creationAsked = true
        // Not awaited: the read is pipelined on the creation, and disposing the promise disposes
        // the space it resolves to.
        const space = authenticatedApi.createSpace(trimmedName)
        try {
          id = (await space.getInfo()).id
        } finally {
          space[Symbol.dispose]()
        }
      }
      // The caller would go to the space from a page the user has left: the list is read again
      // instead, for wherever it is on show.
      if (alive.current) onCreated(id)
      else void spaces.refresh()
    } catch (err) {
      const noAnswer = logRpcFailure('Failed to create space:', err)
      if (creationAsked && noAnswer) {
        mayHaveCreated.current = true
        // An earlier attempt under this name keeps the ids it knew, so that a later one finds a
        // space either made.
        if (!sameName && knownIds) unanswered.current = { name: trimmedName, knownIds }
        if (!alive.current) void spaces.refresh()
      }
      if (alive.current) setFailure(rpcFailureDescription(err) ?? 'Couldn’t create the space. Try again.')
    } finally {
      if (alive.current) setCreating(false)
    }
  }

  // A creation that got no answer may have made a space, which the page behind then shows.
  const handleClose = () => {
    if (mayHaveCreated.current) void spaces.refresh()
    onClose()
  }

  return (
    <SpaceDialogFrame
      layout="form"
      title="New space"
      description="A space groups workspaces and has members, who can open the workspaces it lists. You will be its first admin."
      busy={creating}
      onClose={handleClose}
      footer={(
        <>
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} className="!h-9" disabled={creating}>Cancel</WorkshopButton>
            )}
          />
          <BusyButton
            type="submit"
            form={formId}
            tone="primary"
            className="min-w-[80px]"
            busy={creating || !sessionReady}
            disabled={trimmedName === ''}
          >
            {creating ? 'Creating…' : 'Create'}
          </BusyButton>
        </>
      )}
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <Input
          label="Name"
          placeholder="e.g. Platform team"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
        {failure && (
          <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>
        )}
      </form>
    </SpaceDialogFrame>
  )
}
