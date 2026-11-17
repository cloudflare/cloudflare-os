import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SkillLibrary, type SkillLibraryProps } from '@/skills/SkillLibrary'
import { SoonSwitch } from './SoonControls'

/**
 * The skills the assistant loads when a task calls for them, listed as any list in the app is
 * (`SkillLibrary`), each opening as its own page, and how it goes about using them. None of it is
 * there yet.
 */
export const SkillSettings = ({ onOpenSkill, skillHref }: SkillLibraryProps) => (
  <>
    <SkillLibrary onOpenSkill={onOpenSkill} skillHref={skillHref} />
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
