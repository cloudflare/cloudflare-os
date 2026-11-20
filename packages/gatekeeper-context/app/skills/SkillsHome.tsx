import { LightningIcon } from '@phosphor-icons/react'
import { HeaderBubble, PageLayout } from '@gadgets/ui'
import { SkillCollections, type SkillCollectionsProps } from './SkillCollections'
import { SkillLibrary, type SkillLibraryProps } from './SkillLibrary'

export type SkillsHomeProps = SkillLibraryProps & SkillCollectionsProps

/**
 * The app's first page: the skills the assistant loads when a task calls for them, listed as any
 * list in the Workshop is (`SkillLibrary`), each opening as its own page, then the collections
 * they are kept and shared in (`SkillCollections`), each with a page of its own too.
 */
export const SkillsHome = ({ onOpenSkill, skillHref, onOpenCollection, collectionHref, viewer }: SkillsHomeProps) => (
  <PageLayout
    header={(
      // The one bubble from page to page, which becomes the way back on the next.
      <HeaderBubble name="back">
        <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
          <LightningIcon aria-hidden="true" />
          Skills
        </h1>
      </HeaderBubble>
    )}
  >
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-12 pt-4 pb-12">
      <SkillLibrary onOpenSkill={onOpenSkill} skillHref={skillHref} />
      <SkillCollections onOpenCollection={onOpenCollection} collectionHref={collectionHref} viewer={viewer} />
    </div>
  </PageLayout>
)
