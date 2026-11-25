import { useState } from 'react'
import { Select } from '@cloudflare/kumo'
import type { AdminResourceVendor } from '@gadgets/workshop-shared/api'

type Setting = NonNullable<AdminResourceVendor['settings']>[number]

/** A gatekeeper's own settings, each a select that a deployment admin chooses from. */
export const GatekeeperSettings = ({ vendorName, settings, saving, onChoose }: {
  /** The gatekeeper's name, which goes in each select's accessible name. */
  vendorName: string
  /** Every setting the gatekeeper declares, with the value in effect. */
  settings: Setting[]
  /** Whether a change to the gatekeeper is being saved. No pick is taken meanwhile. */
  saving: boolean
  /** Called with the option an admin picked for the setting `settingId`. */
  onChoose: (settingId: string, value: string) => void
}) => {
  // The setting whose pick is being saved. Its select stays enabled: focus returns to a select
  // when its list closes, and a disabled one drops it. Every other select is disabled until the
  // save ends, so that none takes a pick that is not saved.
  const [picked, setPicked] = useState<string>()
  if (!saving && picked !== undefined) setPicked(undefined)

  const shown = settings.filter(({ shownWhen }) => !shownWhen ||
    settings.find((setting) => setting.id === shownWhen.settingId)?.value === shownWhen.value)
  if (shown.length === 0) return null

  return (
    <div className="grid gap-4 px-3 pt-3">
      {shown.map((setting) => (
        <Select<string>
          key={setting.id}
          label={setting.label}
          aria-label={`${setting.label} for ${vendorName}`}
          description={setting.help}
          className="w-full sm:max-w-xs"
          disabled={saving && setting.id !== picked}
          value={setting.value}
          onValueChange={(value, { reason }) => {
            // Only a pick is the admin's. The select also reports changes of its own: to the
            // value it started with, when the stored value is not one of its options, and to an
            // option whose first letter is typed while it is closed.
            if (saving || reason !== 'item-press' || !value || value === setting.value) return
            setPicked(setting.id)
            onChoose(setting.id, value)
          }}
          // A stored value that the gatekeeper no longer offers shows as it is stored. The
          // gatekeeper refuses to work with it until an admin chooses again.
          renderValue={(value) =>
            setting.options.find((option) => option.value === value)?.label ??
              `${value} (no longer offered)`}
        >
          {setting.options.map((option) => (
            <Select.Option key={option.value} value={option.value}>{option.label}</Select.Option>
          ))}
        </Select>
      ))}
    </div>
  )
}
