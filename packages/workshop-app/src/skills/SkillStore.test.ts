import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { MANIFEST } from './skillFiles'
import { SkillStore } from './SkillStore'
import { prepareSkillUploads } from './skillUpload'

const NOW = new Date(2026, 10, 17, 12)

const made = () => {
  const store = new SkillStore([], () => NOW)
  const id = store.add({ name: 'Weekly report', description: 'How the team writes it.', tag: 'Reports' })
  return { store, id, skill: () => store.get(id)!, manifest: () => store.get(id)!.files.find(({ path }) => path === MANIFEST)!.body }
}
const metadata = (body: string) => parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(body)![1])

describe('SkillStore', () => {
  it('adds a skill with a SKILL.md that says what it is, under a name in lowercase with hyphens', () => {
    const { skill, manifest } = made()
    expect(skill()).toMatchObject({ name: 'Weekly report', description: 'How the team writes it.', tag: 'Reports', source: { kind: 'mine' }, updated: NOW })
    expect(skill().files.map(({ path }) => path)).toEqual([MANIFEST])
    expect(metadata(manifest())).toEqual({ name: 'weekly-report', description: 'How the team writes it.' })
    expect(manifest()).toContain('# Weekly report')
  })

  it('renames and describes a skill in its SKILL.md too, keeping its instructions, however often', () => {
    const { store, id, skill, manifest } = made()
    store.saveFile(id, MANIFEST, '---\nname: weekly-report\ndescription: How the team writes it.\nlicense: MIT\n---\n\nStart with the numbers.\n')
    store.rename(id, 'Monthly report')
    store.describe(id, 'How it is written each month.')
    store.rename(id, 'Monthly Report')
    expect(skill()).toMatchObject({ name: 'Monthly Report', description: 'How it is written each month.' })
    expect(metadata(manifest())).toEqual({ name: 'monthly-report', description: 'How it is written each month.', license: 'MIT' })
    expect(manifest().endsWith('\n---\n\nStart with the numbers.\n')).toBe(true)
  })

  it('does not call a skill something no name can be made of', () => {
    const { store, id, skill } = made()
    expect(store.rename(id, '???')).toBe(false)
    expect(store.rename(id, 'a'.repeat(65))).toBe(false)
    expect(skill().name).toBe('Weekly report')
  })

  it('goes by what is written in SKILL.md for what the skill is called and is for', () => {
    const { store, id, skill } = made()
    store.saveFile(id, MANIFEST, '---\nname: status-update\ndescription: What to send on Fridays.\n---\n\nBody')
    expect(skill()).toMatchObject({ name: 'Status Update', description: 'What to send on Fridays.' })
  })

  it('keeps the title it has while SKILL.md still names it the same, and what it had where SKILL.md cannot be gone by', () => {
    const { store, id, skill } = made()
    store.saveFile(id, MANIFEST, '---\nname: weekly-report\ndescription: Another line about it.\n---\n\nBody')
    expect(skill()).toMatchObject({ name: 'Weekly report', description: 'Another line about it.' })
    store.saveFile(id, MANIFEST, '---\nname: Not A Name\n---\n\nBody')
    store.saveFile(id, MANIFEST, 'No frontmatter at all')
    expect(skill()).toMatchObject({ name: 'Weekly report', description: 'Another line about it.' })
  })

  it('puts files in a skill, SKILL.md first and the rest by path, each in place of one at its path', () => {
    const { store, id, skill } = made()
    store.putFiles(id, [
      { path: 'templates/report.md', contentType: 'text/markdown', body: 'One' },
      { path: 'checklist.md', contentType: 'text/markdown', body: 'Two' },
    ])
    store.putFiles(id, [{ path: 'checklist.md', contentType: 'text/markdown', body: 'Three' }])
    expect(skill().files.map(({ path, body }) => [path, path === MANIFEST ? '' : body])).toEqual([[MANIFEST, ''], ['checklist.md', 'Three'], ['templates/report.md', 'One']])
  })

  it('takes a file out of a skill, but not its SKILL.md', () => {
    const { store, id, skill } = made()
    store.putFiles(id, [{ path: 'checklist.md', contentType: 'text/markdown', body: 'Two' }])
    store.removeFile(id, 'checklist.md')
    store.removeFile(id, MANIFEST)
    expect(skill().files.map(({ path }) => path)).toEqual([MANIFEST])
  })

  it('makes skills of uploaded files, each with what came with it, named from what it was called where it does not say', () => {
    const store = new SkillStore([], () => NOW)
    const ids = store.addUploads(
      prepareSkillUploads([
        { path: 'incident-kit/SKILL.md', contentType: 'text/markdown', body: '---\nname: incident-write-up\ndescription: The review template.\n---\n\nSteps' },
        { path: 'incident-kit/assets/checklist.md', contentType: 'text/markdown', body: 'Checks' },
      ]).concat(prepareSkillUploads([{ path: 'deployment-check.md', contentType: 'text/markdown', body: '# Deployment check' }])),
    )
    const [kit, check] = ids.map((id) => store.get(id)!)
    expect(kit).toMatchObject({ name: 'Incident Write Up', description: 'The review template.' })
    expect(kit.files.map(({ path }) => path)).toEqual([MANIFEST, 'assets/checklist.md'])
    expect(check).toMatchObject({ name: 'Deployment Check', description: 'Instructions for deployment check.' })
    expect(metadata(check.files[0].body)).toEqual({ name: 'deployment-check', description: 'Instructions for deployment check.' })
  })

  it('files a skill under a tag or none, and says when it changed', () => {
    let now = NOW
    const store = new SkillStore([], () => now)
    const id = store.add({ name: 'Weekly report', description: 'How the team writes it.' })
    now = new Date(NOW.getTime() + 1000)
    store.setTag(id, ' Reports ')
    expect(store.get(id)).toMatchObject({ tag: 'Reports', updated: now })
    store.setTag(id, ' ')
    expect(store.get(id)!.tag).toBeUndefined()
  })

  it('tells whoever listens of a change, with another list, and removes a skill', () => {
    const { store, id } = made()
    const before = store.getSnapshot()
    let told = 0
    const stop = store.subscribe(() => (told += 1))
    store.setAutoUse(id, false)
    expect(told).toBe(1)
    expect(store.getSnapshot()).not.toBe(before)
    stop()
    store.remove(id)
    expect(told).toBe(1)
    expect(store.getSnapshot()).toEqual([])
  })
})
