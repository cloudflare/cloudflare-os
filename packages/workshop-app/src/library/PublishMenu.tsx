import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { DropdownMenu } from '@/components/DropdownMenu'
import { OptionPicker } from '@/components/OptionPicker'
import { FormatIcon } from '@/components/FormatIcon'
import { outputKey, outputTitle } from './libraryList'

export type PublishMenuProps = {
  /** The apps the user could publish (`ownApps`); left out until they are known. */
  apps?: OutputSummary[]
  /** Publishes the one chosen as a template. Left out, choosing one only closes the menu. */
  onPublish?: (app: OutputSummary) => void
}

const NOTE = 'px-[calc(var(--menu-pad-x)+0.375rem)] py-4 text-(length:--menu-text) leading-(--menu-line) text-kumo-subtle'

/**
 * Publish, as the page's own button, which opens in place to the user's apps, each with its type's
 * icon, under a field to find one by. Choosing one is publishing it.
 */
export const PublishMenu = ({ apps, onPublish }: PublishMenuProps) => (
  <DropdownMenu label="Publish" caret triggerVariant="primary" picker inPlace align="end">
    {(close) => {
      if (apps === undefined) return <p role="status" className={NOTE}>Loading your apps…</p>
      if (apps.length === 0) return <p className={NOTE}>Nothing to publish yet. The apps you make can be published here.</p>
      return (
        <OptionPicker
          single
          aria-label="App to publish"
          options={apps.map((app) => ({ id: outputKey(app), label: outputTitle(app), icon: <FormatIcon name={app.output?.icon} className="size-5" /> }))}
          // None of them: they are all still to be chosen.
          value=""
          onValueChange={(key) => {
            const app = apps.find((other) => outputKey(other) === key)
            if (app) onPublish?.(app)
            close()
          }}
        />
      )
    }}
  </DropdownMenu>
)
