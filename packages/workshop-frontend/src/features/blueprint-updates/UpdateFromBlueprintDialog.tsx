import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Banner, Dialog, Loader, Radio } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintLibrarySummary,
  BlueprintPublicInfo,
  BlueprintUserSummary,
  GadgetClient,
  GadgetUpstream,
  Overseer,
  PublicApi,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../../components/WorkshopControls'
import { getStoredSelectedModel } from '../../modelSelection'
import { logRpcFailure } from '../../rpcErrors'
import {
  groupBlueprintChoices,
  type BlueprintChoice,
  type BlueprintChoiceSource,
} from './blueprintChoices'
import { parseBlueprintLink } from './blueprintLink'
import { hasNewerRelease } from './useBlueprintUpdateAvailable'

type UpdateFromBlueprintDialogProps = {
  /** The gadget to update. `upstream` is the blueprint it follows, which the picker starts on. */
  gadget: { title: string; upstream?: GadgetUpstream; client: RpcStub<GadgetClient> }
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  publicApi: RpcStub<PublicApi>
  onClose: () => void
  /** Called with the new chat that holds the proposal, once there is one. */
  onProposed: (chatId: number) => void
}

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
    status: 'loaded'
    /** The model a new chat would start with, which reviews a merge. Null for no agent. */
    reviewer: AiChatAuthorInfo | null
    followed: BlueprintPublicInfo | null
    own: BlueprintUserSummary[]
    library: BlueprintLibrarySummary[]
    featured: BlueprintPublicInfo[]
  }

type LinkLookup =
  | { status: 'empty' | 'notALink' | 'loading' | 'notFound' | 'failed' }
  | { status: 'found'; blueprint: BlueprintPublicInfo }

/** How the last attempt to apply a blueprint ended, unless it ended in a proposal. */
type Outcome =
  | { kind: 'upToDate' | 'baseUnavailable' | 'unrelated'; blueprint: BlueprintChoice }
  | { kind: 'failed'; blueprint: BlueprintChoice; allowUnrelated: boolean; message: string }

const GROUP_LABELS: Record<BlueprintChoiceSource, string> = {
  followed: 'Following',
  linked: 'From link',
  yours: 'Your blueprints',
  featured: 'Featured',
}

const LINK_MESSAGES: Partial<Record<LinkLookup['status'], string>> = {
  notALink: 'That is not a link to a blueprint.',
  loading: 'Looking up that blueprint…',
  notFound: 'No blueprint was found at that link.',
  failed: 'That link could not be looked up.',
}

const DIALOG_CLASS =
  'responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(520px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0'

const BODY_TEXT = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'

// The merge is recorded as a minimal diff, which is slow to find between files that share little.
const APPLYING_NOTE =
  'Working out the update. This can take a few minutes for a blueprint that has little in ' +
  'common with the gadget.'

/**
 * Picks a blueprint and proposes merging its current release into a gadget (see
 * GadgetClient.applyBlueprint()). The proposal lands in a new chat, where it is previewed and
 * accepted, so nothing here changes the gadget. Mount it while it should be open.
 */
export const UpdateFromBlueprintDialog = ({
  gadget,
  overseer,
  authenticatedApi,
  publicApi,
  onClose,
  onProposed,
}: UpdateFromBlueprintDialogProps) => {
  const followedId = gadget.upstream?.blueprintId

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(followedId ?? null)
  const [link, setLink] = useState<{ text: string; lookup: LinkLookup }>(
    { text: '', lookup: { status: 'empty' } },
  )
  const linkRequest = useRef(0)
  const [applying, setApplying] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      overseer.listModels(),
      followedId === undefined ? null : publicApi.getBlueprint(followedId),
      authenticatedApi.listOwnBlueprints(),
      authenticatedApi.listLibraryBlueprints(),
      authenticatedApi.listFeaturedBlueprints(),
    ]).then(([models, followed, own, library, featured]) => {
      if (cancelled) return
      // The same choice a new chat's composer starts on, since a new chat is where this lands.
      const reviewerId = getStoredSelectedModel(models)
      const reviewer = models.find(model => model.id === reviewerId) ?? null
      setLoad({ status: 'loaded', reviewer, followed, own, library, featured })
    }, err => {
      logRpcFailure('Failed to load the blueprints to update from:', err)
      if (!cancelled) setLoad({ status: 'failed' })
    })
    return () => { cancelled = true }
  }, [overseer, authenticatedApi, publicApi, followedId, loadAttempt])

  const retryLoad = () => {
    setLoad({ status: 'loading' })
    setLoadAttempt(attempt => attempt + 1)
  }

  const handleLinkChange = (text: string) => {
    const request = ++linkRequest.current
    const blueprintId = parseBlueprintLink(text)
    if (blueprintId === null) {
      setLink({ text, lookup: { status: text.trim() === '' ? 'empty' : 'notALink' } })
      return
    }
    setLink({ text, lookup: { status: 'loading' } })
    publicApi.getBlueprint(blueprintId).then(blueprint => {
      if (linkRequest.current !== request) return
      if (blueprint === null) {
        setLink({ text, lookup: { status: 'notFound' } })
        return
      }
      setLink({ text, lookup: { status: 'found', blueprint } })
      setSelectedId(blueprint.id)
      setOutcome(null)
    }, err => {
      logRpcFailure('Failed to look up a blueprint link:', err)
      if (linkRequest.current === request) setLink({ text, lookup: { status: 'failed' } })
    })
  }

  const apply = async (blueprint: BlueprintChoice, allowUnrelated: boolean) => {
    if (load.status !== 'loaded') return
    setApplying(true)
    try {
      const result = await gadget.client.applyBlueprint(blueprint.id, {
        modelId: load.reviewer?.id ?? null,
        ...(allowUnrelated ? { allowUnrelated } : {}),
      })
      if (result.outcome === 'proposed') onProposed(result.chatId)
      else setOutcome({ kind: result.outcome, blueprint })
    } catch (err) {
      // What the server says is worth showing as it is. In particular it is how the user learns
      // that the gadget changed while the update was being worked out, which trying again cures.
      const transient = logRpcFailure('Failed to apply a blueprint:', err)
      const message = transient || !(err instanceof Error) || !err.message
        ? 'Something went wrong while preparing the update.'
        : err.message
      setOutcome({ kind: 'failed', blueprint, allowUnrelated, message })
    } finally {
      setApplying(false)
    }
  }

  const groups = load.status === 'loaded'
    ? groupBlueprintChoices({
      ...load,
      linked: link.lookup.status === 'found' ? link.lookup.blueprint : null,
    })
    : []
  const selected = groups.flatMap(group => group.choices).find(choice => choice.id === selectedId)

  // A blueprint stored before releases were commits names no release to compare with, so it
  // gets neither status.
  const followedStatus =
    load.status !== 'loaded' || !load.followed || !gadget.upstream ? null
      : hasNewerRelease(gadget.upstream, load.followed.metadata) ? 'Update available'
        : load.followed.metadata.commitId !== undefined ? 'Up to date' : null

  const header = (title: string, description: string) => (
    <div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
      <div className="min-w-0">
        <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
          {title}
        </Dialog.Title>
        <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
          {description}
        </Dialog.Description>
      </div>
      <Dialog.Close
        render={props => (
          <WorkshopIconButton {...props} disabled={applying} aria-label="Close">
            <X size={18} />
          </WorkshopIconButton>
        )}
      />
    </div>
  )

  const actions = (note: string | null, buttons: ReactNode) => (
    <div className="flex items-center justify-between gap-3">
      <p role="status" className="m-0 min-w-0 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
        {applying ? APPLYING_NOTE : note}
      </p>
      <div className="flex shrink-0 items-center gap-2">{buttons}</div>
    </div>
  )

  const reviewerNote = load.status !== 'loaded'
    ? null
    : load.reviewer
      ? `If the gadget and the blueprint have both changed, ${load.reviewer.name} reviews the merge.`
      : 'No agent is selected, so a merge of changes on both sides is not reviewed.'

  const outcomeBanner = () => {
    switch (outcome?.kind) {
      case 'upToDate':
        return (
          <Banner
            size="sm"
            title="Already up to date"
            description={`This gadget already has the latest version of ${outcome.blueprint.title}.`}
          />
        )
      case 'baseUnavailable':
        return (
          <Banner
            variant="alert"
            size="sm"
            title="This update can't be merged"
            description={
              `This gadget and ${outcome.blueprint.title} have an earlier version in common, but ` +
              'its files are not available to merge against.'
            }
          />
        )
      case 'failed':
        return (
          <Banner
            variant="error"
            size="sm"
            title="The update could not be prepared"
            description={outcome.message}
            action={
              <Banner.Action
                onClick={() => apply(outcome.blueprint, outcome.allowUnrelated)}
                disabled={applying}
              >
                Try again
              </Banner.Action>
            }
          />
        )
      default:
        return null
    }
  }

  const unrelated = outcome?.kind === 'unrelated' ? outcome.blueprint : null

  return (
    <Dialog.Root open onOpenChange={nextOpen => { if (!nextOpen && !applying) onClose() }}>
      <Dialog className={DIALOG_CLASS} size="lg">
        {unrelated ? (
          <>
            {header('Unrelated blueprint', `This gadget shares no history with ${unrelated.title}.`)}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5 sm:px-6">
              {/* Kumo's Banner announces nothing itself, and this replaces what was on screen. */}
              <div role="alert">
                <Banner
                  variant="alert"
                  size="sm"
                  title="Your own changes may be undone"
                  description={
                    'With no version in common, the update has to be merged against a guess at ' +
                    'what this gadget was built from. A change of yours that the guess happens ' +
                    'to include looks like something the blueprint removed, and is undone ' +
                    'without a conflict being reported.'
                  }
                />
              </div>
              <p className={BODY_TEXT}>
                The update opens in a new chat, where you can check the result before accepting
                it. Nothing changes until you do.
              </p>
            </div>
            <div className="shrink-0 border-t border-kumo-line px-4 py-4 sm:px-6">
              {actions(null, (
                <>
                  <WorkshopButton
                    className="!h-9"
                    onClick={() => setOutcome(null)}
                    disabled={applying}
                    // The button that led here is gone, and took the focus with it.
                    autoFocus
                  >
                    Back
                  </WorkshopButton>
                  <WorkshopButton tone="primary" onClick={() => apply(unrelated, true)} disabled={applying}>
                    {applying ? 'Preparing update…' : 'Update anyway'}
                  </WorkshopButton>
                </>
              ))}
            </div>
          </>
        ) : (
          <>
            {header(
              'Update from blueprint',
              `Merge a blueprint's latest version into ${gadget.title}. The update opens in a ` +
                'new chat, where you can try it before accepting it.',
            )}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
              <div className="space-y-1.5">
                <WorkshopInput
                  aria-label="Blueprint link"
                  placeholder="Paste a blueprint link"
                  value={link.text}
                  onChange={event => handleLinkChange(event.target.value)}
                  disabled={applying}
                  className="w-full"
                />
                <p role="status" className={`${BODY_TEXT} empty:hidden`}>
                  {LINK_MESSAGES[link.lookup.status]}
                </p>
              </div>

              {load.status === 'loading' ? (
                <div className="flex justify-center py-6"><Loader size="base" /></div>
              ) : load.status === 'failed' ? (
                <Banner
                  variant="error"
                  size="sm"
                  title="Your blueprints could not be loaded"
                  action={<Banner.Action onClick={retryLoad}>Try again</Banner.Action>}
                />
              ) : (
                <>
                  {followedId !== undefined && load.followed === null && (
                    <p className={BODY_TEXT}>
                      The blueprint this gadget follows is no longer available.
                    </p>
                  )}
                  {groups.length === 0 ? (
                    <p className={BODY_TEXT}>
                      You have no blueprints to update from yet. Paste the link of one above.
                    </p>
                  ) : (
                    <Radio.Group
                      appearance="card"
                      // Never undefined, which would make the group uncontrolled. No blueprint
                      // has the empty id, so it selects nothing.
                      value={selectedId ?? ''}
                      onValueChange={blueprintId => {
                        setSelectedId(blueprintId)
                        setOutcome(null)
                      }}
                      disabled={applying}
                    >
                      <Radio.Legend className="sr-only">Blueprint to update from</Radio.Legend>
                      {groups.map(group => (
                        <Fragment key={group.source}>
                          <p className="m-0 text-[11px] font-medium uppercase leading-4 tracking-[0.06em] text-kumo-inactive">
                            {GROUP_LABELS[group.source]}
                          </p>
                          {group.choices.map(choice => {
                            const status = group.source === 'followed' ? followedStatus : null
                            return (
                              <Radio.Item
                                key={choice.id}
                                value={choice.id}
                                label={choice.title}
                                description={
                                  <>
                                    <span className="block">
                                      Version {choice.version}{status && ` · ${status}`}
                                    </span>
                                    {choice.description && (
                                      <span className="line-clamp-2">{choice.description}</span>
                                    )}
                                  </>
                                }
                              />
                            )
                          })}
                        </Fragment>
                      ))}
                    </Radio.Group>
                  )}
                </>
              )}
            </div>

            <div className="shrink-0 space-y-3 border-t border-kumo-line px-4 py-4 sm:px-6">
              {/* Always present, so that what arrives in it is announced: Kumo's Banner announces
                  nothing itself. */}
              <div aria-live="polite" className="empty:hidden">{outcomeBanner()}</div>
              {actions(reviewerNote, (
                <>
                  <WorkshopButton className="!h-9" onClick={onClose} disabled={applying}>
                    Cancel
                  </WorkshopButton>
                  <WorkshopButton
                    tone="primary"
                    onClick={() => { if (selected) void apply(selected, false) }}
                    disabled={applying || selected === undefined}
                  >
                    {applying ? 'Preparing update…' : 'Update'}
                  </WorkshopButton>
                </>
              ))}
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
