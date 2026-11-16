// The same key the existing Workshop frontend uses, so after cutover (same origin) a signed-in user
// stays signed in.
const TOKEN_KEY = 'authToken'

export const readToken = () => localStorage.getItem(TOKEN_KEY)

export const storeToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)

export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// Set by signing out, so that development's auto-login (`VITE_DEV_AUTO_LOGIN`) does not sign
// straight back in as the dev account, and the sign-in form is shown, to sign in as someone else.
const SIGNED_OUT_KEY = 'devAutoLoginPaused'

/** Forgets the session in this browser, and keeps development's auto-login from undoing that. */
export const signOut = () => {
  clearToken()
  localStorage.setItem(SIGNED_OUT_KEY, 'true')
}

/** Whether whoever was signed in here signed out, rather than never having signed in. */
export const signedOutHere = () => localStorage.getItem(SIGNED_OUT_KEY) === 'true'

/** Lets development's auto-login sign in as the dev account again. */
export const resumeAutoLogin = () => localStorage.removeItem(SIGNED_OUT_KEY)
