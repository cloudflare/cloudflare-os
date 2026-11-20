import type { ReactNode } from 'react'
import { CaretLeftIcon, GearIcon } from '@phosphor-icons/react'
import { SettingsMenu } from '@/blocks/SettingsMenu'
import { Button, HeaderBubble, PageLayout, useNarrowScreen } from '@gadgets/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useApi } from '@/rpc/ApiContext'
import { AdminAccessSettings } from './admin/AdminAccessSettings'
import { AdminAuditSettings } from './admin/AdminAuditSettings'
import { AdminProvider } from './admin/AdminContext'
import { AdminFormatSettings } from './admin/AdminFormatSettings'
import { AdminGeneralSettings } from './admin/AdminGeneralSettings'
import { AdminModelSettings } from './admin/AdminModelSettings'
import { AdminServiceSettings } from './admin/AdminServiceSettings'
import { AdminUpdateSettings } from './admin/AdminUpdateSettings'
import { useIsAdmin } from './admin/useIsAdmin'
import { AdvancedSettings } from './AdvancedSettings'
import { ApprovalSettings } from './ApprovalSettings'
import { CollaborationSettings } from './CollaborationSettings'
import { ModelSettings } from './ModelSettings'
import { NotificationSettings } from './NotificationSettings'
import { PreferenceSettings } from './PreferenceSettings'
import { ProfileSettings } from './ProfileSettings'
import { SecuritySettings } from './SecuritySettings'
import { FIRST_SECTION, isAdminSection, sectionInfo, settingsNavGroups, type SettingsSection } from './settingsSections'
import { UsageSettings } from './UsageSettings'
import { useOwnAvatar } from './useOwnAvatar'
import { signOut } from '@/rpc/signOut'

export type SettingsPaneProps = {
  /** The part the address names, or none. */
  section?: SettingsSection
  /**
   * A part was gone into from the list of them, or, with none, the way back to the list was
   * taken. Only on a narrow screen, where the list is the page.
   */
  onSectionChange: (section: SettingsSection | undefined) => void
  /** A part's address, so that it can be opened in another tab. */
  sectionHref?: (section: SettingsSection) => string
}

/**
 * The user's settings, a part at a time. Where there is room for a sidebar, the parts are listed
 * there in place of the app's own (`SettingsSidebar`, which the frame draws), and the page is the
 * one that is showing, the first of them where none is named. On a narrow screen there is room
 * for one thing at a time: the list of the parts is the page, and a part is gone into from it,
 * with the way back at the start of its header.
 */
export const SettingsPane = ({ section, onSectionChange, sectionHref }: SettingsPaneProps) => {
  const { user } = useApi()
  const avatarUrl = useOwnAvatar()
  const narrow = useNarrowScreen()
  const admin = useIsAdmin()
  // The deployment's parts are only an admin's: anyone else named one is shown the first of their
  // own, once the server has said which they are.
  const named = section && isAdminSection(section) && admin === false ? undefined : section
  const shown = narrow ? named : (named ?? FIRST_SECTION)
  const info = shown && sectionInfo(shown)
  useDocumentTitle(info ? `${info.label} · Settings` : 'Settings')

  const parts: Record<SettingsSection, ReactNode> = {
    profile: <ProfileSettings />,
    security: <SecuritySettings />,
    usage: <UsageSettings />,
    models: <ModelSettings />,
    approvals: <ApprovalSettings />,
    preferences: <PreferenceSettings />,
    notifications: <NotificationSettings />,
    collaboration: <CollaborationSettings />,
    advanced: <AdvancedSettings />,
    'admin-general': <AdminGeneralSettings />,
    'admin-services': <AdminServiceSettings />,
    'admin-formats': <AdminFormatSettings />,
    'admin-models': <AdminModelSettings />,
    'admin-access': <AdminAccessSettings />,
    'admin-audit': <AdminAuditSettings />,
    'admin-updates': <AdminUpdateSettings />,
  }

  // What the page is, which its header says and nothing under it repeats: the part that is
  // showing, or the settings, where the page is the list of them.
  const Glyph = info?.icon ?? GearIcon
  const name = (
    // The one bubble from part to part, which grows or shrinks to the next one's name.
    <HeaderBubble name="settings">
      <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
        <Glyph aria-hidden="true" />
        {info?.label ?? 'Settings'}
      </h1>
    </HeaderBubble>
  )

  return (
    // Held across the parts, so that a visit is one admin session in the audit log.
    <AdminProvider enabled={admin === true}>
      <PageLayout
        header={narrow && info
          ? (
              // Gone into from the list, which the way back is to, before what it is.
              <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
                <HeaderBubble>
                  <Button icon={CaretLeftIcon} aria-label="Back to Settings" onClick={() => onSectionChange(undefined)} />
                </HeaderBubble>
                {name}
              </nav>
            )
          : name}
      >
        {info
          ? (
              // Another part is another page, cut to.
              <div key={info.id} className="mx-auto flex w-full max-w-3xl flex-col gap-12 pt-4 pb-12">
                {isAdminSection(info.id) && !admin
                  ? <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading…</p>
                  : parts[info.id]}
              </div>
            )
          : (
              <SettingsMenu
                user={{ name: user.name, detail: user.id === user.name ? undefined : user.id, avatarUrl }}
                groups={settingsNavGroups(sectionHref, admin)}
                // The ids are the parts' own, which the block knows only as strings.
                onSelect={(id) => onSectionChange(id as SettingsSection)}
                onSignOut={signOut}
              />
            )}
      </PageLayout>
    </AdminProvider>
  )
}
