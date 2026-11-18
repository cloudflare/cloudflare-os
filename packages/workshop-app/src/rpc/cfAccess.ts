/**
 * Built for a deployment behind Cloudflare Access (`VITE_CF_ACCESS_MODE=true`), as
 * `workshop-frontend` is for one: Access has signed the user in before the page could load, so the
 * app signs in as whoever Access says (`PublicApi.authenticateFromCfAccess`), never shows the
 * sign-in page, and signs out of Access when the user signs out. `ServerConfig` does not say it,
 * so it is the build's to know.
 */
export const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

/** Where signing out of Access goes, which ends its session too. */
export const CF_ACCESS_LOGOUT = '/cdn-cgi/access/logout'
