---
"@noy-db/hub": patch
---

**Managed link sets (`_links_*`) now replicate (family#210, PR 2 of 2).** A
link made on one device reaches a peer, a removal reaches it too, and a
restored device keeps its links. Previously `_links_*` reached nobody: the pull
path filters every `_`-collection and no replication rule named it.

The reserved mirror carries them, from the vault's **enumerated** declared link
sets rather than a `_links_*` name pattern. The mirror's declared rule list is
what makes "which reserved records travel" auditable; a regex would move that
answer out of a declaration, and nothing would then say which collections are
in scope for a given vault.

`propagateDeletes: false` — removal travels as the marker row added in PR 1,
which the version comparison carries like any other. Absence-based deletion is
not merely unnecessary here; it is the ambiguity the marker removed.

⚠️ **Declare your link sets before the first pull.** A device receives only the
sets it has enumerated, so a `vault.link()` call made *after* a pull silently
receives nothing for that set until the next one. This is the cost of the
auditable enumeration, it is asserted in a test rather than described, and it
is the same ordering requirement `provisionCollectionKeys` asks for with
collections.
