import { describe, expect, it } from 'vitest'
import type { AiChatMessage } from '@gadgets/workshop-shared/api'
import { formatWorkedFor, workByTurn } from './turnWork'

const user = { type: 'user', id: 'u', name: 'Ada' } as const
const agent = { type: 'agent', id: 'a', name: 'Agent' } as const
let sequence = 0
const at = (seconds: number) => new Date(1_000_000 + seconds * 1000)
const say = (author: typeof user | typeof agent, seconds: number, extra: object = {}): AiChatMessage =>
  ({ type: 'message', chatId: 1, sequence: sequence++, timestamp: at(seconds), author, message: '', ...extra }) as never

describe('workByTurn', () => {
  it("times each turn from the person's message to the agent's last act, in plain steps", () => {
    sequence = 0
    const turns = workByTurn([
      say(user, 0, { message: 'Build a tracker' }),
      say(agent, 4, { toolCalls: [
        { toolCallId: '1', toolName: 'executeCode', input: { code: 'x', summary: 'counting the days' } },
        { toolCallId: '2', toolName: 'createGadget', input: { title: 'Tracker', bindingName: 'TRACKER' } },
        { toolCallId: '3', toolName: 'writeFile', input: { workpiece: 'TRACKER', filename: 'a', content: '' } },
        { toolCallId: '4', toolName: 'editFile', input: { workpiece: 'TRACKER', filename: 'a' } },
      ] }),
      say(agent, 42, { message: 'Done' }),
      say(user, 50, { message: 'Thanks' }),
      say(agent, 52, { message: 'Any time' }),
    ])
    expect(turns.get(0)).toEqual({ key: 0, seconds: 42, worked: true,
      steps: ['Counting the days', 'Creating Tracker', 'Building Tracker'] })
    expect(turns.get(3)).toEqual({ key: 3, seconds: 2, worked: false, steps: [] })
  })

  it('gives each scheduled run a turn of its own, not one stretched across every run', () => {
    sequence = 0
    const run = (seconds: number): AiChatMessage => ({ type: 'agentCallback', chatId: 1, sequence: sequence++,
      timestamp: at(seconds), author: agent, methodName: 'onSchedule', argsSummary: '' }) as never
    const tool = { toolCallId: '1', toolName: 'executeCode', input: { code: 'x', summary: 'reading your email' } }
    const turns = workByTurn([
      say(user, 0, { message: 'Every minute, summarize my email' }),
      say(agent, 5, { message: 'Done' }),
      run(60),
      say(agent, 64, { toolCalls: [tool] }),
      run(120),
      say(agent, 123, { toolCalls: [tool] }),
    ])
    expect([...turns.keys()]).toEqual([0, 2, 4])
    expect(turns.get(0)?.seconds).toBe(5)
    expect(turns.get(4)).toMatchObject({ seconds: 3, worked: true, steps: ['Reading your email'] })
  })

  it('updates an app made in an earlier turn rather than building it', () => {
    sequence = 0
    const turns = workByTurn([
      say(user, 0),
      say(agent, 1, { toolCalls: [{ toolCallId: '1', toolName: 'createGadget', input: { title: 'Notes', bindingName: 'NOTES' } }] }),
      say(user, 5),
      say(agent, 6, { toolCalls: [{ toolCallId: '2', toolName: 'editFile', input: { workpiece: 'NOTES', filename: 'a' } }] }),
    ])
    expect(turns.get(2)?.steps).toEqual(['Updating Notes'])
  })
})

describe('formatWorkedFor', () => {
  it('reads like a person would say it', () => {
    expect(formatWorkedFor(0.2)).toBe('Worked for 1s')
    expect(formatWorkedFor(42)).toBe('Worked for 42s')
    expect(formatWorkedFor(120)).toBe('Worked for 2m')
    expect(formatWorkedFor(185)).toBe('Worked for 3m 5s')
    expect(formatWorkedFor(4830)).toBe('Worked for 1h 20m')
  })
})
