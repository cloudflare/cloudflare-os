import { useEffect, useReducer, useState } from 'react'
import { FolderOpenIcon, LightningIcon, StackIcon, type Icon } from '@phosphor-icons/react'
import { useContextApi } from './bridge'
import { CollectionEditor } from './ContextLibraryPage'
import { CollectionPane } from './skills/CollectionPane'
import { SkillPane } from './skills/SkillPane'
import { SkillsHome } from './skills/SkillsHome'
import { currentView, navigate, previousView, START, type SkillsView } from './skills/skillsNavigation'
import { SkillStore, type SkillsState } from './skills/SkillStore'
import { SkillStoreContext, useSkillStore, useSkillsState } from './skills/useSkills'

type ViewerInfo = { isAdmin: boolean; supportsGitCollections: boolean }

/** What the way back to `view` says, and is drawn with, from what has been read of it. */
const backTo = (view: SkillsView, state: SkillsState): { label: string; icon: Icon } => {
  const ready = state.status === 'ready' ? state : undefined
  switch (view.page) {
    case 'home':
      return { label: 'Skills', icon: LightningIcon }
    case 'skill':
      return { label: ready?.skills.find(({ id }) => id === view.id)?.name ?? 'Skill', icon: LightningIcon }
    case 'collection':
      return { label: ready?.collections.find(({ id }) => id === view.id)?.title ?? 'Collection', icon: StackIcon }
    case 'documents':
      return { label: 'Documents', icon: FolderOpenIcon }
  }
}

const Pages = ({ viewer }: { viewer: ViewerInfo | undefined }) => {
  const state = useSkillsState()
  const [stack, dispatch] = useReducer(navigate, START)
  const view = currentView(stack)
  const back = backTo(previousView(stack) ?? START[0], state)
  const onBack = () => dispatch({ type: 'back' })
  const openSkill = (id: string) => dispatch({ type: 'open', view: { page: 'skill', id, tab: 'preview' } })
  const openCollection = (id: string) => dispatch({ type: 'open', view: { page: 'collection', id, tab: 'skills' } })

  switch (view.page) {
    case 'home':
      return <SkillsHome onOpenSkill={openSkill} onOpenCollection={openCollection} viewer={viewer} />
    case 'skill':
      return (
        <SkillPane
          // Its own page, so that why one could not be read is not said of the next.
          key={view.id}
          skillId={view.id}
          tab={view.tab}
          onTabChange={(tab) => dispatch({ type: 'change', view: { ...view, tab, file: undefined } })}
          file={view.file}
          onOpenFile={(file) => dispatch({ type: 'change', view: { ...view, file } })}
          back={back}
          onBack={onBack}
          onMoved={(id) => dispatch({ type: 'moved', from: view.id, to: id })}
          onOpenCollection={openCollection}
        />
      )
    case 'collection':
      return (
        <CollectionPane
          key={view.id}
          collectionId={view.id}
          tab={view.tab}
          onTabChange={(tab) => dispatch({ type: 'change', view: { ...view, tab } })}
          onOpenSkill={openSkill}
          back={back}
          onBack={onBack}
          onGone={() => dispatch({ type: 'home' })}
          onOpenDocuments={() => dispatch({ type: 'open', view: { page: 'documents', collectionId: view.id, path: null } })}
        />
      )
    case 'documents':
      return <Documents view={view} backLabel={back.label} onBack={onBack} onGone={() => dispatch({ type: 'home' })} onSelectPath={(path) => dispatch({ type: 'change', view: { ...view, path } })} />
  }
}

/** A collection's documents, after which the skills are read again, as they may have been changed there. */
const Documents = ({ view, backLabel, onBack, onGone, onSelectPath }: {
  view: Extract<SkillsView, { page: 'documents' }>
  backLabel: string
  onBack: () => void
  onGone: () => void
  onSelectPath: (path: string | null) => void
}) => {
  const store = useSkillStore()
  useEffect(() => () => void store.reload(), [store])
  return (
    <div className="min-h-0 flex-1 bg-kumo-base">
      <CollectionEditor collectionId={view.collectionId} selectedPath={view.path} onSelectPath={onSelectPath} backLabel={backLabel} onBack={onBack} onGone={onGone} />
    </div>
  )
}

/**
 * The Context Library's own app, as the Workshop opens it: the user's skills and the collections
 * they are kept and shared in (see `SkillStore`, read over the app's `ContextApi`), a page each,
 * gone between in the app itself (`skillsNavigation`), and every collection's documents, skills
 * or not, with its settings and Git tokens, from its page.
 */
export default function ContextApp() {
  const context = useContextApi()
  const [store] = useState(() => new SkillStore(context))
  const [viewer, setViewer] = useState<ViewerInfo>()
  useEffect(() => {
    void store.reload()
    // Without it, only collections of the user's own are offered to be made.
    context.getViewerInfo().then(setViewer, () => {})
  }, [store, context])

  return (
    <SkillStoreContext value={store}>
      <div className="flex h-full flex-col bg-kumo-base">
        <Pages viewer={viewer} />
      </div>
    </SkillStoreContext>
  )
}
