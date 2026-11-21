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
  headers and labels and passes them through `admitted()` or `admits()` in `gmail-group.ts`.
  Nothing reaches a member without passing through one, including IDs the agent supplies itself,
  and a capability handed out earlier is re-checked on every call, an attachment's before each
  fetch of its bytes.
- **Nobody outside the group's domain starts a conversation without the group.** Mail that only
  names the group never met the group's rules about who may post, and anyone can send the owner
  such mail. From outside the group's domain it is shown only in a conversation that already
  holds a message the group delivered, the owner sent, or a colleague sent (see Admission rule).
  A first version admitted any authenticated sender's; it was dropped as the rule for every
  group because it let anyone on the internet put words in front of a team's agents and wake its
  hooks, whatever the group itself allowed.
- **The owner says when the group takes outside mail.** A feedback or support address is written to
  by strangers, often with a teammate addressed as well, and its hooks must fire at once. A
  binding whose URL ends `?senders=anyone` (the dialog's "Who emails this group? Anyone, including people outside")
  admits authenticated mail from anywhere that names the group, as the first version did. That
  gives a stranger nothing the group doesn't: they could have written to it. The group's own
  setting for who may post is readable by its managers alone, so it can't be read instead; an
  owner who chooses Anyone for an internal group has only widened what their own gadget shows
  its members. The stricter rule is the default.
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
reads until the owner reconnects. A session asks again, at most every five seconds and before
each page of a cursor, whether the group still answers at the addresses it was opened with, and
stops if not: an address the group gave up may be another group's by now. The dialog refuses an
address that is a group's alias, since a binding is pinned and matched by the main one. The
group's name is not carried in the binding's URL, so a group renamed between the dialog's check
and the binding's first read is pinned as whatever then answers at the address. Once Cloud
Identity says the pinned group is deleted, hook screening stops taking any mail for it and a
delivery already queued ends without being tried again. A new binding to a recreated group shows nothing that arrived
before Cloud Identity says the group was created (`createTime`), which is an earlier group's
mail.

## Admission rule

Each message is given a standing from its own headers (`groupStanding()`): `own`, `reply` or
`none`. An `own` message is admitted wherever it is. A `reply` is admitted only while its thread
holds an `own` message, so reading one alone (by ID, or as a hook's new message) reads its thread
too. A message that carries any of `DRAFT`, `SPAM`, `TRASH`, or that arrived before the group
was created, is `none`.

A message is `own` when one of these holds:

1. It was **delivered through the group**:
   - the topmost `Authentication-Results` header has authserv-id `mx.google.com`, `spf=pass`
     with `smtp.mailfrom=<local>+bnc…@<group domain>`, where `<local>` is the group's local part,
     and `dkim=pass` with `header.i` or `header.d` in the group's domain, whose signature (found
     by its `header.b` prefix) is from that domain and signs `List-ID`. SPF alone is not enough:
     every Google-hosted domain's SPF covers Google's shared senders, while only the domain holds
     its DKIM key;
   - the topmost `Return-Path` is that same bounce address;
   - `List-ID` is `<local.group domain>`.
2. It is **the owner's own** (`SENT`) and `To`, `Cc` or `Bcc` names the group. No authentication
   header is expected.
3. It **addresses the group, from the group's own domain**:
   - `To` or `Cc` names the group's address or one of its Cloud Identity aliases
     (`additionalGroupKeys`), compared exactly after parsing with the existing address parser
     (`parseAddressList`), never by substring;
   - the topmost `Authentication-Results` (authserv-id `mx.google.com`) has `dmarc=pass` for
     the `From` domain, or `dkim=pass` from that domain (or a parent of it) with a signature that
     signs `From`, the test DMARC applies, which Gmail may not report behind an inbound gateway;
   - the `From` domain is exactly the domain of the group's address;
   - and it has no `List-ID`.

A message that meets the first two tests of 3 and has no `List-ID`, from any other `From`
domain, a subdomain or another of the organization's domains included, is a `reply`, or `own` on
a binding that takes outside mail (`?senders=anyone`).

A message with a `List-ID` that this group didn't deliver is `none` on every binding: some other
list delivered that copy. A list resends an outsider's mail under its own address, so what Gmail
authenticated is the list and nothing says who wrote it, and the bound group may have refused
the same post. The cost: when a message goes to two lists the owner is on, Gmail may keep the
other list's copy alone, and it is then not shown.

Only headers Gmail itself prepends are trusted: the topmost of each, never a later copy a sender
could have written. An admitted message is returned whole; others in its thread are dropped
silently, so a thread shows the group's conversation and not the owner's side replies.

Why 3 and `reply` exist at all: Gmail keeps one copy of a message that arrives twice, and when
the owner is addressed directly that copy often lacks the group's headers, so a reply-all to the
owner and the group would otherwise vanish from its conversation.

Each rule has an adversarial test with real header shapes: forged lower `Authentication-Results`,
look-alike addresses, display-name spoofing, `List-ID` alone, a reply that drops the group from
Cc, drafts and spam that would otherwise match, a forged `Return-Path`, an outsider's mail that
only names the group, a look-alike of the group's domain, and a conversation whose only `own`
message is in the trash.

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
  count and history ID describe the whole thread, so none is passed through: a conversation's
  snippet is its newest admitted message's own. The owner's labels and unread state are stripped;
  provider page tokens and result estimates stay inside the cursor.
- `replyTo` is passed through as the message carries it. Google Groups resends mail from a domain
  with a strict DMARC policy under the group's own address ("Name via Group"), so `from` alone
  would show most outside senders as the group. It is documented as a reply destination only:
  the group's "post replies to" setting can make it the group, its owners or a custom address.
- An ID the agent supplies gets one answer, "This isn't one of the group's messages.", whether it
  is missing, not the group's or malformed.
- Reads spend the owner's Gmail quota, which members share, so each call fetches a bounded number
  of provider pages.
- No read is `containsRestrictedData`, as none of a Gmail Mailbox or Chat conversation binding
  is. Who may open a gadget is decided by the group every read reports, not by that mark. A
  first version set it, to keep a prompt-injected agent from fetching a URL with group mail in
  it; it was dropped because it also suspends auto-approval for the whole workspace for good, so
  a hook that files each new message somewhere asked for approval every time, which is the
  thing a team connects a group for. A workspace that reads group mail is as exposed to what
  the mail says as one that reads a mailbox (see Known risks).
- An attachment is a mailbox binding's own capability (`GmailAttachmentStub`, `readPdf()`
  included) over that queue, with the message admitted again before each fetch of its bytes.

## Observers

Every read through a group binding, hook firings included, reports one subresource,
`gmail/group/<groupId>`: the group's Cloud Identity name (`groups/<groupId>`), as the owner's
reads pinned it. `verifyObserverAccess(observers, subresources)` on a group binding:

1. Refuses any ID but a group's, the owner's own `gmail/user/<sub>` included, which only a
   mailbox, label or search binding reports.
2. Asks each observer's `UserAccount` (`checkSubresourceAccess`), which reads the observer's
   address from userinfo with the observer's token (throwing unless `email_verified`) and looks
   it up among the group's direct members with that very token, so a reconnect between the two
   can't have one account answer for another's address; a token Google refuses is replaced
   once and both are asked again. A member is allowed; a
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

- **Mail addressed to the group that the group never delivered.** A message the group rejected
  or held for moderation, or that was never sent to the group at all (a sender writing only to
  the owner with the group in `To`), is visible to members and wakes the group's hooks when a
  colleague on the group's own domain sent it, or when anyone sent it into a conversation that
  is already the group's. So the group's posting rules don't bind colleagues, and don't bind
  someone already party to one of its conversations (Gmail threads a reply by the `Message-ID`s
  it cites, which only a recipient knows). It is the sender's own mail and DMARC proves who sent
  it; the agent's usual caution about untrusted mail applies. The README says so.
- **Outside mail that only names the group, and nobody answered** (default binding only). A new message from outside
  the group's domain, sent to the owner and the group both, may reach the owner only as the
  direct copy. It stays hidden, and wakes no hook, until the conversation holds a message that
  is the group's: the group's own delivery of a reply, or the owner's or a colleague's
  reply-all. A hook does not fire again for it then. An organization with several domains has
  the same wait for colleagues on a domain other than the group's.
- **An alias that used to be another group's.** An alias moved to this group brings the mail
  that named it while it was the other group's, when a colleague sent it or the binding takes
  outside mail: nothing in a message says which group an address was when it arrived. Mail the
  other group delivered is not shown, since delivery is proved against the primary address.
- **What the mail says reaches an agent that can act.** Group mail is other people's words, a
  stranger's on a binding that takes outside mail, and the workspace keeps its web fetches and
  auto-approval rules. An injected agent can send mail it has read wherever those reach, as
  with a Gmail Mailbox binding.
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
message the owner received would start a firing, and its members could count them. Screening
a `reply` reads its thread as well, so an outsider's mail that only names the group costs two
requests and still wakes nothing.

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

Still to check:

- That a nested external member of an internal group, whom the membership lookup refuses, also no
  longer receives the group's mail (Google's 2026 classification change).
- That mail Google Groups resends under the group's address carries the person who wrote it in
  `Reply-To`, whatever the group's "post replies to" setting, and whether `X-Original-From` is a
  better source.
- That Gmail never threads a message into a conversation whose `Message-ID`s it doesn't cite,
  which the `reply` standing relies on.
- What Google Groups does with a `List-ID` a message arrives with. The topmost is compared, and
  the bounce address and the domain's signature already prove the delivery, so a second one
  changes nothing today.
- That Cloud Identity returns `createTime` for every group; a group without one can't be read.
