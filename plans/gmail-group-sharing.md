# Gmail group sharing

Design record for the Google Group resource in `gatekeeper-google`: why it is safe to show a
group's members mail read from the owner's mailbox. How to use and deploy it is in the package
README.

A Google Group connection reads only mail sent to one group, from the owner's mailbox.
Collaborators who are direct members of that group can open a gadget that uses it; nobody else
can. Everything lives in `gatekeeper-google`, but for the `screen` option on the kit's
`HookRegistry` (see Hooks). The platform's observer model does the rest (`docs/observers.md`
§10); nothing in `workshop-backend` or `workshop-shared` changed.

## Decisions

- **Mail is read live from the owner's mailbox.** There is no copy, no backfill and no ingestion
  pipeline. A member's read runs a Gmail query on the owner's mailbox, and every message is
  checked against the admission rule before anything about it is returned. The query only
  narrows the candidates; the rule decides.
- **One chokepoint.** Every read that names a message, thread or attachment re-fetches its
  headers and labels and passes them through `admitted()` in `gmail-group.ts`. Nothing reaches a
  member without passing through it, including IDs the agent supplies itself, and a capability
  handed out earlier is re-checked on every call.
- **Team connections are view only.** The group binding has its own session type with no action
  methods, and `applyAction` refuses every action for it.
- **Workspace and Cloud Identity groups only.** Membership is checked through the Cloud Identity
  Groups API, which does not cover consumer Google Groups (`@googlegroups.com`). Those are not
  offered.
- **Membership is checked with the observer's own token, as every other B binding checks
  access.** The verifier reads the observer's address from Google's userinfo endpoint (`email`,
  `email_verified`) and looks that address up among the group's direct members with the same
  token (`groups/<id>/memberships:lookup`). The observer asserts nothing: Google answers for both.
  The owner's token only resolves and pins the group. A first version asked the owner's token
  about the observer's address instead; it was dropped because the Workshop asks an observer's
  account for the grant of the binding's resource type, and a group under Gmail's type made every
  member grant Gmail read-write access to open a team gadget.
- **Fail closed.** Any error in identity, group lookup or membership denies the open, as the
  platform treats every operational failure (`plans/restricted-data-sharing.md`).
- **Its own resource type, with one scope.** Google Group is a grantable resource whose only scope
  is `cloud-identity.groups.readonly`, so that is all a member is asked for, and an admin can
  switch it off alone. The owner reads the mail with `gmail.readonly`, a private grant the
  dialog asks for, or with a Gmail Mailbox grant they already hold.
- **Any current direct member sees everything the binding reads.** That includes mail from before
  they joined, as the Chat conversation binding admits an observer who can open the space to its
  whole history (`docs/observers.md` §9.2, strategy B). A join-date rule was tried and dropped:
  since a workspace may keep what it was shown, it refused for good everyone who joined the group
  after the workspace first read anything, so every team gadget froze to its first day's
  membership. Google exposes a group's conversation-history setting to admins alone, so it can't
  be honoured; if a read-only route to it ever exists, it slots in as a tightening for groups that
  hide history (see Known risks).

The group's Cloud Identity name (`groups/<id>`) is resolved on first use and persisted in the
facet, so a group recreated under the same address is not silently trusted; a mismatch refuses
reads until the owner reconnects.

## Admission rule

Decided per message, never per thread. A message is admitted when **all** of these hold:

1. It carries none of `DRAFT`, `SPAM`, `TRASH`.
2. Either it was **delivered through the group**:
   - the topmost `Authentication-Results` header has authserv-id `mx.google.com`, `spf=pass`
     with `smtp.mailfrom=<local>+bnc…@<group domain>`, where `<local>` is the group's local part,
     and `dkim=pass` with `header.i` or `header.d` in the group's domain, whose signature (found
     by its `header.b` prefix) is from that domain and signs `List-ID`. SPF alone is not enough:
     every Google-hosted domain's SPF covers Google's shared senders, while only the domain holds
     its DKIM key;
   - the topmost `Return-Path` is that same bounce address;
   - `List-ID` is `<local.group domain>`;
   
   or it **addresses the group**:
   - `To` or `Cc` names the group's address or one of its Cloud Identity aliases
     (`additionalGroupKeys`), compared exactly after parsing with the existing address parser
     (`parseAddressList`), never by substring;
   - and the topmost `Authentication-Results` (authserv-id `mx.google.com`) has `dmarc=pass` for
     the `From` domain, or `dkim=pass` from that domain (or a parent of it) with a signature that
     signs `From`, the test DMARC applies, which Gmail may not report behind an inbound gateway;
   - or the message is the owner's own (`SENT`), in which case `Bcc` also counts and no
     authentication header is expected.

Only headers Gmail itself prepends are trusted: the topmost of each, never a later copy a sender
could have written. A message admitted by either path is returned whole; others in its thread are
dropped silently, so a thread shows the group's conversation and not the owner's side replies.

Each rule has an adversarial test with real header shapes: forged lower `Authentication-Results`,
look-alike addresses, display-name spoofing, `List-ID` alone, a reply that drops the group from
Cc, drafts and spam that would otherwise match, and a forged `Return-Path`.

## Reads

What keeps a member from learning about the owner's other mail:

- Messages are searched, not threads. Gmail matches a thread on any of its messages, so a thread
  search could list a conversation because of a reply the owner got alone. With a caller's query,
  a message with a `Bcc` never counts as the match, since a word search can match the `Bcc` of
  the owner's own message.
- A search may use only operators that test what a message says (`from:`, `subject:`, dates and
  the like). `label:`, `is:`, `in:`, `category:`, `deliveredto:` and `bcc:` test the owner's own
  state, which a member would otherwise learn from which messages match
  (`validateGmailGroupQuery`).
- Everything returned is built from admitted messages alone. Gmail's thread snippet, message
  count and history ID describe the whole thread, so none is passed through; the owner's labels
  and unread state are stripped; provider page tokens and result estimates stay inside the
  cursor.
- An ID the agent supplies gets one answer, "This isn't one of the group's messages.", whether it
  is missing, not the group's or malformed.
- Reads spend the owner's Gmail quota, which members share, so each call fetches a bounded number
  of provider pages.
- Reads set `containsRestrictedData`, so the web-fetch block keeps a prompt-injected agent from
  sending group mail to an arbitrary URL.

## Observers

Every read through a group binding, hook firings included, reports one subresource,
`gmail/group/<groupId>`: the group's Cloud Identity name (`groups/<groupId>`), as the owner's
reads pinned it. `verifyObserverAccess(observers, subresources)` on a group binding:

1. Refuses any ID but a group's, the owner's own `gmail/user/<sub>` included, which only a
   mailbox, label or search binding reports.
2. Asks each observer's `UserAccount` (`checkSubresourceAccess`), which reads the observer's
   address from userinfo with the observer's token (throwing unless `email_verified`) and looks
   it up among the group's direct members with the same token. A member is allowed; a
   non-member (404) or an account the group won't show its members to (403: the group's "Who can
   view members" setting excludes it) is not; a token without the scope throws, naming the
   grant; any other failure throws, which fails the check for the whole call. No refusal names
   the group or the observer.
3. The account reuses an allowed answer for up to 15 minutes and a denial for up to 15 seconds,
   as for every other Google subresource, so leaving the group takes effect within 15 minutes.

Only direct memberships are looked up, so members of a nested group are refused, and the
Enterprise-only transitive check is not needed.

`addObserver` is a no-op on a group binding, which has no reads from before reads reported
subresources. A whole-mailbox, label or search binding keeps refusing every observer, as today.

## Known risks

- **Mail addressed to the group that the group never delivered.** Gmail keeps one copy of a
  message that arrives twice, and when the owner is addressed directly that copy often lacks the
  group's headers, which is why a message naming the group is admitted. A message the group
  rejected or held for moderation, or that was never sent to the group at all (a sender writing
  only to the owner with the group in `To`), is then visible to members and wakes the group's
  hooks. It is the sender's own mail and DMARC proves who sent it; the agent's usual caution about
  untrusted mail applies. The README says so.
- **Nested groups are not followed.** Members through a nested group are refused (see
  Observers), which is narrower than Google Groups.
- **Newer members read older mail.** For a group whose history is off or limited to managers, a
  member who joined after a message can read it through a gadget when they couldn't in Google
  Groups. They are a verified direct member who receives every current message of the list, and
  the owner chose to share their own copies with the group. Accepted, as for Chat spaces; the
  README says so.
- **A sparse page says unconfirmed mail exists.** A search that spends its page budget on
  candidates the rule refuses returns an empty page with a cursor. A member learns only that the
  owner holds mail naming the group that can't be confirmed as the group's, nothing about it.
- **The rest of the workspace.** Data read through a binding outside a `use` collaborator's scope
  can reach them through gadget state (`plans/restricted-data-sharing.md`). Team gadgets should
  carry no personal bindings; the README says so.

## Hooks

A group binding's hook fires for each new message the admission rule admits, through
the existing watch on the owner's mailbox. Members see what the hook does, as they see any other
read.

No label narrows a group, so the mailbox driver's label prefilter can't spare the workspace the
owner's other mail. A group hook is registered `screened`: the driver asks the facet's `screen()`
before starting each firing (the `screen` callback of the kit's `HookRegistry`, which owns
delivery), and only the group's mail wakes the workspace. Otherwise every
message the owner received would start a firing, and its members could count them.

`screen()` runs for every message the owner receives, so it reads the group as last resolved
(name, address and aliases, cached in the facet each time a read resolves it) and the mailbox
address as last verified, making no Google request but the message read; `deliver()` resolves both
fresh. The cache is at most one read stale: mail
to an alias added since is screened out and waits for a read to show it, and mail to an alias
removed since still meets `deliver()`'s refusal. The driver's prefilter
drops `SENT` for other hooks, but lets it through to a screened hook, since the owner's own posts
to the group are the group's mail.

## Checked against a real Workspace org

- Cloud Identity accepts the product's own OAuth client in a managed org with default app access
  controls; the incremental consent was granted without allow-listing.
- Gmail returns duplicate headers (`Authentication-Results`, `Return-Path`, `Received`) in the
  same order for `format=metadata` with `metadataHeaders` and for `format=full`, so the admission
  rule's "topmost" reading holds. Gmail also drops an `Authentication-Results` a sender writes
  claiming `mx.google.com`, and writes its own, even for mail between users of the same org.
- `memberships:searchDirectGroups` rejects an `in labels` clause with 400, so the mailbox label is
  checked on each result instead.
- Until a Workspace domain turns on DKIM, Google signs its mail with a `gappssmtp.com` key, which
  the admission rule doesn't count as the domain's: nothing was admitted, and the connect check
  reported the group's mail as unverified, until DKIM was on. Mail signed before stays hidden.
- Forged group headers on mail a member sent to the owner alone were overwritten by Gmail's own
  `Authentication-Results`; the message was neither listed nor found by search.
- A member removed from the group kept a workspace they had open, new group mail included, until
  they reopened it (`docs/observers.md` §6). An owner who leaves the group keeps sharing the
  copies they already have, since membership is checked for the opener, not the owner.

Still to check: that a nested external member of an internal group, whom the membership lookup
refuses, also no longer receives the group's mail (Google's 2026 classification change).
