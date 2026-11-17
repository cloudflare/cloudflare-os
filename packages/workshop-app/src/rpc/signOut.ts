import { clearToken } from './token'

/**
 * Signs out of this device: the session's token is forgotten, and the app starts over from its
 * first page, so that nothing the account had on screen or in memory stays behind. Behind
 * Cloudflare Access there is no token, and signing out is ending the Access session.
 */
export const signOut = () => {
  clearToken()
  window.location.assign(import.meta.env.VITE_CF_ACCESS_MODE === 'true' ? '/cdn-cgi/access/logout' : '/')
}
