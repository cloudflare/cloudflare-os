# Skills Navigator Moves

Drag-and-drop is intentionally scoped to one collection. `ContextApi.moveContextDocument()` moves
a file or directory prefix atomically inside a collection, which is sufficient for moving skill
directories and their hidden supporting files.

Cross-collection moves are disabled. Implementing them in the client would require separate copy
and delete RPCs and could overwrite concurrent edits or leave partial data after a failure. A future
backend API should authorize both collections, reject read-only sources and destinations, preserve
the complete subtree, fail on destination conflicts, and provide recoverable or atomic semantics
before the UI allows these drops.
