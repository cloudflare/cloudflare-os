# Resource type identity

Each selectable `SupportedResource` has a stable, vendor-scoped `id`, such as GitHub's
`repository`. The ID identifies the kind of resource in tool calls, configurator calls,
blueprint bindings, creation requests, account grants and admin restrictions. Keep it unchanged
when renaming the type or changing its URL grammar, and never reuse it for another kind of grant.

`urlPattern` still matches concrete resource URLs and supplies configurator prefill information.
An ID does not make an old concrete URL valid under a new grammar. Gatekeepers remain responsible
for parsing resource URLs and enforcing the authority of the selected resource.

## Compatibility and stored references

Older gatekeepers may omit `id`. Their exact current URL pattern remains their selector at the
RPC boundary. New persisted records for those gatekeepers retain a legacy pattern reference;
they do not claim that the pattern is a stable ID. Advertising an ID also promises that the
gatekeeper accepts ID selectors in its configurator, creation and grant methods.

An existing record without an ID resolves only if its pattern exactly matches a currently
advertised type. New records for upgraded gatekeepers store the ID. This is read-through
compatibility, not a bulk rewrite of every historical record. An explicit unknown ID never falls
back to a saved pattern, a matching URL, a display name or the vendor's only remaining type.

If a legacy pattern no longer matches, the record needs an explicit configuration update or
reconnection. The old pattern contains no trustworthy mapping to the new type. An unmatched legacy
admin restriction blocks that vendor until an admin explicitly clears it; it must not disappear
just because a gatekeeper changes its patterns. The admin panel keeps such restrictions visible.
Editing a vendor's restrictions upgrades exact known matches to IDs while retaining unknown ones.

Account grant lists retain the distinction between omitted (legacy full grant) and empty (no
grants). An explicit ID grant list takes precedence over a legacy pattern list, including when
empty. Legacy grants translate by exact current match. A gatekeeper may separately retain explicit
historical mappings that it already knows; the Workshop does not guess them.
