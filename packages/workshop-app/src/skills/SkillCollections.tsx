import { useState } from 'react'
import { PlusIcon } from '@phosphor-icons/react'
import { AddCollectionDialog } from '@/blocks/AddCollectionDialog'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SkillRow } from '@/blocks/SkillRow'
import { Button } from '@/components/Button'
import { ScrollArea } from '@/components/ScrollArea'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { collectionDetail } from './collectionList'
import { skillOwner } from './skillList'
import { skillStore, useSkillsState } from './useSkills'

export type SkillCollectionsProps = {
  onOpenCollection: (id: string) => void
  /** A collection's page, for its row to link to so that it can be opened in another tab. */
  collectionHref?: (id: string) => string
}

/**
 * The collections the user's skills are kept in, which are what the skills' tags name, listed
 * under the skills: each is shared whole, so this is where sharing starts. The user's own come
 * first, then those shared with them, then the organization's, each a row as a skill is, with how
 * many skills it has and who has it, and whose it is as a picture. A row opens the collection's
 * page. A new one is made empty, and opened, to add skills to and share.
 *
 * Shown only once the skills are read: until then, and where there are none to read, the list
 * above says why.
 */
export const SkillCollections = ({ onOpenCollection, collectionHref }: SkillCollectionsProps) => {
  const state = useSkillsState()
  const { user } = useApi()
  const connection = useConnectionNotice()
  const [making, setMaking] = useState(false)
  if (state.status !== 'ready') return null

  return (
    <SettingsGroup
      title="Collections"
      description="Skills kept together. A collection is shared with people as one."
      plain
      action={<Button icon={PlusIcon} onClick={() => setMaking(true)}>New collection</Button>}
    >
      {state.collections.length === 0
        ? <p className="px-5 text-center text-base text-kumo-subtle">No collections yet. Your first skill makes one.</p>
        : (
            <ScrollArea className="max-h-[min(30rem,60dvh)] rounded-3xl bg-kumo-tint">
              <ul aria-label="Collections" className="flex flex-col p-1.5">
                {state.collections.map((collection) => (
                  <li key={collection.id}>
                    <SkillRow
                      name={collection.title}
                      detail={collectionDetail(collection)}
                      owner={skillOwner(collection, user.name)}
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
          if (connection?.blocked()) return
          const id = await skillStore.addCollection(title, description)
          setMaking(false)
          onOpenCollection(id)
        }}
      />
    </SettingsGroup>
  )
}
