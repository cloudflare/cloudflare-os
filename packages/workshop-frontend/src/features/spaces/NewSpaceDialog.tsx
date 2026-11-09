import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Dialog, Input } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, Space, SpaceInfo, SubspaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { BusyButton } from './BusyButton'
import { SpaceDialogFrame } from './SpaceDialogFrame'
import { spaceLabel } from './spaceKinds'
import type { Spaces } from './useSpaces'

/** The space a new space is created inside, and what the caller has read of it. */
export type NewSpaceParent = {
  /** The space the new one is created in. */
  space: Pick<SpaceInfo, 'id' | 'name' | 'kind'>
  /**
   * Its sub-spaces as the caller last read them, or null while it has not: what tells the
   * sub-space a creation with no answer made from the ones that were there.
   */
  subspaces: SubspaceInfo[] | null
  /** Reads its sub-spaces again, for the page behind the dialog. */
  onReload: () => Promise<void>
}

/** Where a new space is created: among the user's own team spaces, or inside a space. */
export type NewSpacePlace =
  | {
      /**
       * A team space of the user's own (`AuthenticatedApi.createSpace`), with the user as its
       * first admin. These are the user's spaces (`useSpaces`): what tells the space a creation
       * with no answer made from the ones that were there before, and how the list is read
       * again.
       */
      spaces: Spaces
      /** Never with `spaces`: a space is created in one place. */
      parent?: never
    }
  | {
      /**
       * A space inside this one (`Space.createSubspace`). The members of that space are then
       * its members, and the user is not made its first admin.
       */
      parent: NewSpaceParent
      /** Never with `parent`: a space is created in one place. */
      spaces?: never
    }

// A creation that ended with no answer: the name it asked for, and the ids of the spaces that
// were in the place it was made in when it began.
type UnansweredCreation = { name: string; knownIds: ReadonlySet<string> }

// What differs between the two places a space is created in. Built on every render from what
// the caller hands in then, so a creation and a close go by what the caller has read by then.
type Creation = {
  title: string
  description: string
  /**
   * The ids of the spaces in the place as the caller last read them, or null with nothing
   * read, when there is nothing to tell a space this attempt makes from one that was there.
   */
  knownIds: () => ReadonlySet<string> | null
  /** Creates the space under this name and resolves to its id. */
  create: (name: string) => Promise<string>
  /** The id of the space that a creation with no answer made, when it made one. */
  findMadeBy: (lost: UnansweredCreation) => Promise<string | undefined>
  /** Reads the spaces in the place again, for the page behind the dialog. */
  reload: () => Promise<void>
}

const amongOwnSpaces = (api: RpcStub<AuthenticatedApi>, spaces: Spaces): Creation => ({
  title: 'New space',
  description: 'A space groups workspaces and has members, who can open the workspaces it lists. You will be its first admin.',
  knownIds: () => (spaces.loading || spaces.failed ? null : new Set(spaces.spaces.map(space => space.id))),
  create: async (name) => {
    // Not awaited: the read is pipelined on the creation, and disposing the promise disposes
    // the space it resolves to.
    const space = api.createSpace(name)
    try {
      return (await space.getInfo()).id
    } finally {
      space[Symbol.dispose]()
    }
  },
  // The server makes another space on every call and names need not be unique, so the only
  // trace of a creation that got no answer is a team space of that name, with the user as its
  // admin, that the list did not have before. A space whose record in the user's list was lost
  // with the answer is not found this way.
  findMadeBy: async ({ name, knownIds }) =>
    (await api.listSpaces()).find(space =>
      space.kind === 'team' && space.role === 'admin' && space.name === name && !knownIds.has(space.id))?.id,
  reload: spaces.refresh,
})

const insideSpace = (api: RpcStub<AuthenticatedApi>, { space: parent, subspaces, onReload }: NewSpaceParent): Creation => {
  // The parent is opened for the one call and released once it has answered. Not awaited: the
  // call is pipelined on the open, and disposing the promise disposes the space it resolves to.
  const onParent = async <T,>(call: (space: RpcStub<Space>) => Promise<T>) => {
    const space = api.openSpace(parent.id)
    try {
      return await call(space)
    } finally {
      space[Symbol.dispose]()
    }
  }
  return {
    title: `New space in ${spaceLabel(parent)}`,
    description: parent.kind === 'team'
      ? `A space inside ${parent.name}. Everyone in ${parent.name} can open it, with at least the role they hold there, and it can have members of its own.`
      : 'A space inside your personal space, to group workspaces in. Only you are in it until you add members to it.',
    knownIds: () => subspaces && new Set(subspaces.map(subspace => subspace.id)),
    create: async name => (await onParent(space => space.createSubspace(name))).id,
    // As among the user's own spaces: the only trace of a creation that got no answer is a
    // sub-space of that name that the parent did not have before.
    findMadeBy: async ({ name, knownIds }) =>
      (await onParent(space => space.listSubspaces())).find(subspace =>
        subspace.name === name && !knownIds.has(subspace.id))?.id,
    reload: onReload,
  }
}

/**
 * Creates a space from a name: a team space of the user's own, or a space inside another, as
 * the caller says. Anything the server refuses, such as a name that is too long or a space
 * nested too deep, is shown as it words it. A creation that got no answer may have made the
 * space, so the next one under the same name first looks for it among the spaces of the place
 * it is created in, and those are read again when the dialog closes after such a creation.
 * Nothing is asked of a session that has not said that the `spaces` flag is on.
 */
export const NewSpaceDialog = (props: NewSpacePlace & {
  onClose: () => void
  /**
   * The space with this id exists. Closing the dialog is the caller's. Never called once the
   * dialog has been unmounted.
   */
  onCreated: (id: string) => void
}) => {
  const { onClose, onCreated } = props
  const { authenticatedApi } = useAuthenticatedApi()
  const creation = props.parent
    ? insideSpace(authenticatedApi, props.parent)
    : amongOwnSpaces(authenticatedApi, props.spaces)
  const formId = useId()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const unanswered = useRef<UnansweredCreation | null>(null)
  // A creation got no answer, so a space may exist that the page behind does not show, whether
  // or not there were ids to tell that space by.
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

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (trimmedName === '' || creating || !sessionReady) return
    setCreating(true)
    setFailure(null)
    const sameName = unanswered.current?.name === trimmedName ? unanswered.current : null
    const knownIds = creation.knownIds()
    let creationAsked = false
    try {
      // A creation that got no answer may have made the space all the same.
      let id = sameName ? await creation.findMadeBy(sameName) : undefined
      if (id === undefined) {
        creationAsked = true
        id = await creation.create(trimmedName)
      }
      // The caller would go to the space from a page the user has left: the spaces of the place
      // are read again instead, for wherever they are on show.
      if (alive.current) onCreated(id)
      else void creation.reload()
    } catch (err) {
      const noAnswer = logRpcFailure('Failed to create space:', err)
      if (creationAsked && noAnswer) {
        mayHaveCreated.current = true
        // An earlier attempt under this name keeps the ids it knew, so that a later one finds a
        // space either made.
        if (!sameName && knownIds) unanswered.current = { name: trimmedName, knownIds }
        if (!alive.current) void creation.reload()
      }
      if (alive.current) setFailure(rpcFailureDescription(err) ?? 'Couldn’t create the space. Try again.')
    } finally {
      if (alive.current) setCreating(false)
    }
  }

  // A creation that got no answer may have made a space, which the page behind then shows.
  const handleClose = () => {
    if (mayHaveCreated.current) void creation.reload()
    onClose()
  }

  return (
    <SpaceDialogFrame
      layout="form"
      title={creation.title}
      description={creation.description}
      busy={creating}
      onClose={handleClose}
      footer={(
        <>
          <Dialog.Close
            render={(closeProps) => (
              <WorkshopButton {...closeProps} className="!h-9" disabled={creating}>Cancel</WorkshopButton>
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
