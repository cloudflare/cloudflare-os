import { useEffect, useMemo, useRef, useState } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatHeader } from '@/blocks/ChatHeader'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import type { ComposerConnection } from '@/blocks/ComposerConnectionLines'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LiveRows } from '@/blocks/LiveRows'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList, type MessageListHandle } from '@/blocks/MessageList'
import { UserMessage } from '@/blocks/UserMessage'
import type { SentMessage } from './NewChatPane'
import { WorkLog } from '@/blocks/WorkLog'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { AddConnection, type AddedConnection } from '@/connections/AddConnection'
import { useApproveCreation } from '@/connections/ApproveCreation'
import { useCreationKinds } from '@/connections/useCreationKinds'
import { PendingTray, type PendingTrayGroup } from '@/blocks/PendingTray'
import { pendingActions, pendingCount, pendingGroups } from './pendingGroups'
import { usePendingDecisions } from './usePendingDecisions'
import { ShareWorkspaceDialog } from '@/sharing/ShareWorkspaceDialog'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { isNamedWorkspace } from '@/workspaces/workspaceKind'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { withCapsules } from './capsules'
import { ChatItemView, type ChatItemHandlers } from './ChatItemView'
import { continuesRun, EMPTY_FEED, type ActionItem, type ChatItem, type OutputItem } from './chatItems'
import type { ChatSnapshot } from './ChatSession'
import { DisclosureStore, useOpenKeys } from './DisclosureStore'
import { nameGadgets, type GoBack } from './changePoints'
import { KeepAskCard } from './KeepAskCard'
import { quoteLine, withQuote } from './replyQuote'
import { describeModelProblem, modelFor } from './models'
import { useModels } from './useModels'
import { missingCommand, slashRequestFor } from './slashCommands'
import { useChatCommands } from './useChatCommands'
import { useChatSession } from './useChatSession'

export type ChatPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the list it was opened from. */
  initialTitle?: string
  /**
   * The first message, as it was drawn while the chat was started (`NewChatPane`): drawn where it
   * was until the conversation is read, with the agent thinking, so the chat goes on from it.
   */
  sending?: SentMessage
  /** Goes to the page of the workspace the chat is in. */
  onOpenWorkspace: () => void
  /** Opens the chat's settings, from its title, or at its automations, from the header's clock. */
  onOpenSettings?: (tab?: 'automations') => void
  /**
   * What the chat leaves to whoever can do it: opening a file or an output, which is for whoever
   * lays out the page it opens beside, and what this app cannot do itself yet. Left out, the chat
   * says so when asked. Keep each stable, or every row renders again.
   */
  onOpenAttachment?: ChatItemHandlers['onOpenAttachment']
  onOpenOutput?: ChatItemHandlers['onOpenOutput']
  onOpenMade?: ChatItemHandlers['onOpenMade']
  /** The connected file open beside the chat, if one is, whose changes are reviewed there. */
  shownBeside?: { gatekeeperId: number; subjectId: string }
  madeHref?: ChatItemHandlers['madeHref']
  outputHref?: ChatItemHandlers['outputHref']
  onSetUpConnection?: ChatItemHandlers['onSetUpConnection']
  onOpenChat?: ChatItemHandlers['onOpenChat']
  chatHref?: ChatItemHandlers['chatHref']
  /** The address of the chat's workspace, which sharing it copies. Left out, it is not shared from here. */
  workspaceLink?: string
}

const LIVE_WORK = 'live:work'

const FILE_NOUNS = { document: 'Google Doc', spreadsheet: 'Google Sheet', presentation: 'Google Slides deck' } as const

/** A gadget's title, as the chat's own cards for it have it: what the chat made, or worked on. */
const outputTitle = (items: readonly ChatItem[] | undefined, chat: ChatSnapshot, gadgetId: number) => {
  const pinned = chat.status === 'ready' ? chat.pinned : []
  return [...(items ?? []), ...pinned]
    .findLast((item): item is OutputItem => item.kind === 'output' && item.workpieceId === gadgetId)?.title
}

/** One chat, live: its title, the messages as they arrive, and the composer. */
export const ChatPane = ({
  workspaceId,
  chatId,
  initialTitle,
  sending,
  onOpenWorkspace,
  onOpenSettings,
  onOpenAttachment,
  onOpenOutput,
  onOpenMade,
  shownBeside,
  madeHref,
  outputHref,
  onSetUpConnection,
  onOpenChat,
  chatHref,
  workspaceLink,
}: ChatPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  const { choices, commands } = useChatCommands(actions.listCommands, chat.status === 'ready')
  const { models } = useModels()
  // A model chosen for this chat's next message; until then, the chat's own.
  const [picked, setPicked] = useState<{ chatId: number; id: string }>()
  const pickedId = picked?.chatId === chatId ? picked.id : undefined
  const chatModel = chat.status === 'ready' ? chat.model : undefined
  const model = useMemo(() => modelFor(models, { picked: pickedId, chat: chatModel }), [models, pickedId, chatModel])
  const workspaces = useWorkspaces()
  const connection = useConnectionNotice()
  const { approveCreation, dialog: creationDialog } = useApproveCreation({
    workspaceId,
    approve: (actionId, creation) => actions.decideAction(actionId, 'approve', creation),
  })
  const decisions = usePendingDecisions({ decide: actions.decideAction, approveCreation })
  // Why the last message could not be sent, when it never reached the conversation.
  const [problem, setProblem] = useState<string>()
  // What a row asked for that this app cannot do yet.
  const [notice, setNotice] = useState<string>()
  const [disclosure] = useState(() => new DisclosureStore())
  // The message the draft replies to: its row, and the line of it that will be quoted.
  const [reply, setReply] = useState<{ key: string; quote: string }>()
  // The standing approval last asked about, kept while the question goes so that it still names it.
  const [asked, setAsked] = useState<{ rule: NonNullable<ActionItem['rule']>; open: boolean }>()
  // Undoing that would delete what it made, while that is asked about; kept as the question goes.
  const [deleting, setDeleting] = useState<{ point: GoBack; open: boolean }>()
  const composer = useRef<ComposerHandle>(null)
  const list = useRef<MessageListHandle>(null)
  const work = chat.status === 'ready' ? chat.work : EMPTY_FEED.work
  const openWork = useOpenKeys(disclosure, [LIVE_WORK, ...work.map(({ key }) => key)])
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  const items = chat.status === 'ready' ? chat.items : undefined
  // The automations its cards show that were not deleted, for the header's clock. A card is
  // pinned beneath the conversation, so it is looked for there.
  const pinned = chat.status === 'ready' ? chat.pinned : undefined
  const automations = useMemo(() => pinned?.filter((item) => item.kind === 'hook' && item.hookId !== undefined).length ?? 0, [pinned])
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
  const restricted = workspace?.containsRestrictedData === true
  const [sharing, setSharing] = useState(false)
  // Add a connection is open; and the connections made for the draft, by their line's key.
  const [adding, setAdding] = useState(false)
  const added = useRef(new Map<string, AddedConnection>())
  // Making a connection in the workspace is building in it.
  const builds = workspace !== undefined && workspace.role !== 'use'
  // Those who can only use what is in it cannot share it.
  const shareable = workspace !== undefined && workspace.role !== 'use' && workspaceLink !== undefined
  // Why the last message did not go, whether it was stopped here or by the server.
  const sendProblem = problem ?? (chat.status === 'ready' ? chat.sendError : undefined)
  useDocumentTitle(title ?? 'Chat')

  // What is on screen has been read: each message that arrives while the tab is in view, and
  // what came while it was away once it is back.
  const latestRow = items?.at(-1)?.id
  useEffect(() => {
    const markIfShown = () => document.visibilityState === 'visible' && actions.markRead()
    markIfShown()
    document.addEventListener('visibilitychange', markIfShown)
    return () => document.removeEventListener('visibilitychange', markIfShown)
  }, [actions, latestRow])

  const handlers = useMemo((): ChatItemHandlers => {
    const unavailable = (what: string) => () => setNotice(`${what} isn’t available in this app yet.`)
    return {
      workspaceId,
      onReply: (item) => {
        setReply({ key: item.key, quote: quoteLine(item) })
        composer.current?.focus()
      },
      // The message may have had to be fetched. The list has its row by the next frame.
      onShowQuoted: (replying) => void actions.findQuoted(replying).then((key) => {
        if (key) requestAnimationFrame(() => list.current?.scrollToMessage(key))
      }),
      onOpenAttachment: onOpenAttachment ?? unavailable('Previewing attachments'),
      loadAttachment: actions.attachmentContent,
      onOpenOutput: onOpenOutput ?? unavailable('Opening outputs'),
      onOpenMade: onOpenMade ?? unavailable('Opening files'),
      madeHref,
      outputHref,
      onApprove: (action) => decisions.run([action], 'approve'),
      onDeny: actions.rejectAction,
      // Asked first: it reaches past this action, to every chat and gadget in the workspace.
      onAlwaysApprove: (rule) => setAsked({ rule, open: true }),
      onHookEnabledChange: actions.setHookEnabled,
      // TODO: the connect flow, which ends in `Overseer.acceptConnectionRequest`.
      onSetUpConnection: onSetUpConnection ?? unavailable('Setting up connections'),
      onDenyConnection: actions.denyConnection,
      onRetry: () => (model.status === 'ready' ? actions.retry(model.model.id) : setProblem(describeModelProblem(model))),
      // TODO: the add-credits flow.
      onContinue: unavailable('Adding credits'),
      // Undoing what made a gadget deletes it, which is asked about first; anything else can be gone back on.
      onGoBack: (point) => (point.deletes.length ? setDeleting({ point, open: true }) : actions.goBack(point)),
      onOpenChat,
      chatHref,
    }
  }, [actions, model, onOpenAttachment, onOpenOutput, onOpenMade, madeHref, outputHref, onSetUpConnection, onOpenChat, chatHref, decisions.run, workspaceId])
  const keep = chat.status === 'ready' ? chat.keep : undefined

  // What waits on the user is docked above the composer, by what it would change, rather than
  // left in the conversation where the next answer pushes it out of sight.
  // Wherever they are: one asked for in an earlier turn is in the conversation, not under it.
  const waiting = useMemo(() => pendingActions([...(items ?? []), ...(pinned ?? [])]), [items, pinned])
  const live = useMemo(() => pinned?.filter((item) => !(item.kind === 'action' && item.state === 'pending')) ?? [], [pinned])
  // A Google file not made yet is shown as what it will be, once its gatekeeper says.
  const creationKind = useCreationKinds(workspaceId, waiting.flatMap(({ creation }) => (creation ? [creation.gatekeeperId] : [])))
  const trayGroups = useMemo((): PendingTrayGroup[] => pendingGroups(waiting).map((pending) => {
    const made = pending.creates && pending.target.gatekeeperId !== undefined ? creationKind(pending.target.gatekeeperId) : undefined
    const group = made && !pending.target.fileKind ? { ...pending, target: { ...pending.target, fileKind: made } } : pending
    const { target } = group
    // A Google file is reviewed beside the chat, drawn as it will be: one not made yet as the new
    // file (an empty id, `AsideConnectedFile`).
    const subjectId = group.creates ? '' : target.subjectId
    const drawn = target.fileKind !== undefined && subjectId !== undefined && target.gatekeeperId !== undefined
    return {
      key: group.key,
      title: target.title,
      fileKind: target.fileKind,
      summary: group.creates
        ? `New ${target.fileKind ? FILE_NOUNS[target.fileKind] : 'resource'}${group.actions.length > 1 ? `, with ${pendingCount(group)}` : ''}`
        : pendingCount(group),
      holdsAgent: group.holdsAgent,
      reviewing: drawn && shownBeside?.gatekeeperId === target.gatekeeperId && shownBeside?.subjectId === subjectId,
      onReview: drawn
        ? () => handlers.onOpenMade({ gatekeeperId: target.gatekeeperId!, subjectId: subjectId!, title: target.title, fileKind: target.fileKind!, url: target.url ?? '' })
        : undefined,
      requests: group.actions.map((action) => ({
        actionId: action.actionId,
        title: action.title,
        description: action.description,
        fields: action.fields,
        onAlwaysApprove: action.rule && (() => setAsked({ rule: action.rule!, open: true })),
      })),
    }
  }), [waiting, handlers, shownBeside, creationKind])
  const byId = (actionId: number) => waiting.filter((action) => action.actionId === actionId)


  const messages = useMemo(() => {
    // An artefact is shown at the end of its turn, after rows from later messages, so a row's
    // place in the conversation is the furthest sequence reached so far.
    let sequence = 0
    // What waits on the user is in the tray above the composer, until it is decided.
    const rows = items?.filter((item) => !(item.kind === 'action' && item.state === 'pending'))
    return rows?.map((item, index) => {
      sequence = Math.max(sequence, item.id)
      return {
        id: item.key,
        sequence,
        content: (
          <ChatItemView
            item={item}
            disclosure={disclosure}
            handlers={handlers}
            restricted={restricted}
            // The list wraps every row, so messages in a run are told about each other.
            joinsAbove={continuesRun(rows[index - 1], item)}
            joinsBelow={index + 1 < rows.length && continuesRun(item, rows[index + 1])}
          />
        ),
      }
    }) ?? []
  }, [items, disclosure, handlers, restricted])

  // Resolves to whether the message went; until it has, the draft and what it replies to stay.
  const sendMessage = async (text: string, files: File[], command?: ComposerCommand, connections?: ComposerConnection[]) => {
    // Whoever says something is taken to where it will appear, and to what answers it, wherever
    // in the conversation they were reading. Only what others say waits for a reader who is not
    // at the end.
    list.current?.scrollToLatest()
    if (chat.status !== 'ready') {
      if (!connection?.blocked()) setProblem('The conversation is still loading. Try again in a moment.')
      return false
    }
    if (model.status !== 'ready') {
      setProblem(describeModelProblem(model))
      return false
    }
    setProblem(undefined)
    setNotice(undefined)
    const replied = reply
    const words = replied ? withQuote(replied.quote, text) : text
    const request = command && slashRequestFor(choices, command, words)
    if (command && !request) {
      setProblem(missingCommand(command))
      return false
    }
    const given = connections?.flatMap(({ key }) => added.current.get(key) ?? []) ?? []
    const { text: written, capsules } = withCapsules(words, given)
    const sent = await actions.send(request ?? written, model.model.id, files, capsules.length ? capsules : undefined)
    // Unless another message has been chosen to reply to meanwhile.
    if (sent) setReply((current) => (current === replied ? undefined : current))
    return sent
  }

  return (
    <ChatLayout
      header={(workspace || title) && (
        <ChatHeader
          workspace={workspace && isNamedWorkspace(workspace) ? { id: workspaceId, title: workspace.title, label: workspaceLabel(workspace.title), look, onOpen: onOpenWorkspace } : undefined}
          title={title}
          onOpenSettings={onOpenSettings && (() => onOpenSettings())}
          automations={automations > 0 && onOpenSettings ? { count: automations, onOpen: () => onOpenSettings('automations') } : undefined}
          onShare={shareable ? () => setSharing(true) : undefined}
        />
      )}
      composer={(
        <>
        <PendingTray
          groups={trayGroups}
          restricted={restricted}
          progress={decisions.progress}
          problem={decisions.problem}
          onDismissProblem={decisions.dismissProblem}
          onApproveAll={() => decisions.run(waiting, 'approve')}
          onDenyAll={() => decisions.run(waiting, 'deny')}
          onApprove={(actionId) => decisions.run(byId(actionId), 'approve')}
          onDeny={(actionId) => decisions.run(byId(actionId), 'deny')}
        />
        <Composer
          ref={composer}
          onSend={sendMessage}
          commands={commands}
          addActions={{
            onAddConnection: builds ? () => {
              if (!connection?.blocked()) setAdding(true)
            } : undefined,
            model: models.status === 'ready' && model.status === 'ready' && models.offered.length > 1 ? {
              models: models.offered,
              current: model.model.id,
              onChoose: (id) => setPicked({ chatId, id }),
            } : undefined,
          }}
          stop={chat.status === 'ready' && chat.agentActive ? {
            waiting: chat.waiting,
            onStop: () => {
              if (connection?.blocked()) return false
              setProblem(undefined)
              actions.dismissSendError()
              return actions.stopAgent().catch((error: unknown) => {
                setProblem(`The agent couldn’t be stopped: ${error instanceof Error ? error.message : String(error)}`)
                throw error
              })
            },
          } : undefined}
          problem={sendProblem === undefined ? undefined : {
            message: sendProblem,
            onDismiss: () => {
              setProblem(undefined)
              actions.dismissSendError()
            },
          }}
          reply={reply && {
            quote: reply.quote,
            onShow: () => list.current?.scrollToMessage(reply.key),
            onCancel: () => setReply(undefined),
          }}
        />
        </>
      )}
    >
      {/* Another list once the conversation is read, which it is as it was found, not arriving; it
          comes in only where nothing was there before it (`entrance`). */}
      {chat.status === 'ready' ? (
        <MessageList
          key="read"
          ref={list}
          entrance={!sending}
          messages={messages}
          streaming={chat.activity !== undefined}
          history={{ hasMore: chat.hasEarlier, loading: chat.loadingEarlier, error: chat.historyError, onLoadEarlier: actions.loadEarlier }}
        >
          {/* Under the conversation, so what an answer produced is never left behind by what is said
              after it. These come and go, each in a row that opens and closes around it. */}
          <LiveRows>
            {live.map((item) => (
              <LiveRows.Row key={item.key}>
                <ChatItemView item={item} disclosure={disclosure} handlers={handlers} restricted={restricted} />
              </LiveRows.Row>
            ))}
            {keep && (
              <LiveRows.Row key="keep">
                <KeepAskCard
                  workspaceId={workspaceId}
                  chatId={chatId}
                  keep={keep}
                  outputTitle={(gadgetId) => outputTitle(items, chat, gadgetId)}
                  onKeep={actions.keepChanges}
                  onDiscard={actions.discardChanges}
                />
              </LiveRows.Row>
            )}
            {chat.actionError && <LiveRows.Row key="action-error"><MessageBubble role="error">{chat.actionError}</MessageBubble></LiveRows.Row>}
            {notice && <LiveRows.Row key="notice"><p role="status" className="px-2 text-sm text-kumo-subtle">{notice}</p></LiveRows.Row>}
          </LiveRows>
          {/* Last, in room that is always kept for it. A reply joins the conversation once it is
              written; until then it, and how it is coming about, can be looked into here. */}
          <AssistantPresence
            working={chat.activity !== undefined}
            status={chat.activity}
            details={{
              open: openWork.has(LIVE_WORK),
              onToggle: () => disclosure.toggle(LIVE_WORK),
              content: (
                <WorkLog steps={work} openSteps={openWork} onToggleStep={disclosure.toggle} />
              ),
            }}
          />
        </MessageList>
      ) : (
        <MessageList key="reading" messages={[]} entrance={!sending}>
          {chat.status === 'failed'
            ? <MessageBubble role="error">{chat.message}</MessageBubble>
            : sending
              ? (
                  <>
                    <UserMessage parts={sending.parts} attachments={sending.attachments} />
                    <AssistantPresence working status="Thinking…" />
                  </>
                )
              : <span role="status" className="appears-late text-sm text-kumo-subtle">Loading conversation…</span>}
        </MessageList>
      )}
      <ConfirmDialog
        open={deleting?.open === true}
        onOpenChange={(open) => setDeleting((current) => current && { ...current, open })}
        destructive
        title={`Undo creating ${nameGadgets(deleting?.point.deletes.map((id) => outputTitle(items, chat, id)) ?? [])}?`}
        description="What this made is deleted, with everything it stored, and can’t be brought back."
        confirm="Undo and delete"
        onConfirm={() => (deleting ? actions.goBack(deleting.point) : undefined)}
      />
      <ConfirmDialog
        open={asked?.open === true}
        onOpenChange={(open) => setAsked((current) => current && { ...current, open })}
        title={`Always approve “${asked?.rule.actionKind.label}”?`}
        description="From now on these go ahead without asking, in every chat in this workspace and whichever gadget asks. Any waiting now go ahead too. You can change this on the account’s page in Gatekeepers."
        confirm="Always approve"
        onConfirm={() => (asked ? actions.alwaysApprove(asked.rule) : undefined)}
      />
      {shareable && <ShareWorkspaceDialog workspaceId={workspaceId} title={isNamedWorkspace(workspace) ? workspace.title : (title ?? workspace.title)} link={workspaceLink} open={sharing} onOpenChange={setSharing} chat={!isNamedWorkspace(workspace)} />}
      {creationDialog}
      {builds && (
        <AddConnection
          workspaceId={workspaceId}
          open={adding}
          onOpenChange={setAdding}
          to="this chat"
          onAdded={async (made) => {
            const key = `gatekeeper:${made.gatekeeperId}`
            added.current.set(key, made)
            // The chat has it once the message goes with it.
            composer.current?.addConnection({ key, title: made.description.title, kind: made.kind, service: made.service })
          }}
        />
      )}
    </ChatLayout>
  )
}
