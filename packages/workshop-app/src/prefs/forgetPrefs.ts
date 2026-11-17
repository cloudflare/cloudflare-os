// What every module here keeps its value under.
const PREFIX = 'workshop-app:'

/**
 * Forgets everything kept on this device between visits: the layout, how each list is looked at,
 * the stars and their order, the workspaces' icons, the theme. Nothing of the account, which the
 * server keeps. What is on the page still has what it read, so start the page over afterwards.
 */
export const forgetPrefs = () => {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    for (const key of keys) if (key?.startsWith(PREFIX)) localStorage.removeItem(key)
  } catch {
    // Nothing was kept.
  }
}
