import { useEffect, useMemo, useState } from 'react'
import { KeyIcon, SignOutIcon, UserCircleIcon } from '@phosphor-icons/react'
import type { CloudflareUsageInfo } from '@gadgets/workshop-shared/api'
import { ChangePasswordDialog } from '@/blocks/ChangePasswordDialog'
import { MenuChooser } from '@/blocks/MenuChooser'
import { ProfilePicture } from '@/blocks/ProfilePicture'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { useModels } from '@/chat/useModels'
import { Button } from '@/components/Button'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { compressPicture } from './compressPicture'
import { useProfile } from './ProfileContext'
import { allowanceOf, formatCost, spendDetail, spendSummary } from './usage'

export type ProfilePaneProps = {
  /** Forgets this browser's sign-in. */
  onSignOut: () => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The signed-in user's profile, from the account menu: their picture, changed or taken away from
 * its camera; their name, renamed in place, as others see it; then, as settings, the model a new
 * chat starts with, what their AI has cost (and, where the
 * deployment limits use, today's free allowance), their password, and signing out.
 */
export const ProfilePane = ({ onSignOut }: ProfilePaneProps) => {
  const { api, reconnecting } = useApi()
  const { profile, snapshot } = useProfile()
  const { models, prefer } = useModels()
  const workspaces = useWorkspaces()
  const connection = useConnectionNotice()
  const { user, picture, hasPassword } = snapshot
  const [problem, setProblem] = useState<string>()
  const [picturePending, setPicturePending] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [usage, setUsage] = useState<CloudflareUsageInfo>()
  useDocumentTitle('Profile')

  useEffect(() => {
    if (reconnecting) return
    let current = true
    // Only a deployment that limits use says more than what the workspaces cost.
    api.getCloudflareUsage().then((read) => { if (current) setUsage(read) }, () => {})
    return () => {
      current = false
    }
  }, [api, reconnecting])

  const spend = useMemo(() => (workspaces.status === 'ready' ? spendSummary(workspaces.workspaces) : undefined), [workspaces])
  const allowance = usage && allowanceOf(usage)

  const act = (doing: string, run: () => Promise<unknown>) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    run().catch((error: unknown) => setProblem(`Couldn’t ${doing}: ${messageOf(error)}`))
  }

  const header = (
    <HeaderBubble>
      <h1 className="flex h-9 items-center gap-2 rounded-full bg-kumo-base pr-4 pl-3 text-base font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
        <UserCircleIcon aria-hidden="true" />
        Profile
      </h1>
    </HeaderBubble>
  )

  const defaultModel = models.status === 'ready' ? models.offered.find(({ id }) => id === models.preferred) ?? models.offered[0] : undefined
  return (
    <PageLayout header={header}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-3 pt-8 text-center">
          <ProfilePicture
            name={user.name}
            picture={picture}
            pending={picturePending}
            onChoose={(file) => {
              setProblem(undefined)
              if (connection?.blocked()) return
              setPicturePending(true)
              compressPicture(file)
                .then((bytes) => profile.setPicture(bytes))
                .catch((error: unknown) => setProblem(`Couldn’t change your picture: ${messageOf(error)}`))
                .finally(() => setPicturePending(false))
            }}
            onRemove={picture ? () => act('take your picture away', () => profile.setPicture(null)) : undefined}
          />
          <div className="flex flex-col items-center gap-0.5">
            <h2 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
              <EditableTitle value={user.name} aria-label="Your name" placeholder="Your name" className="text-center" onRename={(name) => act('rename you', () => profile.rename(name))} />
            </h2>
            <p className="text-base/5 text-kumo-subtle">Signed in as {user.id}</p>
          </div>
          {problem && <p role="alert" className="text-base text-kumo-danger">{problem}</p>}
        </div>

        <section className="flex flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">Chats</h2>
          <SettingsGroup label="Chats">
            <SettingsRow
              title="Default model"
              description="What a new chat starts with. A chat can choose another from its + menu."
              control={models.status === 'ready' && models.offered.length > 0 ? (
                <MenuChooser
                  label="Default model"
                  choices={models.offered}
                  value={defaultModel?.id}
                  onChoose={(id) => { if (id) act('make it your default', () => prefer(id)) }}
                />
              ) : (
                <span className="text-sm text-kumo-subtle">{models.status === 'loading' ? 'Loading…' : models.status === 'failed' ? 'Couldn’t load your models' : 'You have no models'}</span>
              )}
            />
          </SettingsGroup>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">Usage</h2>
          <SettingsGroup label="Usage">
            <SettingsRow
              title="AI spend"
              description={spend ? spendDetail(spend) : 'Adding up what your workspaces have cost…'}
              control={spend && <span className="text-lg font-medium text-kumo-default tabular-nums">{formatCost(spend.total)}</span>}
            />
            {allowance && (
              <SettingsRow
                title="Free allowance"
                description={(
                  <>
                    {allowance.detail}
                    {allowance.account && <><br />{allowance.account}</>}
                  </>
                )}
                control={(
                  <span
                    role="meter"
                    aria-label="Free allowance used today"
                    aria-valuemin={0}
                    aria-valuemax={allowance.limit}
                    aria-valuenow={allowance.used}
                    className="block h-1.5 w-28 overflow-hidden rounded-full bg-kumo-contrast/8"
                  >
                    <span className="block h-full rounded-full bg-kumo-contrast" style={{ width: `${Math.min(100, (allowance.used / Math.max(1, allowance.limit)) * 100)}%` }} />
                  </span>
                )}
              />
            )}
          </SettingsGroup>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">Signing in</h2>
          <SettingsGroup label="Signing in">
            {hasPassword && (
              <SettingsRow
                title="Password"
                description="Change the password you sign in with."
                control={<Button icon={KeyIcon} onClick={() => setChangingPassword(true)}>Change</Button>}
              />
            )}
            <SettingsRow
              title="Sign out"
              description="Forget your sign-in on this browser. Your workspaces stay as they are."
              control={<Button icon={SignOutIcon} onClick={onSignOut}>Sign out</Button>}
            />
          </SettingsGroup>
        </section>
      </div>
      <ChangePasswordDialog
        open={changingPassword}
        onOpenChange={setChangingPassword}
        onChange={async (current, next) => {
          if (connection?.blocked()) return false
          await profile.changePassword(current, next)
          return true
        }}
      />
    </PageLayout>
  )
}
