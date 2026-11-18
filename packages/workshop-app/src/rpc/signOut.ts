import { CF_ACCESS_LOGOUT, CF_ACCESS_MODE } from './cfAccess'
import { clearToken } from './token'

/**
 * Signs out of this device: the session's token is forgotten, and the app starts over from its
 * first page, so that nothing the account had on screen or in memory stays behind. Behind
 * Cloudflare Access, which would only sign the user in again, it signs out of Access instead.
 */
export const signOut = () => {
  clearToken()
  window.location.assign(CF_ACCESS_MODE ? CF_ACCESS_LOGOUT : '/')
}
