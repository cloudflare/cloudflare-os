import { useMemo, useState } from 'react'
import {
  ArrowSquareOutIcon, BookmarkSimpleIcon, CaretLeftIcon, CubeIcon, DotsThreeIcon, DownloadSimpleIcon, LinkIcon, RobotIcon, SparkleIcon, WarningCircleIcon,
} from '@phosphor-icons/react'
import { BlueprintNeedRow } from '@/blocks/BlueprintNeedRow'
import { BlueprintPicture } from '@/blocks/BlueprintTile'
import { PaneNotice } from '@/blocks/PaneNotice'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { FormatIcon } from '@/components/FormatIcon'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useServices } from '@/connections/useServices'
import { fileNameOf, saveStream } from '@/files/saveFile'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { formatActivity } from '@/workspaces/formatActivity'
import { needsOf } from './blueprintNeeds'
import { UseBlueprint, type MadeGadget } from './UseBlueprint'
import { useBlueprint, usePublicApi } from './useBlueprints'

export type BlueprintPaneProps = {
  blueprintId: string
  onBack: () => void
  /** A gadget was made from it: show it. */
  onMade: (made: MadeGadget) => void
  /** Opens the workspace the user published it from. */
  onOpenWorkspace: (workspaceId: string) => void
  /** Its own address, for Copy link. */
  link: string
  /** Use was asked for on the way here, as from Home: it opens at once. */
  initialUse?: boolean
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// As a phrase: "Updated 3 hours ago", "Updated yesterday", "Updated on Aug 1".
const updated = (when: Date) => {
  const at = formatActivity(when)
  return /^(Just now|Yesterday)$|ago$/.test(at) ? `Updated ${at.toLowerCase()}` : `Updated on ${at}`
}

/**
 * A blueprint on a page of its own, as it is shared: its picture, its name, who published it and
 * when, what it is for, and what it needs, each with its service's logo. Use makes a gadget of the
 * user's own from it (`UseBlueprint`); Save keeps it in their Library's Blueprints; More copies
 * its link and saves its file, which another deployment can take in.
 */
export const BlueprintPane = ({ blueprintId, onBack, onMade, onOpenWorkspace, link, initialUse = false }: BlueprintPaneProps) => {
  const { state, setSaved } = useBlueprint(blueprintId)
  const publicApi = usePublicApi()
  const { services } = useServices()
  const connection = useConnectionNotice()
  const [using, setUsing] = useState(initialUse)
  const [problem, setProblem] = useState<string>()
  const blueprint = state.status === 'ready' ? state.blueprint : undefined
  const needs = useMemo(() => (blueprint ? needsOf(blueprint.metadata) : []), [blueprint])
  useDocumentTitle(blueprint?.metadata.title ?? 'Blueprint')

  const serviceOf = (vendorId: string) => {
    const vendor = services.status === 'ready' ? services.vendors.find(({ id }) => id === vendorId) : undefined
    return vendor && {
      service: { name: vendor.description.displayName, logoUrl: vendor.description.logo?.url, color: vendor.description.color },
      kinds: vendor.supportedResources,
    }
  }

  const act = (doing: string, run: () => Promise<unknown>) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    run().catch((error: unknown) => setProblem(`Couldn’t ${doing}: ${messageOf(error)}`))
  }

  const header = (
    <>
      <HeaderBubble>
        <Button icon={CaretLeftIcon} onClick={onBack}>Blueprints</Button>
      </HeaderBubble>
      {blueprint && (
        <>
          <HeaderBubble className="ms-auto">
            <DropdownMenu icon={DotsThreeIcon} aria-label="More" align="end">
              <DropdownMenu.Item icon={LinkIcon} onSelect={() => navigator.clipboard.writeText(link).catch(() => {})}>Copy link</DropdownMenu.Item>
              {publicApi && (
                <DropdownMenu.Item
                  icon={DownloadSimpleIcon}
                  onSelect={() => act('save its file', () => saveStream(() => publicApi.downloadBlueprint(blueprint.id), {
                    name: `${fileNameOf(blueprint.metadata.title, 'blueprint')}-v${blueprint.metadata.version}.gadget`,
                    contentType: 'application/octet-stream',
                    extension: '.gadget',
                    description: 'Gadget blueprint',
                  }))}
                >
                  Download file
                </DropdownMenu.Item>
              )}
              {blueprint.source?.type === 'workspace' && (
                <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => blueprint.source?.type === 'workspace' && onOpenWorkspace(blueprint.source.workspaceId)}>
                  Open its workspace
                </DropdownMenu.Item>
              )}
            </DropdownMenu>
          </HeaderBubble>
          {!blueprint.source && (
            <HeaderBubble>
              <Button
                icon={<BookmarkSimpleIcon weight={blueprint.saved ? 'fill' : 'regular'} />}
                aria-pressed={blueprint.saved !== undefined}
                className="max-sm:w-9 max-sm:p-0"
                onClick={() => act(blueprint.saved ? 'take it out of your Library' : 'save it', () => setSaved(!blueprint.saved))}
              >
                {/* Its mark alone on a phone, where the header has room for Use only beside it. */}
                <span className="max-sm:sr-only">{blueprint.saved ? 'Saved' : 'Save'}</span>
              </Button>
            </HeaderBubble>
          )}
          <HeaderBubble>
            <Button variant="primary" icon={SparkleIcon} onClick={() => setUsing(true)}>Use blueprint</Button>
          </HeaderBubble>
        </>
      )}
    </>
  )

  if (state.status !== 'ready' || !blueprint) {
    return (
      <PageLayout header={header}>
        <div className="flex min-h-[60vh] flex-col">
          {state.status === 'gone' && <PaneNotice icon={WarningCircleIcon} title="This blueprint isn’t here" description="It may have been deleted, or the link is wrong." />}
          {state.status === 'failed' && <PaneNotice icon={WarningCircleIcon} title="Couldn’t load this blueprint" description={state.message} />}
          {state.status === 'loading' && <PaneNotice title="Loading the blueprint…" />}
        </div>
      </PageLayout>
    )
  }

  const { metadata } = blueprint
  const byline = [blueprint.source ? 'By you' : `By ${metadata.author.name}`, updated(metadata.lastUpdated)].join(' · ')
  return (
    <PageLayout header={header}>
      <div className="appears mx-auto flex w-full max-w-3xl flex-col gap-8 pt-4 pb-8">
        <BlueprintPicture
          picture={blueprint.screenshotUrl}
          icon={<FormatIcon name={metadata.output?.icon} />}
          label={metadata.output?.noun ?? 'App'}
          size="lg"
          className="rounded-[28px] ring-1 ring-kumo-contrast/6"
        />
        <div className="flex flex-col items-center gap-2 px-4 text-center">
          <h1 className="text-xl font-medium text-balance text-kumo-default">{metadata.title || 'Untitled blueprint'}</h1>
          <p className="text-base/5 text-kumo-subtle">{byline}</p>
          {metadata.description && <p className="mt-2 max-w-xl text-base/6 text-pretty text-kumo-default">{metadata.description}</p>}
          {problem && <p role="alert" className="mt-2 text-base text-kumo-danger">{problem}</p>}
        </div>
        <section className="flex flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">What it needs</h2>
          {needs.length === 0 ? (
            <p className="rounded-3xl bg-kumo-tint px-5 py-4 text-base/6 text-kumo-default">Nothing. It works as it is, the moment you use it.</p>
          ) : (
            <div className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
              {needs.map((need) => {
                const found = need.type === 'connection' ? serviceOf(need.vendorId) : undefined
                const kind = need.type === 'connection' ? found?.kinds.find(({ urlPattern }) => urlPattern === need.urlPattern)?.title : undefined
                return (
                  <BlueprintNeedRow
                    key={need.key}
                    title={need.title}
                    service={need.type === 'connection' ? found?.service ?? { name: need.vendorId } : undefined}
                    icon={need.type === 'agent' ? <RobotIcon /> : <CubeIcon />}
                    detail={need.description || (need.type === 'connection'
                      ? [found?.service.name, kind].filter(Boolean).join(' · ')
                      : need.type === 'agent' ? 'One of your models, for an agent it starts' : 'One of your AI models')}
                  />
                )
              })}
            </div>
          )}
          {needs.length > 0 && <p className="px-4 text-sm/5 text-pretty text-kumo-subtle">You set each up with your own accounts and models when you use it. Nothing of whoever published it comes with it.</p>}
        </section>
      </div>
      <UseBlueprint blueprint={blueprint} open={using} onOpenChange={setUsing} onMade={onMade} />
    </PageLayout>
  )
}
