import { useEffect, useMemo, useState } from 'react'
import { CubeIcon } from '@phosphor-icons/react'
import type { AiChatAuthorInfo, BlueprintBindingAssignment, BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { UseBlueprintDialog, type UseBlueprintNeed } from '@/blocks/UseBlueprintDialog'
import { useModels } from '@/chat/useModels'
import { ConnectResource } from '@/connections/SetUpConnection'
import { useServices } from '@/connections/useServices'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { isNamedWorkspace } from '@/workspaces/workspaceKind'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { useRefreshWorkspaces, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { initialAnswers, modelsFor, needsOf, shortResource, type BlueprintNeed, type NeedAnswers } from './blueprintNeeds'
import { KindMark } from '@/components/KindMark'

/** The gadget a blueprint was made into, and whether it is an app, which has a page of its own. */
export type MadeGadget = { workspaceId: string; gadgetId: number; app: boolean }

export type UseBlueprintProps = {
  blueprint: BlueprintPublicInfo
  open: boolean
  onOpenChange: (open: boolean) => void
  /** It was made: show it. */
  onMade: (made: MadeGadget) => void
}

type Connected = { assignment: Extract<BlueprintBindingAssignment, { type: 'gatekeeper' }>; shown: string }

/**
 * Makes a gadget of the user's own from a blueprint (`UseBlueprintDialog`). What it needs is set up
 * with the user's own: a connection in its service's form (`ConnectResource`), coming back here
 * once chosen; a model from their models, starting as the author suggested where they have it.
 * Then it is made in a new workspace, named after it and listed with the user's workspaces
 * (`newWorkspaceFromBlueprint`, then `makeWorkspace`); or, for one that needs nothing, in a
 * workspace the user builds in, if they choose one (`createGadgetFromBlueprint`).
 */
export const UseBlueprint = ({ blueprint, open, onOpenChange, onMade }: UseBlueprintProps) => {
  const { api, user, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const { services } = useServices()
  const { models } = useModels()
  const workspaces = useWorkspaces()
  const refreshWorkspaces = useRefreshWorkspaces()
  const { metadata } = blueprint
  const needs = useMemo(() => needsOf(metadata), [metadata])

  // Decision models, read only for a blueprint that needs one.
  const wantsDecision = needs.some((need) => need.type === 'model' && need.kind === 'decision')
  const [decision, setDecision] = useState<readonly AiChatAuthorInfo[]>([])
  useEffect(() => {
    if (!wantsDecision || reconnecting) return
    let current = true
    // Without them, the need says there is no model of its kind.
    api.listModels('decision').then((listed) => { if (current) setDecision(listed) }, () => {})
    return () => {
      current = false
    }
  }, [api, reconnecting, wantsDecision])

  const offered = useMemo(() => ({ language: models.status === 'ready' ? models.offered : [], decision }), [models, decision])
  const preferred = models.status === 'ready' ? models.preferred : undefined
  // What the user chose, over what each need starts with.
  const [chosenModels, setChosenModels] = useState<NeedAnswers>({})
  const [connected, setConnected] = useState<Record<string, Connected>>({})
  const answers = useMemo(
    (): NeedAnswers => ({
      ...initialAnswers(needs, offered, preferred),
      ...chosenModels,
      ...Object.fromEntries(Object.entries(connected).map(([key, { assignment }]) => [key, assignment])),
    }),
    [needs, offered, preferred, chosenModels, connected],
  )

  // The need whose service's form is open in the dialog's place.
  const [connecting, setConnecting] = useState<string>()
  const connectingNeed = needs.find((need): need is Extract<BlueprintNeed, { type: 'connection' }> => need.key === connecting && need.type === 'connection')

  // Where it goes, for one that needs nothing: one of the workspaces the user builds in, or none for a new one.
  const [into, setInto] = useState<string>()
  const looks = useWorkspaceLooks()
  const named = useMemo(() => (workspaces.status === 'ready' ? workspaces.workspaces : [])
    .filter((workspace) => isNamedWorkspace(workspace) && workspace.role !== 'use')
    .toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.title.localeCompare(b.title))
    .map(({ id, title }) => ({ id, title, label: workspaceLabel(title), look: looks[id] })), [workspaces, looks])

  const vendorOf = (vendorId: string) => (services.status === 'ready' ? services.vendors.find(({ id }) => id === vendorId) : undefined)
  const serviceOf = (vendorId: string) => {
    const vendor = vendorOf(vendorId)
    return vendor && { name: vendor.description.displayName, logoUrl: vendor.description.logo?.url, color: vendor.description.color }
  }
  const kindOf = (need: Extract<BlueprintNeed, { type: 'connection' }>) =>
    vendorOf(need.vendorId)?.supportedResources.find(({ urlPattern }) => urlPattern === need.urlPattern)?.title

  const rows = needs.map((need): UseBlueprintNeed => {
    if (need.type === 'connection') {
      const vendor = vendorOf(need.vendorId)
      return {
        key: need.key,
        title: need.title,
        description: need.description || kindOf(need),
        service: serviceOf(need.vendorId) ?? { name: need.vendorId },
        kind: 'connection',
        chosen: connected[need.key]?.shown,
        unavailable: services.status === 'ready' && (!vendor || vendor.unavailable) ? 'Not offered here' : undefined,
        onChoose: () => setConnecting(need.key),
      }
    }
    const answer = answers[need.key]
    return {
      key: need.key,
      title: need.title,
      description: need.description || (need.type === 'agent' ? 'The model an agent it starts runs on' : need.kind === 'decision' ? 'A decision model' : 'An AI model it uses'),
      icon: need.type === 'agent' ? <KindMark name="agent" /> : <CubeIcon />,
      kind: 'model',
      models: modelsFor(need, offered),
      chosen: answer && answer.type !== 'gatekeeper' ? answer.modelId : undefined,
      none: need.type === 'agent' ? 'No agent' : undefined,
      onChoose: (modelId) => setChosenModels((current) => ({
        ...current,
        [need.key]: need.type === 'agent' ? { type: 'agentSpawner', modelId } : { type: 'aiModel', modelId: modelId ?? '' },
      })),
    }
  })

  const make = async () => {
    if (connection?.blocked()) return false
    const app = !metadata.output
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    if (needs.length === 0 && into !== undefined) {
      const overseer = api.openWorkspace(into)
      const gadget = overseer.createGadgetFromBlueprint(blueprint.id)
      try {
        onMade({ workspaceId: into, gadgetId: await gadget.getId(), app })
      } finally {
        gadget[Symbol.dispose]()
        overseer[Symbol.dispose]()
      }
      return true
    }
    // Pipelined: named and read in the same round trip as it is made.
    const overseer = api.newWorkspaceFromBlueprint(blueprint.id, answers)
    try {
      const [, made] = await Promise.all([overseer.makeWorkspace(metadata.title), overseer.getMetadata()])
      refreshWorkspaces()
      if (made.defaultGadgetId === undefined) throw new Error('It was made without a gadget.')
      onMade({ workspaceId: made.id, gadgetId: made.defaultGadgetId, app })
    } finally {
      overseer[Symbol.dispose]()
    }
    return true
  }

  const kind = connectingNeed && kindOf(connectingNeed)
  return (
    <>
      <UseBlueprintDialog
        open={open && !connectingNeed}
        onOpenChange={onOpenChange}
        title={metadata.title}
        madeBy={metadata.author.id === user.id ? undefined : metadata.author.name}
        needs={rows}
        place={needs.length === 0 ? { workspaces: named, value: named.some(({ id }) => id === into) ? into : undefined, onChange: setInto } : undefined}
        onUse={make}
      />
      {connectingNeed && (
        <ConnectResource
          key={connectingNeed.key}
          open={open}
          // Put away, it comes back to the rest of what the blueprint needs.
          onOpenChange={(next) => { if (!next) setConnecting(undefined) }}
          onBack={() => setConnecting(undefined)}
          service={{ vendorId: connectingNeed.vendorId, name: serviceOf(connectingNeed.vendorId)?.name ?? connectingNeed.vendorId }}
          resourceUrlPattern={connectingNeed.urlPattern}
          resourceUrl={connected[connectingNeed.key]?.assignment.resourceUrl ?? connectingNeed.resourceUrl}
          scope={connectingNeed.title}
          description={connectingNeed.description || (kind ? `Choose which ${kind.toLowerCase()} “${metadata.title}” uses.` : undefined)}
          unknownKind="This kind of resource can’t be chosen here."
          onConnect={async (accountId, resourceUrl) => {
            setConnected((current) => ({ ...current, [connectingNeed.key]: { assignment: { type: 'gatekeeper', accountId, resourceUrl }, shown: shortResource(resourceUrl) } }))
          }}
        />
      )}
    </>
  )
}
