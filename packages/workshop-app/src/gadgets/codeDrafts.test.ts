import { describe, expect, it, vi } from 'vitest'
import type { CodeFile } from './gadgetCode'
import {
  changeCount, checkName, CodeDrafts, conflictsWith, copyName, draftEdits, editedLine, fileOffers, listDraft, livePaths, rebase, resolveRenamePath,
  restoreFile, toChange, withFile, type DraftBefore, type DraftedFile,
} from './codeDrafts'

const text = (value: string): DraftBefore => ({ kind: 'text', text: value })
const ABSENT: DraftBefore = { kind: 'absent' }
const FILES: CodeFile[] = [
  { path: 'client.ts', kind: 'file', role: 'What it shows' },
  { path: 'server.ts', kind: 'file', role: 'What it keeps and does' },
  { path: 'styles.css', kind: 'file' },
  { path: 'lib/util.ts', kind: 'file' },
]
const LIVE = livePaths(FILES)

describe('withFile', () => {
  it('starts a draft from the base on the first change, and keeps what each file was', () => {
    const draft = withFile(undefined, 'c1', 'client.ts', text('a'), 'ab')!
    expect(draft.base).toBe('c1')
    const again = withFile(draft, 'c2', 'client.ts', text('ab'), 'abc')!
    expect(again.base).toBe('c1')
    expect(again.id).toBe(draft.id)
    expect(again.files.get('client.ts')).toEqual({ before: text('a'), after: 'abc' })
  })

  it('lets go of a file edited back to how it was, and of the draft with nothing left in it', () => {
    const draft = withFile(undefined, 'c1', 'client.ts', text('a'), 'ab')
    expect(withFile(draft, 'c1', 'client.ts', text('ab'), 'a')).toBeUndefined()
  })

  it('takes a file added then deleted as nothing', () => {
    const added = withFile(undefined, 'c1', 'new.ts', ABSENT, '')
    expect(added?.files.get('new.ts')).toEqual({ before: ABSENT, after: '' })
    expect(withFile(added, 'c1', 'new.ts', ABSENT, null)).toBeUndefined()
  })

  it('gives each new draft an id of its own', () => {
    const one = withFile(undefined, 'c1', 'a', text(''), 'x')!
    const two = withFile(undefined, 'c1', 'a', text(''), 'x')!
    expect(one.id).not.toBe(two.id)
  })
})

describe('restoreFile', () => {
  it('puts one file back, and the draft goes with its last', () => {
    let draft = withFile(undefined, 'c1', 'client.ts', text('a'), 'b')
    draft = withFile(draft, 'c1', 'server.ts', text('s'), null)
    expect(changeCount(restoreFile(draft, 'server.ts'))).toBe(1)
    expect(restoreFile(restoreFile(draft, 'server.ts'), 'client.ts')).toBeUndefined()
  })
})

describe('listDraft', () => {
  it('marks what the draft changes, keeps what it deletes, and lists what it adds in order', () => {
    let draft = withFile(undefined, 'c1', 'styles.css', text('a'), 'b')
    draft = withFile(draft, 'c1', 'server.ts', text('s'), null)
    draft = withFile(draft, 'c1', 'README.md', ABSENT, '# Hi')
    draft = withFile(draft, 'c1', 'components/Button.tsx', ABSENT, '')
    expect(listDraft(FILES, draftEdits(draft))).toEqual([
      { path: 'client.ts', kind: 'file', role: 'What it shows' },
      { path: 'server.ts', kind: 'file', role: 'What it keeps and does', edit: 'deleted' },
      { path: 'README.md', kind: 'file', role: 'What it is', edit: 'added' },
      { path: 'styles.css', kind: 'file', edit: 'changed' },
      { path: 'components/Button.tsx', kind: 'file', edit: 'added' },
      { path: 'lib/util.ts', kind: 'file' },
    ])
  })

  it('leaves out of what is live the files it deletes', () => {
    const draft = withFile(undefined, 'c1', 'server.ts', text('s'), null)
    expect(livePaths(listDraft(FILES, draftEdits(draft))).has('server.ts')).toBe(false)
  })
})

describe('resolveRenamePath', () => {
  it('renames in place, moves down with a folder, up with .., and from the top with /', () => {
    expect(resolveRenamePath('lib/a.ts', 'b.ts')).toBe('lib/b.ts')
    expect(resolveRenamePath('lib/a.ts', 'sub/b.ts')).toBe('lib/sub/b.ts')
    expect(resolveRenamePath('lib/a.ts', '../b.ts')).toBe('b.ts')
    expect(resolveRenamePath('lib/a.ts', '/x/b.ts')).toBe('x/b.ts')
    expect(resolveRenamePath('a.ts', '../b.ts')).toBeNull()
    expect(resolveRenamePath('a.ts', 'x//b.ts')).toBeNull()
  })
})

describe('checkName', () => {
  const top = { folder: '' }
  it('makes the folders a name with / names', () => {
    expect(checkName(LIVE, 'components/Button.tsx', top)).toEqual({ path: 'components/Button.tsx' })
    expect(checkName(LIVE, 'b.ts', { folder: 'lib' })).toEqual({ path: 'lib/b.ts' })
  })

  it('takes nothing typed, or the same name, as nothing to do', () => {
    expect(checkName(LIVE, '  ', top)).toEqual({ none: true })
    expect(checkName(LIVE, 'styles.css', { renaming: 'styles.css' })).toEqual({ none: true })
  })

  it('refuses a name that is taken, here or elsewhere', () => {
    expect(checkName(LIVE, 'styles.css', top)).toEqual({ problem: 'There’s already a styles.css here.' })
    expect(checkName(LIVE, 'lib/util.ts', { renaming: 'styles.css' })).toEqual({ problem: 'There’s already a util.ts in lib.' })
  })

  it('allows a name that differs only in case', () => {
    expect(checkName(LIVE, 'Styles.css', { renaming: 'styles.css' })).toEqual({ path: 'Styles.css' })
  })

  it('says what is wrong with a name that cannot be one', () => {
    expect(checkName(LIVE, 'a/', top)).toEqual({ problem: 'A name can’t end with /' })
    expect(checkName(LIVE, 'a//b', top)).toEqual({ problem: 'A name can’t have // in it' })
    expect(checkName(LIVE, '../a', top)).toEqual({ problem: 'That’s above the top folder' })
    expect(checkName(LIVE, 'a\u0007b', top)).toEqual({ problem: 'A name can’t have control characters in it' })
    expect(checkName(LIVE, 'x'.repeat(1025), top)).toEqual({ problem: 'A name can’t be over 1,024 characters' })
  })

  it('refuses a file where a folder is, and a folder where a file is', () => {
    expect(checkName(LIVE, 'lib', top)).toEqual({ problem: 'There’s already a folder called lib here.' })
    expect(checkName(LIVE, 'styles.css/a.css', top)).toEqual({ problem: 'styles.css is a file, so nothing can go in it.' })
  })

  it('takes a deleted file’s name as free', () => {
    const draft = withFile(undefined, 'c1', 'styles.css', text('a'), null)
    expect(checkName(livePaths(listDraft(FILES, draftEdits(draft))), 'styles.css', top)).toEqual({ path: 'styles.css' })
  })
})

describe('copyName', () => {
  it('names a copy beside it, numbered once that is taken', () => {
    expect(copyName(LIVE, 'styles.css')).toBe('styles copy.css')
    expect(copyName(new Set([...LIVE, 'styles copy.css']), 'styles.css')).toBe('styles copy 2.css')
    expect(copyName(LIVE, 'lib/util.ts')).toBe('lib/util copy.ts')
    expect(copyName(new Set(['Makefile']), 'Makefile')).toBe('Makefile copy')
  })
})

describe('fileOffers', () => {
  const files: DraftedFile[] = FILES
  it('cautions about renaming or deleting what the gadget starts from', () => {
    expect(fileOffers(files[0], files, 'Counter', true)).toEqual({ rename: true, duplicate: true, delete: true, restore: false, caution: 'Counter starts from it' })
    expect(fileOffers(files[2], files, 'Counter', true).caution).toBeUndefined()
  })

  it('does not offer deleting the last file', () => {
    const one: DraftedFile[] = [{ path: 'client.ts', kind: 'file' }, { path: 'old.ts', kind: 'file', edit: 'deleted' }]
    expect(fileOffers(one[0], one, 'Counter', true).delete).toBe('A gadget needs at least one file.')
  })

  it('does not rename a file whose mode a change cannot carry, nor one with no text', () => {
    expect(fileOffers({ path: 'run.sh', kind: 'executable' }, files, 'Counter', true)).toMatchObject({ rename: false, duplicate: true, delete: true })
    expect(fileOffers({ path: 'link', kind: 'symlink' }, files, 'Counter', false)).toMatchObject({ rename: false, duplicate: false, delete: true })
    expect(fileOffers({ path: 'logo.png', kind: 'file' }, files, 'Counter', false)).toMatchObject({ rename: false, duplicate: false, delete: true })
  })

  it('offers only bringing a deleted file back', () => {
    expect(fileOffers({ path: 'a.ts', kind: 'file', edit: 'deleted' }, files, 'Counter', true)).toMatchObject({ rename: false, duplicate: false, restore: true })
  })
})

describe('toChange', () => {
  it('sets each file whole, and removes each deleted', () => {
    let draft = withFile(undefined, 'c1', 'client.ts', text('a'), 'b')
    draft = withFile(draft, 'c1', 'server.ts', text('s'), null)
    expect(toChange(draft!, 7)).toEqual({ 7: [['client.ts', { set: 'b' }], ['server.ts', { remove: true }]] })
  })
})

describe('conflictsWith and rebase', () => {
  const draft = withFile(withFile(undefined, 'c1', 'client.ts', text('a'), 'b'), 'c1', 'styles.css', text('s'), 't')!

  it('finds the files someone changed since the draft touched them', () => {
    expect(conflictsWith(draft, new Map([['client.ts', text('a')], ['styles.css', text('s2')]]))).toEqual(['styles.css'])
    expect(conflictsWith(draft, new Map([['client.ts', text('a')], ['styles.css', text('s')]]))).toEqual([])
  })

  it('moves the draft onto the head, letting go of what is already there as the draft has it', () => {
    const moved = rebase(draft, 'c2', new Map([['client.ts', text('b')], ['styles.css', text('s2')]]))!
    expect(moved.base).toBe('c2')
    expect([...moved.files]).toEqual([['styles.css', { before: text('s2'), after: 't' }]])
  })
})

describe('editedLine', () => {
  it('says which files were edited', () => {
    const one = withFile(undefined, 'c1', 'client.ts', text('a'), 'b')!
    expect(editedLine(one)).toBe('Edited client.ts')
    const two = withFile(one, 'c1', 'lib/styles.css', text('a'), 'b')!
    expect(editedLine(two)).toBe('Edited client.ts and styles.css')
    let many = two
    for (const name of ['a', 'b', 'c']) many = withFile(many, 'c1', name, ABSENT, '')!
    expect(editedLine(many)).toBe('Edited client.ts, styles.css, a, and 2 other files')
  })
})

describe('CodeDrafts', () => {
  it('keeps each gadget’s draft, and tells whoever listens when one changes', () => {
    const onAny = vi.fn<(any: boolean) => void>()
    const drafts = new CodeDrafts(onAny)
    const listener = vi.fn<() => void>()
    drafts.subscribe(listener)
    const draft = withFile(undefined, 'c1', 'a', text(''), 'x')
    drafts.set('w/1', draft)
    expect(drafts.get('w/1')).toBe(draft)
    expect(drafts.any).toBe(true)
    drafts.update('w/1', (was) => restoreFile(was, 'a'))
    expect(drafts.get('w/1')).toBeUndefined()
    expect(drafts.any).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(onAny.mock.calls).toEqual([[true], [false]])
  })
})
