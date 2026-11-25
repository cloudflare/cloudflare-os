import { useEffect, useState } from 'react'
import type { AiChatAuthorInfo, BlueprintBindingAssignment } from '@gadgets/workshop-shared/api'
import { UseTemplateDialog, type UseTemplateNeed } from '@/blocks/UseTemplateDialog'
import { useDefaultModel } from '@/chat/useDefaultModel'
import { ConnectResource } from '@/connections/SetUpConnection'
import { useConnections } from '@/connections/useConnections'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { initialAnswers, modelsFor, setupNeedsOf, shortResource, type ModelsByKind, type SetupAnswers, type SetupNeed } from './templateSetup'
import type { Template } from './templates'

/** What was made from a template, and whether it is an app, which has a page of its own. */
export type MadeFromTemplate = { workspaceId: string; gadgetId: number; app: boolean }

export type UseTemplateProps = {
  template: Template
  open: boolean
  onOpenChange: (open: boolean) => void
  /** It was made: show it. */
  onMade: (made: MadeFromTemplate) => void
}

type Connected = { assignment: Extract<BlueprintBindingAssignment, { type: 'gatekeeper' }>; shown: string }

/** The user's models of each kind there is a need for, read while `open`; undefined until they are. */
const useSetupModels = (open: boolean, decision: boolean) => {
  const { api, reconnecting } = useApi()
  const [models, setModels] = useState<ModelsByKind>()
  useEffect(() => {
    if (!open || reconnecting) return
    let current = true
    const none = (): AiChatAuthorInfo[] => []
    // Without them, a need says there is no model of its kind.
    Promise.all([api.listModels().catch(none), decision ? api.listModels('decision').catch(none) : []]).then(([language, decided]) => {
      if (current) setModels({ language, decision: decided })
    })
    return () => {
      current = false
    }
  }, [api, reconnecting, open, decision])
  return models
}

/**
 * Makes something of the user's own from a template (`UseTemplateDialog`). What it needs is set up
 * with the user's own: a connection in its service's form (`ConnectResource`), coming back here
 * once chosen; a model from their models, starting as its creator suggested where they have it.
 * Then it is made in a new workspace (`newWorkspaceFromBlueprint`), named after it and listed with
 * the user's workspaces.
 */
export const UseTemplate = ({ template, open, onOpenChange, onMade }: UseTemplateProps) => {
  const { api, user } = useApi()
  const connection = useConnectionNotice()
  const { state: services } = useConnections()
  const preferred = useDefaultModel()
  const { metadata } = template
  const needs = setupNeedsOf(metadata)
  const models = useSetupModels(open, needs.some((need) => need.type === 'model' && need.kind === 'decision'))

  // What the user chose, over what each need starts with.
  const [chosenModels, setChosenModels] = useState<SetupAnswers>({})
  const [connected, setConnected] = useState<Record<string, Connected>>({})
  const answers: SetupAnswers = {
    ...(models ? initialAnswers(needs, models, preferred.status === 'ready' ? preferred.id : undefined) : {}),
    ...chosenModels,
    ...Object.fromEntries(Object.entries(connected).map(([key, { assignment }]) => [key, assignment])),
  }

  // The need whose service's form is open in the dialog's place.
  const [connecting, setConnecting] = useState<string>()
  const connectingNeed = needs.find((need): need is Extract<SetupNeed, { type: 'connection' }> => need.key === connecting && need.type === 'connection')

  const vendorOf = (vendorId: string) => (services.status === 'ready' ? services.connections.find((each) => each.vendorId === vendorId) : undefined)
  const serviceOf = ({ key, vendorId }: Extract<SetupNeed, { type: 'connection' }>) => {
    const vendor = vendorOf(vendorId)?.vendor
    return { name: vendor?.displayName ?? template.services?.[key]?.name ?? vendorId, logoUrl: vendor?.logo?.url, color: vendor?.color }
  }
  const kindOf = (need: Extract<SetupNeed, { type: 'connection' }>) =>
    vendorOf(need.vendorId)?.resources.find(({ urlPattern }) => urlPattern === need.urlPattern)?.title

  const rows = needs.map((need): UseTemplateNeed => {
    if (need.type === 'connection') {
      return {
        key: need.key,
        title: need.title,
        description: need.description || kindOf(need),
        kind: 'connection',
        service: serviceOf(need),
        chosen: connected[need.key]?.shown,
        unavailable: services.status === 'ready' && !vendorOf(need.vendorId) ? 'Not offered here' : undefined,
        onChoose: () => setConnecting(need.key),
      }
    }
    const answer = answers[need.key]
    return {
      key: need.key,
      title: need.title,
      description: need.description || (need.type === 'agent' ? 'The model an agent it starts runs on' : need.kind === 'decision' ? 'A decision model' : 'An AI model it uses'),
      kind: need.type,
      models: models && modelsFor(need, models),
      chosen: answer && answer.type !== 'gatekeeper' ? answer.modelId : undefined,
      onChoose: (modelId) => setChosenModels((current) => ({
        ...current,
        [need.key]: need.type === 'agent' ? { type: 'agentSpawner', modelId } : { type: 'aiModel', modelId: modelId ?? '' },
      })),
    }
  })

  const make = async () => {
    if (connection?.blocked()) return false
    // Pipelined: named and read in the same round trip as it is made. Disposed by hand: `using` is
    // not lowered for every browser this runs in.
    const overseer = api.newWorkspaceFromBlueprint(template.id, answers)
    try {
      const [, made] = await Promise.all([overseer.setTitle(metadata.title), overseer.getMetadata()])
      if (made.defaultGadgetId === undefined) throw new Error('It was made without anything in it.')
      onMade({ workspaceId: made.id, gadgetId: made.defaultGadgetId, app: !metadata.output })
      return true
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  const kind = connectingNeed && kindOf(connectingNeed)
  return (
    <>
      <UseTemplateDialog
        open={open && !connectingNeed}
        onOpenChange={onOpenChange}
        title={metadata.title}
        creator={metadata.author.id === user.id ? undefined : metadata.author.name}
        needs={rows}
        onUse={make}
      />
      {connectingNeed && (
        <ConnectResource
          key={connectingNeed.key}
          open={open}
          // Put away, it comes back to the rest of what the template needs.
          onOpenChange={(next) => {
            if (!next) setConnecting(undefined)
          }}
          vendorId={connectingNeed.vendorId}
          name={serviceOf(connectingNeed).name}
          logoUrl={serviceOf(connectingNeed).logoUrl}
          resourceUrlPattern={connectingNeed.urlPattern}
          resourceUrl={connected[connectingNeed.key]?.assignment.resourceUrl ?? connectingNeed.resourceUrl}
          resource={connectingNeed.title}
          reason={connectingNeed.description || (kind ? `Choose which ${kind.toLowerCase()} “${metadata.title}” uses.` : undefined)}
          onConnect={async (accountId, resourceUrl) => {
            setConnected((current) => ({ ...current, [connectingNeed.key]: { assignment: { type: 'gatekeeper', accountId, resourceUrl }, shown: shortResource(resourceUrl) } }))
          }}
        />
      )}
    </>
  )
}
