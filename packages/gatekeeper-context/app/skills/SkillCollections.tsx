import { useState } from 'react'
import { GitBranchIcon, PlusIcon, StackIcon } from '@phosphor-icons/react'
import { AddCollectionDialog } from './AddCollectionDialog'
import { Button, DropdownMenu, EmptyState, ScrollArea, SettingsGroup } from '@gadgets/ui'
import { CreateCollectionDialog } from './CreateCollectionDialog'
import { SkillRow } from './SkillRow'
import { collectionDetail } from './collectionList'
import { skillOwner, YOU } from './skillList'
import { useSkillStore, useSkillsState } from './useSkills'

export type SkillCollectionsProps = {
  onOpenCollection: (id: string) => void
  /** A collection's page, for its row to link to so that it can be opened in another tab. */
  collectionHref?: (id: string) => string
  /**
   * What the user may make besides a collection of their own: one everyone has, for an admin, and
   * one read from a Git repository, where the deployment has them. With either, there is a
   * second way to make one, with every choice the Context Library has.
   */
  viewer?: { isAdmin: boolean; supportsGitCollections: boolean }
}

/**
 * The collections the user's skills are kept in, which are what the skills' tags name, listed
 * under the skills: each is shared whole, so this is where sharing starts. The user's own come
 * first, then those shared with them, then the organization's, each a row as a skill is, with how
 * many skills it has and who has it, and whose it is as a picture. A row opens the collection's
 * page. A new one is made empty, and opened, to add skills to and share; one with more to it, such
 * as a Git source, is made with every choice the Context Library has (`CreateCollectionDialog`).
 *
 * Shown only once the skills are read: until then, and where there are none to read, the list
 * above says why.
 */
export const SkillCollections = ({ onOpenCollection, collectionHref, viewer }: SkillCollectionsProps) => {
  const skillStore = useSkillStore()
  const state = useSkillsState()
  const [making, setMaking] = useState(false)
  const [makingWithOptions, setMakingWithOptions] = useState(false)
  if (state.status !== 'ready') return null
  const moreToMake = viewer !== undefined && (viewer.isAdmin || viewer.supportsGitCollections)
  const newCollectionItems = moreToMake && (
    <>
      <DropdownMenu.Item icon={StackIcon} onSelect={() => setMaking(true)}>Collection of skills</DropdownMenu.Item>
      <DropdownMenu.Item icon={GitBranchIcon} onSelect={() => setMakingWithOptions(true)}>{viewer.supportsGitCollections ? (viewer.isAdmin ? 'From Git, or for everyone…' : 'From Git…') : 'For everyone…'}</DropdownMenu.Item>
    </>
  )

  return (
    <SettingsGroup
      title="Collections"
      description="Skills kept together. A collection is shared with people as one."
      plain
      // The empty state has it while there are none.
      action={state.collections.length === 0
        ? undefined
        : moreToMake
          ? (
              <DropdownMenu label="New collection" icon={PlusIcon} caret align="end" inPlace>
                {newCollectionItems}
              </DropdownMenu>
            )
          : <Button icon={PlusIcon} onClick={() => setMaking(true)}>New collection</Button>}
    >
      {state.collections.length === 0
        ? (
            <EmptyState
              size="section"
              tinted
              icon={StackIcon}
              title="No collections yet"
              description="A collection keeps skills together, to share with people as one. Your first skill makes one."
              actions={[moreToMake
                ? { label: 'New collection', icon: PlusIcon, menu: newCollectionItems }
                : { label: 'New collection', icon: PlusIcon, onClick: () => setMaking(true) }]}
            />
          )
        : (
            <ScrollArea className="max-h-[min(30rem,60dvh)] rounded-3xl bg-kumo-tint">
              <ul aria-label="Collections" className="flex flex-col p-1.5">
                {state.collections.map((collection) => (
                  <li key={collection.id}>
                    <SkillRow
                      name={collection.title}
                      detail={collectionDetail(collection)}
                      owner={skillOwner(collection, YOU)}
                      href={collectionHref?.(collection.id)}
                      onSelect={() => onOpenCollection(collection.id)}
                    />
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
      <AddCollectionDialog
        open={making}
        onOpenChange={setMaking}
        onAdd={async ({ title, description }) => {
          const id = await skillStore.addCollection(title, description)
          setMaking(false)
          onOpenCollection(id)
        }}
      />
      {makingWithOptions && viewer && (
        <CreateCollectionDialog viewerInfo={viewer} onCreated={() => void skillStore.reload()} onClose={() => setMakingWithOptions(false)} />
      )}
    </SettingsGroup>
  )
}
