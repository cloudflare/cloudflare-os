import { describe, expect, it } from 'vitest'
import { isSkillName, newSkillManifest, readSkillManifest, skillNameFor, skillTitle, updateSkillManifest } from './skillManifest'

const MEETING_BRIEF = `---
name: meeting-brief
description: Prepare a one-page brief before a meeting.
owner: TBD # who keeps it
context:
  - voice/writing-guidelines.md
---

# Meeting Brief

Read the notes first.
`

describe('skill names', () => {
  it('reads a name in plain words, and makes one from them', () => {
    expect(skillTitle('meeting-brief')).toBe('Meeting brief')
    expect(skillTitle('q3-okrs')).toBe('Q3 okrs')
    expect(skillNameFor('Meeting brief')).toBe('meeting-brief')
    expect(skillNameFor('  Café — notes!  ')).toBe('cafe-notes')
    expect(skillNameFor('!!!')).toBe('')
  })

  it('keeps a made name to the length a skill may have, without a hyphen at its end', () => {
    const made = skillNameFor(`${'a'.repeat(63)} b`)
    expect(made).toBe('a'.repeat(63))
    expect(isSkillName(made)).toBe(true)
    expect(isSkillName('Meeting')).toBe(false)
  })
})

describe('skill manifests', () => {
  it('reads what a person edits from its frontmatter and body', () => {
    expect(readSkillManifest(MEETING_BRIEF)).toEqual({
      name: 'meeting-brief',
      description: 'Prepare a one-page brief before a meeting.',
      instructions: '# Meeting Brief\n\nRead the notes first.\n',
    })
    expect(readSkillManifest('# No frontmatter')).toBeUndefined()
    expect(readSkillManifest('---\n- a list\n---\nbody')).toBeUndefined()
  })

  it('changes the description and instructions, keeping the other keys and their comments', () => {
    const updated = updateSkillManifest(MEETING_BRIEF, { description: 'Brief me: before any meeting.', instructions: 'Ask who is coming.' })
    expect(updated).toContain('owner: TBD # who keeps it')
    expect(updated).toContain('  - voice/writing-guidelines.md')
    expect(readSkillManifest(updated)).toEqual({ name: 'meeting-brief', description: 'Brief me: before any meeting.', instructions: 'Ask who is coming.\n' })
  })

  it('writes a new manifest that reads back as it was given, quoting what YAML would misread', () => {
    const manifest = { name: 'weekly-update', description: 'Use: when a week ends', instructions: '## Steps\n\n1. Gather notes' }
    expect(readSkillManifest(newSkillManifest(manifest))).toEqual({ ...manifest, instructions: '## Steps\n\n1. Gather notes\n' })
  })
})
