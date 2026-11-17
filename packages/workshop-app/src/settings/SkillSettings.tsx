import { useState } from 'react'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard, SettingsGroup } from '@/blocks/SettingsGroup'
import { TextField } from '@/components/TextField'
import { SkillLibrary } from './SkillLibrary'
import { SoonSwitch } from './SoonControls'

/**
 * What the assistant is told beyond what it comes with: instructions it always has, and skills
 * it loads when a task calls for them, which are listed as any list in the app is
 * (`SkillLibrary`). None of it is there yet.
 */
export const SkillSettings = () => {
  // Not kept: it is there to be tried, until it can be written for real.
  const [instructions, setInstructions] = useState('')
  return (
    <>
      <SettingsGroup title="Custom instructions" soon plain>
        <SettingsCard field>
          <TextField
            aria-label="Custom instructions"
            rows={4}
            value={instructions}
            placeholder="What the assistant should always know or do, such as “Answer in British English.”"
            onValueChange={setInstructions}
            className="rounded-2xl"
          />
        </SettingsCard>
      </SettingsGroup>
      <SkillLibrary />
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
}
