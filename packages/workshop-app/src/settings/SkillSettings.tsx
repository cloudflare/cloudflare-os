import { SkillCollections, type SkillCollectionsProps } from '@/skills/SkillCollections'
import { SkillLibrary, type SkillLibraryProps } from '@/skills/SkillLibrary'

export type SkillSettingsProps = SkillLibraryProps & SkillCollectionsProps

/**
 * The skills the assistant loads when a task calls for them, listed as any list in the app is
 * (`SkillLibrary`), each opening as its own page, then the collections they are kept and shared
 * in (`SkillCollections`), each with a page of its own too.
 */
export const SkillSettings = ({ onOpenSkill, skillHref, onOpenCollection, collectionHref }: SkillSettingsProps) => (
  <>
    <SkillLibrary onOpenSkill={onOpenSkill} skillHref={skillHref} />
    <SkillCollections onOpenCollection={onOpenCollection} collectionHref={collectionHref} />
  </>
)
