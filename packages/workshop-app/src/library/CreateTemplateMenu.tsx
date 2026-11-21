import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { DropdownMenu, OptionPicker } from '@gadgets/ui'
import { FormatIcon } from '@/components/FormatIcon'
import { outputKey, outputTitle } from './libraryList'

export type CreateTemplateMenuProps = {
  /** The apps the user could make a template from (`ownApps`); left out until they are known. */
  apps?: OutputSummary[]
  /** Creates a template from the one chosen. Left out, choosing one only closes the menu. */
  onCreate?: (app: OutputSummary) => void
}

const NOTE = 'px-[calc(var(--menu-pad-x)+0.375rem)] py-4 text-(length:--menu-text) leading-(--menu-line) text-kumo-subtle'

/**
 * Create template, as the page's own button, which opens in place to the user's apps, each with its
 * type's icon, under a field to find one by. Choosing one starts creating a template from it.
 */
export const CreateTemplateMenu = ({ apps, onCreate }: CreateTemplateMenuProps) => (
  <DropdownMenu label="Create template" caret triggerVariant="primary" picker inPlace align="end">
    {(close) => {
      if (apps === undefined) return <p role="status" className={NOTE}>Loading your apps…</p>
      if (apps.length === 0) return <p className={NOTE}>Nothing to make a template from yet. The apps you make can be made into templates here.</p>
      return (
        <OptionPicker
          single
          aria-label="App to make a template from"
          options={apps.map((app) => ({ id: outputKey(app), label: outputTitle(app), icon: <FormatIcon name={app.output?.icon} className="size-5" /> }))}
          // None of them: they are all still to be chosen.
          value=""
          onValueChange={(key) => {
            const app = apps.find((other) => outputKey(other) === key)
            if (app) onCreate?.(app)
            close()
          }}
        />
      )
    }}
  </DropdownMenu>
)
