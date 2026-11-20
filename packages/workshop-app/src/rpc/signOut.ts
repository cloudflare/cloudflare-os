import { browserPushSupport, disableBrowserPush } from '@/notifications/browserPush'
import { readServerConfig } from './serverConfig'
import { clearToken } from './token'

/** Where signing out of Cloudflare Access goes, which ends its session too. */
const CF_ACCESS_LOGOUT = '/cdn-cgi/access/logout'

/**
 * Signs out of this device: the session's token is forgotten, this browser stops being sent the
 * account's notifications, which on a shared computer would show their chats to whoever is next,
 * and the app starts over from its first page, so that nothing the account had on screen or in
 * memory stays behind. Behind Cloudflare Access (`ServerConfig.authMode`), which would only sign
 * the user in again, it signs out of Access instead.
 */
export const signOut = async () => {
  clearToken()
  if (browserPushSupport() === 'supported') await disableBrowserPush().catch(() => {})
  // Read when the user signed in, so it is known here.
  const config = await readServerConfig()?.catch(() => undefined)
  window.location.assign(config?.authMode === 'cfAccess' ? CF_ACCESS_LOGOUT : '/')
}
