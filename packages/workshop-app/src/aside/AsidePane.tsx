import { SidePane } from '@/blocks/SidePane'
import type { AsideActions } from './AsideContext'
import type { AsideTabs } from './asideTabs'

export type AsidePaneProps = {
  /** What is open, if anything. */
  tabs?: AsideTabs
  actions: AsideActions
}

/** What is open beside the page, as the pane that shows it. */
export const AsidePane = ({ tabs, actions }: AsidePaneProps) => (
  <SidePane
    items={tabs?.items ?? []}
    activeKey={tabs?.activeKey}
    onSelect={actions.select}
    onCloseItem={actions.closeTab}
    onCloseAll={actions.closeAll}
    onHide={actions.hide}
  />
)
