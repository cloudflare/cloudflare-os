import { Code, GearSix, PlugsConnected } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { AutomationIcon } from '../../components/icons/designIcons'
import { roundButtonClass } from '../../components/RoundButton'
import { AgentList } from '../automations/AgentList'
import { AutomationList } from '../automations/AutomationList'

/**
 * What an app with no screen of its own shows in its place: that it works behind the scenes, what
 * runs it (its automations, each with its switch) and the agents it starts, and the ways into
 * the rest of it. Many apps a chat builds only carry out an automation, so this is a view of the
 * app, not an empty state waiting for a UI.
 */
export function BackgroundAppOverview({ overseer, workspaceId, gadgetId, title, onShowCode, onShowConnections, onOpenSettings }: {
  overseer: RpcStub<Overseer>
  workspaceId: string
  gadgetId: WorkpieceId
  title: string
  onShowCode: () => void
  onShowConnections: () => void
  onOpenSettings: () => void
}) {
  return (
    <div className="h-full overflow-y-auto bg-kumo-base">
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-6 px-4 pb-10 pt-[12vh]">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-kumo-tint text-kumo-default" aria-hidden="true">
            <AutomationIcon size={20} />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="text-[18px] font-medium leading-[22px] text-kumo-default">Works behind the scenes</h2>
            <p className="max-w-[360px] text-[14px] leading-[18px] text-kumo-subtle">
              {title} has no screen of its own. Ask in the chat if you&rsquo;d like one.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <button type="button" onClick={onShowConnections} className={roundButtonClass('pill', 'h-[34px] !gap-1.5 !px-3 !text-[13px]')}>
              <PlugsConnected size={15} aria-hidden="true" /> Connections
            </button>
            <button type="button" onClick={onShowCode} className={roundButtonClass('pill', 'h-[34px] !gap-1.5 !px-3 !text-[13px]')}>
              <Code size={15} aria-hidden="true" /> Code
            </button>
            <button type="button" onClick={onOpenSettings} className={roundButtonClass('pill', 'h-[34px] !gap-1.5 !px-3 !text-[13px]')}>
              <GearSix size={15} aria-hidden="true" /> Settings
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <AutomationList overseer={overseer} scope={{ gadgetId }} />
          <AgentList overseer={overseer} workspaceId={workspaceId} gadgetIds={[gadgetId]} />
        </div>
      </div>
    </div>
  )
}
