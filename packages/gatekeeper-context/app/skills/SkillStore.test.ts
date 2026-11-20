import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { MemorySkillsBackend } from './MemorySkillsBackend'
import { MANIFEST } from './skillFiles'
import { SkillStore, UNTAGGED } from './SkillStore'
import { prepareSkillUploads } from './skillUpload'

const NOW = new Date(2026, 10, 17, 12)

/** A store over an empty Context Library, and the skill it is given to start with, read whole. */
const made = async () => {
  const backend = new MemorySkillsBackend(() => NOW)
  const store = new SkillStore(backend)
  await store.reload()
  let id = await store.add({ name: 'Weekly report', description: 'How the team writes it.', tag: 'Reports' })
  await store.open(id)
  return {
    store,
    backend,
    id: () => id,
    moved: (next: string) => (id = next),
    skill: () => store.get(id)!,
    manifest: () => store.get(id)!.files!.find(({ path }) => path === MANIFEST)!.body,
  }
}
const skillFiles = (name: string) => [{ path: `${name}/SKILL.md`, contentType: 'text/markdown', body: `---\nname: ${name}\ndescription: About ${name}.\n---\n` }]
const metadata = (body: string) => parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(body)![1])

describe('SkillStore', () => {
  it('adds a skill with a SKILL.md that says what it is, under a name in lowercase with hyphens, in the collection its tag names', async () => {
    const { skill, manifest, id } = await made()
    expect(skill()).toMatchObject({ name: 'Weekly report', description: 'How the team writes it.', tag: 'Reports', source: { kind: 'mine' }, updated: NOW })
    expect(skill().files!.map(({ path }) => path)).toEqual([MANIFEST])
    expect(id()).toMatch(/\/weekly-report\/SKILL\.md$/)
    expect(metadata(manifest())).toEqual({ name: 'weekly-report', description: 'How the team writes it.' })
    expect(manifest()).toContain('# Weekly report')
  })

  it('renames and describes a skill in its SKILL.md too, keeping its instructions, however often', async () => {
    const { store, id, moved, skill, manifest } = await made()
    await store.saveFile(id(), MANIFEST, '---\nname: weekly-report\ndescription: How the team writes it.\nlicense: MIT\n---\n\nStart with the numbers.\n')
    moved(await store.rename(id(), 'Monthly report'))
    await store.open(id())
    await store.describe(id(), 'How it is written each month.')
    moved(await store.rename(id(), 'Monthly Report'))
    expect(skill()).toMatchObject({ name: 'Monthly Report', description: 'How it is written each month.' })
    expect(id()).toMatch(/\/monthly-report\/SKILL\.md$/)
    expect(metadata(manifest())).toEqual({ name: 'monthly-report', description: 'How it is written each month.', license: 'MIT' })
    expect(manifest().endsWith('\n---\n\nStart with the numbers.\n')).toBe(true)
  })

  it('does not call a skill something no name can be made of', async () => {
    const { store, id, skill } = await made()
    await expect(store.rename(id(), '???')).rejects.toThrow(/letters or numbers/)
    await expect(store.rename(id(), 'a'.repeat(65))).rejects.toThrow(/64 characters/)
    expect(SkillStore.canBeCalled('???')).toBe(false)
    expect(skill().name).toBe('Weekly report')
  })

  it('goes by what is written in SKILL.md for what the skill is called and is for', async () => {
    const { store, backend, id, skill } = await made()
    // As someone else, or the Context Library's own app, could have written it.
    const [collectionId, ...path] = id().split('/')
    await backend.putContextDocument(collectionId, path.join('/'), { description: '', body: '---\nname: status-update\ndescription: What to send on Fridays.\n---\n\nBody' })
    await store.reload()
    expect(skill()).toMatchObject({ name: 'Status Update', description: 'What to send on Fridays.' })
  })

  it('keeps the title it has while SKILL.md still names it the same', async () => {
    const { store, id, skill } = await made()
    await store.saveFile(id(), MANIFEST, '---\nname: weekly-report\ndescription: Another line about it.\n---\n\nBody')
    expect(skill()).toMatchObject({ name: 'Weekly report', description: 'Another line about it.' })
  })

  it('puts files in a skill, SKILL.md first and the rest by path, each in place of one at its path', async () => {
    const { store, id, skill } = await made()
    await store.putFiles(id(), [
      { path: 'templates/report.md', contentType: 'text/markdown', body: 'One' },
      { path: 'checklist.md', contentType: 'text/markdown', body: 'Two' },
    ])
    await store.putFiles(id(), [{ path: 'checklist.md', contentType: 'text/markdown', body: 'Three' }])
    expect(skill().files!.map(({ path, body }) => [path, path === MANIFEST ? '' : body])).toEqual([[MANIFEST, ''], ['checklist.md', 'Three'], ['templates/report.md', 'One']])
  })

  it('takes a file out of a skill, but not its SKILL.md', async () => {
    const { store, id, skill } = await made()
    await store.putFiles(id(), [{ path: 'checklist.md', contentType: 'text/markdown', body: 'Two' }])
    await store.removeFile(id(), 'checklist.md')
    await store.removeFile(id(), MANIFEST)
    expect(skill().files!.map(({ path }) => path)).toEqual([MANIFEST])
  })

  it('makes skills of uploaded files, each with what came with it, named from what it was called where it does not say', async () => {
    const backend = new MemorySkillsBackend(() => NOW)
    const store = new SkillStore(backend)
    await store.reload()
    const ids = await store.addUploads(
      prepareSkillUploads([
        { path: 'incident-kit/SKILL.md', contentType: 'text/markdown', body: '---\nname: incident-write-up\ndescription: The review template.\n---\n\nSteps' },
        { path: 'incident-kit/assets/checklist.md', contentType: 'text/markdown', body: 'Checks' },
      ]).concat(prepareSkillUploads([{ path: 'deployment-check.md', contentType: 'text/markdown', body: '# Deployment check' }])),
    )
    await Promise.all(ids.map((id) => store.open(id)))
    const [kit, check] = ids.map((id) => store.get(id)!)
    expect(kit).toMatchObject({ name: 'Incident Write Up', description: 'The review template.', tag: undefined })
    expect(kit.files!.map(({ path }) => path)).toEqual([MANIFEST, 'assets/checklist.md'])
    expect(check).toMatchObject({ name: 'Deployment Check', description: 'Instructions for deployment check.' })
    expect(metadata(check.files![0].body)).toEqual({ name: 'deployment-check', description: 'Instructions for deployment check.' })
  })

  it('files a skill under another tag by moving it, files and all, to that collection, and untagged to the user’s own', async () => {
    const { store, id, moved, skill } = await made()
    await store.putFiles(id(), [{ path: 'checklist.md', contentType: 'text/markdown', body: 'Two' }])
    const before = id()
    moved(await store.setTag(id(), ' Status '))
    expect(id()).not.toBe(before)
    expect(store.get(before)).toBeUndefined()
    await store.open(id())
    expect(skill()).toMatchObject({ name: 'Weekly report', tag: 'Status' })
    expect(skill().files!.map(({ path }) => path)).toEqual([MANIFEST, 'checklist.md'])
    moved(await store.setTag(id(), ' '))
    expect(skill().tag).toBeUndefined()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', skills: [{ name: 'Weekly report' }] })
  })

  it('lists whose each skill is, by the collection it is in', async () => {
    const backend = new MemorySkillsBackend(() => NOW)
    backend.seed({ title: UNTAGGED, source: 'private', membership: { role: 'owner', shared: false } }, skillFiles('mine'))
    backend.seed({ title: 'Team', source: 'private', membership: { role: 'viewer', shared: true } }, skillFiles('theirs'), 'Grace Hopper')
    backend.seed({ title: 'Company', source: 'public' }, skillFiles('everyones'))
    const store = new SkillStore(backend)
    await store.reload()
    expect(store.skills.map(({ name, tag, source }) => [name, tag, source])).toEqual([
      ['Mine', undefined, { kind: 'mine' }],
      ['Theirs', 'Team', { kind: 'shared', by: 'Grace Hopper' }],
      ['Everyones', 'Company', { kind: 'organization' }],
    ])
  })

  it('lists the collections, the user’s own first and My skills ahead of them, with who has each and what the user may do', async () => {
    const backend = new MemorySkillsBackend(() => NOW)
    backend.seed({ title: 'Team', source: 'private', membership: { role: 'editor', shared: true } }, skillFiles('theirs'), 'Grace Hopper')
    backend.seed({ title: 'Company', source: 'public' }, skillFiles('everyones'))
    backend.seed({ title: 'Reports', source: 'private', membership: { role: 'owner', shared: false } }, [])
    backend.seed({ title: UNTAGGED, source: 'private', membership: { role: 'owner', shared: false } }, skillFiles('mine'))
    const store = new SkillStore(backend)
    await store.reload()
    expect(store.collections.map(({ title, source, untagged, skillCount, permissions }) => [title, source.kind, untagged, skillCount, permissions.canDelete])).toEqual([
      [UNTAGGED, 'mine', true, 1, true],
      ['Reports', 'mine', false, 0, true],
      ['Team', 'shared', false, 1, false],
      ['Company', 'organization', false, 1, false],
    ])
    // Shared with them to edit, a skill can be changed; the organization's only read.
    expect(store.skills.map(({ name, editable }) => [name, editable])).toEqual([['Theirs', true], ['Everyones', false], ['Mine', true]])
  })

  it('makes, renames, describes and deletes a collection, with the skills in it, which are filed under its name', async () => {
    const { store, id, skill } = await made()
    const collectionId = await store.addCollection('  Design  ', ' How we draw. ')
    expect(store.collection(collectionId)).toMatchObject({ title: 'Design', description: 'How we draw.', skillCount: 0, source: { kind: 'mine' } })
    await expect(store.addCollection(' ', '')).rejects.toThrow(/needs a name/)
    const added = await store.add({ name: 'Logo rules', description: 'Where the logo goes.', collectionId })
    expect(store.get(added)).toMatchObject({ tag: 'Design', collectionId })
    await store.updateCollection(collectionId, { title: 'Brand' })
    expect(store.get(added)!.tag).toBe('Brand')
    await store.removeCollection(collectionId)
    expect(store.get(added)).toBeUndefined()
    expect(store.collection(collectionId)).toBeUndefined()
    expect(skill().id).toBe(id())
  })

  it('shares a collection by the ticket the Workshop’s person picker gives for someone, and says it is shared until nobody else has it', async () => {
    const { store, skill } = await made()
    const { collectionId } = skill()
    await store.share(collectionId, 'ticket:grace', 'viewer')
    expect(store.collection(collectionId)!.shared).toBe(true)
    expect((await store.sharing(collectionId)).members).toContainEqual(expect.objectContaining({ memberId: 'grace', role: 'viewer', displayName: 'grace' }))
    await store.setMemberRole(collectionId, 'grace', 'editor')
    expect((await store.sharing(collectionId)).members.find(({ memberId }) => memberId === 'grace')!.role).toBe('editor')
    await store.removeMember(collectionId, 'grace')
    expect(store.collection(collectionId)!.shared).toBe(false)
    await store.setEveryoneCanView(collectionId, true)
    expect(store.collection(collectionId)!.shared).toBe(true)
  })

  it('leaves a collection shared with it, which takes its skills out of the list', async () => {
    const backend = new MemorySkillsBackend(() => NOW)
    const team = backend.seed({ title: 'Team', source: 'private', membership: { role: 'viewer', shared: true } }, skillFiles('theirs'), 'Grace Hopper')
    const store = new SkillStore(backend)
    await store.reload()
    expect(store.collection(team)!.permissions).toMatchObject({ canEdit: false, canShare: false })
    await store.leaveCollection(team)
    expect(store.collections).toEqual([])
    expect(store.skills).toEqual([])
  })

  it('tells whoever listens of a change, with another list, and removes a skill', async () => {
    const { store, id } = await made()
    const before = store.getSnapshot()
    let told = 0
    const stop = store.subscribe(() => (told += 1))
    store.setAutoUse(id(), false)
    expect(told).toBe(1)
    expect(store.getSnapshot()).not.toBe(before)
    stop()
    await store.remove(id())
    expect(told).toBe(1)
    expect(store.skills).toEqual([])
  })
})
