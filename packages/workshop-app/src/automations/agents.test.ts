import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { agentsOf, runsWords } from './agents'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Run ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata

describe('agentsOf', () => {
  it('gives each agent its runs, latest first, and puts the one that ran last first', () => {
    const chats = [
      chat(1, 5, { spawnerName: 'Inbox helper' }),
      chat(2, 9, { spawnerName: 'Inbox helper', title: '' }),
      chat(3, 12, { spawnerName: 'Triage' }),
      // Someone's own chat, not an agent's run.
      chat(4, 30),
    ]
    const [triage, helper] = agentsOf(chats)
    expect(triage).toMatchObject({ key: 'Triage', name: 'Triage' })
    expect(helper.runs.map(({ chatId, title }) => [chatId, title])).toEqual([[2, 'Untitled run'], [1, 'Run 1']])
    expect(agentsOf([chat(4, 30)])).toEqual([])
  })

  it('says how many runs there were and when the latest was', () => {
    const [one] = agentsOf([chat(1, 0, { spawnerName: 'A' })])
    expect(runsWords(one, at(0))).toBe('One run · latest just now')
    const [many] = agentsOf([chat(1, 0, { spawnerName: 'A' }), chat(2, 0, { spawnerName: 'A' })])
    expect(runsWords(many, new Date(at(0).getTime() + 2 * 3_600_000))).toBe('2 runs · latest 2 hours ago')
  })
})
