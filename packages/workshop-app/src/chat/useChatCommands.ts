import { useEffect, useMemo, useState } from 'react'
import type { SlashCommandChoice } from '@gadgets/workshop-shared/api'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { useSkills } from '@/skills/useSkills'
import { composerCommandOf, orderCommands } from './slashCommands'
import type { ChatActions } from './useChatSession'

// What each workspace's chats were last told they offer, for the visit: a chat opened again, or
// another of the same workspace, offers them at once while they are read again.
const listedIn = new Map<string, SlashCommandChoice[]>()

/**
 * The skills and commands a chat's composer offers, as its workspace lists them, and that list
 * itself, to send one by. Read once the chat is, and again whenever the user's skills change, so
 * one just written can be used at once; what was read stays when reading again fails. Until the
 * first read of the workspace's has answered, `loading` says so.
 */
export const useChatCommands = (
  workspaceId: string,
  listCommands: ChatActions['listCommands'],
  loaded: boolean,
): { choices: SlashCommandChoice[]; commands: ComposerCommand[]; loading: boolean } => {
  // Read again as the user's skills change, so one just written can be used at once.
  const skills = useSkills()
  const [read, setRead] = useState(() => ({ workspaceId, choices: listedIn.get(workspaceId) }))
  const choices = (read.workspaceId === workspaceId ? read.choices : listedIn.get(workspaceId)) ?? []
  // The workspace whose list has answered, read or not.
  const [answered, setAnswered] = useState<string>()
  useEffect(() => {
    if (!loaded) return
    let current = true
    listCommands().then(
      (listed) => {
        if (!current) return
        setAnswered(workspaceId)
        if (!listed.length) return
        listedIn.set(workspaceId, listed)
        setRead({ workspaceId, choices: listed })
      },
      () => {
        if (current) setAnswered(workspaceId)
      },
    )
    return () => {
      current = false
    }
  }, [workspaceId, listCommands, loaded, skills])
  return {
    choices,
    commands: useMemo(() => orderCommands(choices.map(composerCommandOf)), [choices]),
    loading: answered !== workspaceId && !choices.length,
  }
}
