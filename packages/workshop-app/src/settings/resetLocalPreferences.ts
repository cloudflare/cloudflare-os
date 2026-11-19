import { forgetPrefs } from '@/prefs/forgetPrefs'

/** Forgets what this browser keeps and starts the page over, since what is on it still has what it read. */
export const resetLocalPreferences = () => {
  forgetPrefs()
  window.location.reload()
}
