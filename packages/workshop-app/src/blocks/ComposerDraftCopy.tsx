import { Fragment } from 'react'
import { ComposerPill } from './ComposerPill'
import type { DraftDocument } from './composerDraft'

/**
 * A draft as it is drawn, with nothing to write in: what the composer measures to know how much
 * room the draft takes at a width it is not at. Its pills are laid out as the draft's own are.
 */
export const ComposerDraftCopy = ({ draft }: { draft: DraftDocument }) => (
  <>
    {draft.map((node) => (typeof node === 'string' ? node : (
      // With the room the editor keeps before each pill for a cursor, which is part of how wide
      // the draft is.
      <Fragment key={node.id}>
        <span className="composer-draft-caret" />
        <span className="composer-draft-pill"><span><ComposerPill pill={node} /></span></span>
      </Fragment>
    )))}
    {/* The line a draft that ends in a new one has after it, which is otherwise not there. */}
    {'\u200b'}
  </>
)
