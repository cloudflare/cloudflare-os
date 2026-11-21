import type { BoundHookInfo, GadgetBindingInfo, OutputSummary } from '@gadgets/workshop-shared/api'
import { webUrl } from '@gadgets/ui'
import { chatConnectors } from './chatConnectors'
import type { ChatContext } from './chatContext'
import type { HookItem, OutputItem } from './chatItems'

/** What a chat's workspace has, as far as it has been read, for `availableTo`. */
export type WorkspaceHoldings = {
  /** What it has made (`OutputSummary`), most recently active first; absent until read. */
  library?: readonly OutputSummary[]
  /** Its automations; absent until read. */
  hooks?: readonly BoundHookInfo[]
  /** What its gadgets are bound to, as the chat sees them, its own drafts' bindings among them. */
  bindings: readonly GadgetBindingInfo[]
}

// The kinds of connection that reach a service: not a model, nor an agent the chat can start.
const REACHES_A_SERVICE = new Set<GadgetBindingInfo['kind']>(['gatekeeper', 'ambient', undefined])

const libraryItem = ({ workpieceId, title, output }: OutputSummary): OutputItem => ({
  kind: 'output',
  id: workpieceId,
  key: `output:${workpieceId}`,
  workpieceId,
  title,
  type: 'gadget',
  draft: false,
  format: output && { noun: output.noun, icon: output.icon },
})

const hookItem = (hook: BoundHookInfo): HookItem => ({
  kind: 'hook',
  id: hook.id,
  key: `hook:${hook.id}`,
  hookId: hook.id,
  title: hook.description.title,
  description: hook.description.description,
  resource: hook.resourceTitle ? { title: hook.resourceTitle, url: webUrl(hook.resourceUrl) } : undefined,
  enabled: hook.enabled,
})

/**
 * What a chat can use, rather than what it has used: everything its workspace has made, this
 * chat's drafts and worktrees first, as they are what it is working on; the workspace's
 * automations; the services its gadgets are bound to, with those the chat itself went through;
 * and what was uploaded to the chat, which is the chat's alone. Until the workspace's part is
 * read, the chat's own (`context`) stands in for it, so that nothing it has disappears meanwhile.
 * Nothing is from another workspace.
 */
export const availableTo = (context: ChatContext, { library, hooks, bindings }: WorkspaceHoldings): ChatContext => {
  const working = context.outputs.filter(({ draft, type }) => draft || type === 'worktree')
  const made = library?.map(libraryItem) ?? context.outputs.filter((output) => !working.includes(output))
  const outputs = [...working, ...made.filter(({ workpieceId }) => !working.some((each) => each.workpieceId === workpieceId))]

  // Listed once, so one the chat set up since is added from the chat, and one it deleted is not.
  const listed = hooks?.toSorted((a, b) => b.id - a.id).map(hookItem) ?? []
  const automations = [...context.hooks.filter(({ hookId }) => hookId !== undefined && !listed.some((each) => each.hookId === hookId)), ...listed]

  const bound = bindings
    .filter(({ kind, vendorId }) => vendorId !== undefined && REACHES_A_SERVICE.has(kind))
    .map(({ target, vendorId, resourceTitle }) => ({ gatekeeperId: target, vendorId, resourceTitle }))
  // Bound ones first, by service, then any the chat went through that no gadget is bound to.
  const connectors = chatConnectors(bound)
  for (const used of context.connectors) {
    const same = connectors.find(({ key }) => key === used.key)
    if (!same) connectors.push(used)
    else for (const scope of used.scopes) if (!same.scopes.includes(scope)) same.scopes.push(scope)
  }

  return { outputs, hooks: automations, files: context.files, connectors }
}
