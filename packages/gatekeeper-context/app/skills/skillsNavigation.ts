// Where the app is, and how it got there. It has no address to keep this in: it runs in a sandboxed
// `srcdoc` frame, whose location the Workshop owns, so each page is a view on a stack, and the way
// back is the one under it.

/** What a skill's page shows beneath its name, when not one of its files. */
export type SkillTab = 'preview' | 'files' | 'settings'

/** What a collection's page shows beneath its name. */
export type CollectionTab = 'skills' | 'settings'

/** A page of the app. */
export type SkillsView =
  /** The skills, and under them the collections they are kept in. */
  | { page: 'home' }
  /** One skill, on one of its tabs, or showing one of its files (by its path) in a tab of its own. */
  | { page: 'skill'; id: string; tab: SkillTab; file?: string }
  | { page: 'collection'; id: string; tab: CollectionTab }
  /** Everything in a collection, skills or not, as folders and documents, and the document at `path`. */
  | { page: 'documents'; collectionId: string; path: string | null }

/** The pages gone through to get here, the first always `home` and the last the one showing. */
export type Navigation = readonly SkillsView[]

export type NavigationAction =
  /** Goes to another page, which the way back from it returns from. */
  | { type: 'open'; view: SkillsView }
  /** Shows the page another way, such as on another tab, with the same way back. */
  | { type: 'change'; view: SkillsView }
  /** Goes back to the page under this one. */
  | { type: 'back' }
  /** Goes back to the first page, as when what the pages were of is gone. */
  | { type: 'home' }
  /** A skill was renamed or filed elsewhere, which gives it another id: every page of it follows. */
  | { type: 'moved'; from: string; to: string }

export const START: Navigation = [{ page: 'home' }]

const same = (a: SkillsView, b: SkillsView) => JSON.stringify(a) === JSON.stringify(b)

export const navigate = (stack: Navigation, action: NavigationAction): Navigation => {
  switch (action.type) {
    case 'open':
      // Going to the page that is showing is staying on it.
      return same(stack.at(-1)!, action.view) ? stack : [...stack, action.view]
    case 'change':
      return stack.length === 1 && action.view.page !== 'home' ? [...stack, action.view] : [...stack.slice(0, -1), action.view]
    case 'back':
      return stack.length > 1 ? stack.slice(0, -1) : stack
    case 'home':
      return START
    case 'moved':
      return stack.map((view) => (view.page === 'skill' && view.id === action.from ? { ...view, id: action.to } : view))
  }
}

/** The page showing. */
export const currentView = (stack: Navigation) => stack.at(-1)!

/** The page the way back goes to, where there is one. */
export const previousView = (stack: Navigation): SkillsView | undefined => stack.at(-2)
