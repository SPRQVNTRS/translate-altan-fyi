# What is inside the synced document, and what is deliberately not

`app/lib/sync/engine/envelope/` specifies the *envelope*: how the document is
framed, versioned and compare-and-swapped. This file is the other half, a
statement of what the client actually puts inside it.

IT IS PLAIN JSON, AND THE OPERATOR CAN READ IT (M191). The document used to be
encrypted under a key the server could not derive; the account model that
carried that key is gone, so every "the server cannot read this" sentence below
has been rewritten rather than softened. The one privacy claim that survives is
the one that was always structural: the search log is not in the document at
all.

## In the blob

- **Lists.** A user's vocabulary lists: name, order, timestamps.
- **List items.** The entries in those lists, each referencing a shared-zone
  headword or sense by its immutable UUID.
- **Notes.** Anything the user wrote for themselves against a word or a list.
- **Review state.** What the flashcard loop recorded about one saved word: how
  many times it was answered got-it, how many times still-learning, and when it
  was last reviewed. Keyed by the list entry's own id, one row per saved word.

Every one of these is a record of what a person does not yet know, which is why
none of it is stored in plaintext. Review state is the sharpest case of that: a
word answered still-learning twenty times is a precise statement about a
person's competence, and the server is not the place for it.

Review state carries no schedule. There is no due instant, no gap length and no
ease factor, so there is nothing in the blob a future scheduling algorithm could
be mistaken for. That is a product decision (milestone M174), and if it is ever
reversed the new fields arrive with a `SCHEMA_VERSION` bump like any other.

Review state joined the blob at `SCHEMA_VERSION` 2. Adding it needed no
migration in either direction: every collection defaults to empty on the way in,
so a blob written by a v1 device reads as "that device recorded no reviews",
which is exactly what was true.

Conflicts between two devices are resolved per entity by last write wins on
`(lamport, deviceId)`. The compare-and-swap on `blobVersion` protects the blob;
the lamport pair resolves the entities inside it. The server does neither, and
cannot: it sees one opaque byte string.

## Not in the blob: search history

Search history is **client only**. It is capped on the device, it is never
pushed, and there is no server endpoint that accepts it.

Two independent reasons, either of which would be sufficient.

1. **It is the fastest-growing personal entity and the least valuable to sync.**
   A whole-blob compare-and-swap rewrites every byte on every push. Putting a
   log that grows with every keystroke session into that write would make every
   push heavier for every user, permanently, to synchronise something a second
   device does not need.
2. **The capacity cliff is real.** One document holds a user's entire store and
   `MAX_BLOB_BYTES` is 2 MiB (`app/lib/sync/server/blob-store.server.ts`), so the
   fix past that cap is a chunking design rather than a patch. Feeding history
   into the document would spend the headroom the product's actual data needs.

## The append-only history log is NOT built

This service exposes no history endpoint, and the optional design (a separate
append-only log keyed by `(deviceId, lamport)`) is **not implemented**. It is written down as the
shape a future decision would take, not as a thing that exists.

If it is ever built, it is a separate log with its own endpoint. It is never
merged into the compare-and-swap blob, because a monotonic append stream and a
whole-document swap have opposite write patterns and merging them would give the
append stream the swap's cost.

## What the server knows

Everything in the document: the lists, the entries in them, the notes and the
review tallies. That is the honest answer since M191, and the privacy page says
it in as many words.

WHAT IT STILL DOES NOT KNOW IS WHAT WAS LOOKED UP. The search log is not in the
document, so there is nothing to store and no endpoint to leak it from. That
claim is kept true by the projection in `app/lib/local-store/blob-schema.ts`
plus a unit test on the serialized bytes
(`tests/unit/personal/blob-serializer.test.ts`), not by encryption.

`sync_blobs.size_bytes` is a denormalised copy of the document's length, so
reporting storage usage does not mean reading a 2 MiB column.
