import { describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { readSnapshotFile } from './inlineFiles'

const A = 'a'.repeat(40)
describe('snapshotted file reads', () => {
  it('reads only the message snapshot OID, streaming the exact original bytes', async () => {
    const bytes = Uint8Array.of(0, 255, 17)
    const readBlob = vi.fn<Overseer['readBlob']>(async () => new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close() },
    }))
    const images = { oids: { 'worktree://REPO/my%20image.png': A }, readBlob }
    const image = await readSnapshotFile(images, 'worktree://REPO/my%20image.png')
    expect(image.oid).toBe(A)
    expect(new Uint8Array(await new Response(image.stream).arrayBuffer())).toEqual(bytes)
    expect(readBlob).toHaveBeenCalledWith(A)
  })

  it.each(['worktree://REPO/other.png', 'worktree://REPO/missing.png', 'worktree:REPO/image.png',
    `git-blob:${A}`, 'https://example.com/a.png', 'file:///secret'])(
    'refuses unpinned or unsupported files: %s', async source => {
      const readBlob = vi.fn<Overseer['readBlob']>()
      await expect(readSnapshotFile({ oids: { 'worktree://REPO/missing.png': null }, readBlob }, source))
        .rejects.toThrow(/File unavailable/)
      expect(readBlob).not.toHaveBeenCalled()
    })
})
