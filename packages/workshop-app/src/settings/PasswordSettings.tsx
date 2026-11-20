import { useEffect, useState } from 'react'
import { PasswordForm } from '@/blocks/PasswordForm'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { hashPassword } from '@/rpc/passwordHash'
import { messageOf } from './useAttempt'

/** The user's password, which the Profile part ends with: changed here, or said to be someone else's to keep. */
export const PasswordSettings = () => {
  const { api, user, reconnecting } = useApi()
  const notice = useConnectionNotice()
  // Whether there is a password to change: not for an account signed in to through another service.
  const [hasPassword, setHasPassword] = useState<boolean>()

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` asks.
    if (reconnecting) return
    let cancelled = false
    api.hasPasswordLogin().then(
      (has) => {
        if (!cancelled) setHasPassword(has)
      },
      // Not known, so not offered.
      () => {
        if (!cancelled) setHasPassword((current) => current ?? false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])

  const changePassword = async (current: string, next: string) => {
    if (notice?.blocked()) return 'Not connected. Try again once the connection is back.'
    try {
      await api.changePassword(await hashPassword(user.id, current), await hashPassword(user.id, next))
    } catch (error) {
      return messageOf(error)
    }
  }

  return (
    <SettingsGroup title="Password">
      {hasPassword === undefined && <p role="status" className="appears-late py-4 text-kumo-subtle">Checking your sign-in method…</p>}
      {hasPassword === true && <PasswordForm onChange={changePassword} />}
      {hasPassword === false && (
        <SettingRow title="No password" description="You sign in through an identity provider, so there’s no password to change here." />
      )}
    </SettingsGroup>
  )
}
