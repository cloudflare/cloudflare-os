import { describe, expect, it } from 'vitest'
import { asStatus, describeAgentStep, describeToolStep } from './agentSteps'

const step = (over: Partial<Parameters<typeof describeAgentStep>[0]> = {}) =>
  describeAgentStep({ toolCalls: [], writing: false, compacting: false, waiting: false, ...over })

describe('describeAgentStep', () => {
  it('has nothing new to say between steps, so the line keeps its words', () => {
    expect(step()).toEqual({ label: undefined })
  })

  it('shows the mark alone while the answer is written', () => {
    expect(step({ writing: true })).toEqual({ label: null })
  })

  it("names the newest tool call's step, even while text from before it is on screen", () => {
    expect(step({ writing: true, toolCalls: [{ toolName: 'webFetch' }, { toolName: 'listBlueprints' }] }))
      .toEqual({ label: 'Browsing blueprints...' })
  })

  it('puts waiting on the person first, and holds it still', () => {
    expect(step({ waiting: true, compacting: true, toolCalls: [{ toolName: 'grep' }] }))
      .toEqual({ label: 'Waiting for you...', waiting: true })
  })

  it('says when it is catching up on a long conversation', () => {
    expect(step({ compacting: true })).toEqual({ label: 'Catching up on the conversation...' })
  })
})

describe('describeToolStep', () => {
  it("uses a code run's own summary, and says nothing technical without one", () => {
    expect(describeToolStep({ toolName: 'executeCode', summary: "counting this week's open issues." }))
      .toBe("Counting this week's open issues...")
    expect(describeToolStep({ toolName: 'executeCode' })).toBeUndefined()
  })

  it('builds a new app by name and updates an existing one by its kind', () => {
    expect(describeToolStep({ toolName: 'writeFile' }, { title: 'Habit Tracker', isNew: true }))
      .toBe('Building Habit Tracker...')
    expect(describeToolStep({ toolName: 'editFile' }, { noun: 'Doc' })).toBe('Updating the doc...')
    expect(describeToolStep({ toolName: 'editFile' })).toBeUndefined()
  })

  it('names what a new gadget will be', () => {
    expect(describeToolStep({ toolName: 'createGadget', outputFormat: { noun: 'Slides' } as never }))
      .toBe('Creating your slides...')
    expect(describeToolStep({ toolName: 'createGadget' })).toBe('Creating your app...')
  })
})

describe('asStatus', () => {
  it('capitalizes and ends in three dots, whatever the agent ended with', () => {
    expect(asStatus('  checking the calendar…  ')).toBe('Checking the calendar...')
    expect(asStatus(' ')).toBe('Working on it...')
  })
})
