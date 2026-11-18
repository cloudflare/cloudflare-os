import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SkillCollections, type SkillCollectionsProps } from '@/skills/SkillCollections'
import { SkillLibrary, type SkillLibraryProps } from '@/skills/SkillLibrary'
import { SoonSwitch } from './SoonControls'

export type SkillSettingsProps = SkillLibraryProps & SkillCollectionsProps

/**
 * The skills the assistant loads when a task calls for them, listed as any list in the app is
 * (`SkillLibrary`), each opening as its own page, then the collections they are kept and shared
 * in (`SkillCollections`), each with a page of its own too, and how the assistant goes about using
 * them, none of which is there yet.
 */
export const SkillSettings = ({ onOpenSkill, skillHref, onOpenCollection, collectionHref }: SkillSettingsProps) => (
  <>
    <SkillLibrary onOpenSkill={onOpenSkill} skillHref={skillHref} />
    <SkillCollections onOpenCollection={onOpenCollection} collectionHref={collectionHref} />
    <SettingsGroup title="Skill behavior" soon>
      <SettingRow title="Auto-load skills" description="Let the assistant load a skill when your request matches what it’s for.">
        <SoonSwitch label="Auto-load skills" on />
      </SettingRow>
      <SettingRow title="Skill creation" description="Let the assistant save what it worked out as a new skill to reuse later.">
        <SoonSwitch label="Skill creation" />
      </SettingRow>
      <SettingRow title="Workspace skills" description="Share your skills with everyone in a workspace.">
        <SoonSwitch label="Workspace skills" />
      </SettingRow>
    </SettingsGroup>
  </>
)
