# Text attachments in worktrees

Valid UTF-8 text uploads become files in a chat-private `ATTACHMENTS` worktree using
the ordinary Git object store and file tools. Images, PDFs, invalid UTF-8, and legacy
attachments retain their byte-preserving attachment storage behavior. Download/replay
reads the original upload's immutable Git blob, not a subsequently edited workspace file.

Filename allocation reserves existing base and pending root names, including directories.
Projection commits with the validated user message; failed sends leave uploads staged and
do not consume names. Later uploads receive collision-free suffixes. The worktree remains
available when a chat has already been seeded. No container integration is required.
