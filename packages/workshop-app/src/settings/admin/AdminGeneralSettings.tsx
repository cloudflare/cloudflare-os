import { useState } from 'react'
import {
  BANNER_COLORS,
  DEFAULT_SITE_NAME,
  MAX_ANNOUNCEMENT_LENGTH,
  MAX_INSTANCE_INSTRUCTIONS_LENGTH,
  MAX_SITE_NAME_LENGTH,
  type BannerColor,
} from '@gadgets/workshop-shared/api'
import { AccentColorMenu, type AccentColorPreset } from '@/blocks/AccentColorMenu'
import { RestrictedWebFetch } from '@/blocks/RestrictedWebFetch'
import { SettingField, type SaveOutcome } from '@/blocks/SettingField'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SettingText } from '@/blocks/SettingText'
import { SiteLogoPicker } from '@/blocks/SiteLogoPicker'
import { Select } from '@/components/Select'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { messageOf, useAttempt } from '../useAttempt'
import { AdminSettingsStatus } from './AdminSettingsStatus'
import { cacheBustSiteLogoUrl, prepareSiteLogo } from './siteLogo'
import { useAdminSettings } from './useAdminSettings'

/** The app's own accent, which the deployment's is kept as `''` for. */
const DEFAULT_ACCENT_COLOR = '#ff4801'

// Main's presets, the app's own first.
const ACCENT_PRESETS: AccentColorPreset[] = [
  { label: 'Default', value: '' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Green', value: '#16a34a' },
  { label: 'Purple', value: '#7c3aed' },
  { label: 'Pink', value: '#db2777' },
  { label: 'Teal', value: '#0d9488' },
]

const BANNER_COLOR_OPTIONS = BANNER_COLORS.map((color) => ({ id: color, label: color.charAt(0).toUpperCase() + color.slice(1) }))

const tooLong = (text: string, most: number) => text.length > most ? `That’s ${text.length - most} characters too many.` : undefined

/**
 * What the deployment is called and looks like to everyone on it, what it tells them across the
 * top of the app, what every agent is told, and what an agent may fetch from the web once it has
 * read restricted data. Each applies to a person the next time they connect.
 */
export const AdminGeneralSettings = () => {
  const { admin: capability, state, change, show } = useAdminSettings()
  const { problem, attempt } = useAttempt()
  const notice = useConnectionNotice()
  const [savingLogo, setSavingLogo] = useState(false)
  // The logo's address as last saved here, with a token of its own, so that the new one is loaded
  // rather than the one the browser has under the same address.
  const [logoShown, setLogoShown] = useState<string | null>()

  // A field keeps what could not be saved, under why; nothing is tried while the connection is down.
  const save = async (action: () => Promise<unknown>): Promise<SaveOutcome> => {
    if (notice?.blocked()) return { saved: false }
    try {
      await action()
      return { saved: true }
    } catch (error) {
      return { saved: false, problem: messageOf(error) }
    }
  }

  const setLogo = async (what: string, data: () => Promise<Uint8Array | null>) => {
    setSavingLogo(true)
    await attempt(what, async () => {
      if (!capability) throw new Error('Not connected yet.')
      const kept = await capability.setSiteLogo(await data())
      setLogoShown(kept ? cacheBustSiteLogoUrl(kept.url) : null)
    })
    setSavingLogo(false)
  }

  return (
    <AdminSettingsStatus state={state}>
      {(view) => (
        <>
          {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
          <SettingsGroup title="Branding">
            <SettingField
              title="Site name"
              description={`Shown beside the logo. Leave empty for “${DEFAULT_SITE_NAME}”.`}
              value={view.siteName}
              optional
              placeholder={DEFAULT_SITE_NAME}
              onSave={(name) => save(async () => {
                const over = tooLong(name, MAX_SITE_NAME_LENGTH)
                if (over) throw new Error(over)
                await change((shown) => ({ ...shown, siteName: name }), (admin) => admin.setSiteName(name))
              })}
            />
            <SettingRow title="Logo" description="Shown in the app, on the sign-in page and in the browser’s tab. Scaled without cropping to a still PNG. Square images work best.">
              <SiteLogoPicker
                src={logoShown === undefined ? view.siteLogo?.url : (logoShown ?? undefined)}
                busy={savingLogo}
                onChoose={(file) => void setLogo('change the logo', () => prepareSiteLogo(file))}
                onRestore={() => void setLogo('restore the default logo', async () => null)}
              />
            </SettingRow>
            <SettingRow title="Accent color" description="The color of buttons, links and highlights. Backgrounds keep the default theme.">
              <AccentColorMenu
                value={view.accentColor}
                presets={ACCENT_PRESETS}
                defaultColor={DEFAULT_ACCENT_COLOR}
                onChange={(color) => void attempt('change the accent color', () =>
                  change((shown) => ({ ...shown, accentColor: color }), (admin) => admin.setAccentColor(color)))}
              />
            </SettingRow>
          </SettingsGroup>
          <SettingsGroup title="Notices">
            <SettingText
              title="Banner"
              description="A bar across the very top of the app, signed in or not, which can be put away. Markdown, so it can link. Leave empty for none."
              value={view.banner.text}
              placeholder="New: templates can be imported. [Learn more](https://example.com)"
              maxLength={MAX_ANNOUNCEMENT_LENGTH}
              onSave={(text) => save(() => change((shown) => ({ ...shown, banner: { ...shown.banner, text } }), (admin) => admin.setBanner(text, view.banner.color)))}
            />
            <SettingRow title="Banner color" description="What kind of news the banner is.">
              <Select<BannerColor>
                aria-label="Banner color"
                value={view.banner.color}
                options={BANNER_COLOR_OPTIONS}
                onValueChange={(color) => void attempt('change the banner’s color', () =>
                  change((shown) => ({ ...shown, banner: { ...shown.banner, color } }), (admin) => admin.setBanner(view.banner.text, color)))}
              />
            </SettingRow>
            <SettingText
              title="Top-bar notice"
              description="Shown in the middle of the top bar, on one line, so keep it short. Markdown, so it can link. Leave empty for none."
              value={view.announcement}
              placeholder="Maintenance on Saturday. See [status](https://status.example.com)."
              maxLength={MAX_ANNOUNCEMENT_LENGTH}
              onSave={(text) => save(() => change((shown) => ({ ...shown, announcement: text }), (admin) => admin.setAnnouncement(text)))}
            />
          </SettingsGroup>
          <SettingsGroup title="Agents">
            <SettingText
              title="Agent instructions"
              description="Added to what every agent on this deployment is told: what it should know of the organization, its conventions and its limits."
              value={view.instanceInstructions}
              rows={6}
              placeholder="ACME Corp is a logistics company that helps small businesses ship internationally."
              maxLength={MAX_INSTANCE_INSTRUCTIONS_LENGTH}
              onSave={(text) => save(() => change((shown) => ({ ...shown, instanceInstructions: text }), (admin) => admin.setInstanceInstructions(text)))}
            />
          </SettingsGroup>
          <RestrictedWebFetch
            hosts={view.restrictedWebFetchHosts}
            onHostsChange={(hosts) => attempt('change the trusted hosts', async () => {
              let kept = hosts
              await change((shown) => ({ ...shown, restrictedWebFetchHosts: hosts }), async (admin) => {
                kept = await admin.setRestrictedWebFetchHosts(hosts)
              })
              // As the server keeps them, which may be written otherwise.
              show((shown) => ({ ...shown, restrictedWebFetchHosts: kept }))
            })}
            approvals={view.restrictedWebFetchApprovals}
            onApprovalsChange={(enabled) => void attempt(enabled ? 'let people approve other addresses' : 'stop people approving other addresses', () =>
              change((shown) => ({ ...shown, restrictedWebFetchApprovals: enabled }), (admin) => admin.setRestrictedWebFetchApprovals(enabled)))}
          />
        </>
      )}
    </AdminSettingsStatus>
  )
}
