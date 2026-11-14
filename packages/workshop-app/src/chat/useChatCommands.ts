import { useEffect, useMemo, useState } from 'react'
import type { SlashCommandChoice } from '@gadgets/workshop-shared/api'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { useSkills } from '@/skills/SkillsContext'
import { composerCommandOf, orderCommands } from './slashCommands'
import type { ChatActions } from './useChatSession'

/**
 * The skills and commands a chat's composer offers, as its workspace lists them, and that list
 * itself, to send one by. Read once the chat is, and again whenever the user's skills change, so
 * one just written can be used at once; what was read stays when reading again fails.
 */
export const useChatCommands = (listCommands: ChatActions['listCommands'], loaded: boolean): { choices: SlashCommandChoice[]; commands: ComposerCommand[] } => {
  const { snapshot } = useSkills()
  const [choices, setChoices] = useState<SlashCommandChoice[]>([])
  useEffect(() => {
    if (!loaded) return
    let current = true
    listCommands().then(
      (listed) => { if (current && listed.length) setChoices(listed) },
      () => {},
    )
    return () => {
      current = false
    }
  }, [listCommands, loaded, snapshot])
  return { choices, commands: useMemo(() => orderCommands(choices.map(composerCommandOf)), [choices]) }
}
