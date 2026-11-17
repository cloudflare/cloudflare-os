import { clearToken } from './token'

/**
 * Signs out of this device: the session's token is forgotten, and the app starts over from its
 * first page, so that nothing the account had on screen or in memory stays behind.
 */
export const signOut = () => {
  clearToken()
  window.location.assign('/')
}
