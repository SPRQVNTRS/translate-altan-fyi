# What is inside the encrypted blob, and what is deliberately not

`PROTOCOL.md` specifies the *envelope*: how the blob is framed, encrypted,
versioned and compare-and-swapped. It says nothing about the plaintext, because
the server cannot read the plaintext and therefore has no opinion about it.

This document is that missing half, for this product. It is a statement of what
the client puts in the blob. It is not a wire contract, and changing it does not
bump `PROTOCOL_VERSION`.

## In the blob

- **Lists.** A user's vocabulary lists: name, order, timestamps.
- **List items.** The entries in those lists, each referencing a shared-zone
  headword or sense by its immutable UUID.
- **Notes.** Anything the user wrote for themselves against a word or a list.

Every one of these is a record of what a person does not yet know, which is why
none of it is stored in plaintext.

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
2. **The capacity cliff is real and dated.** `PROTOCOL.md` section 8 states it
   plainly: one blob holds an account's entire store, `MAX_BLOB_BYTES` is 2 MiB,
   and the fix past that cap is a protocol version bump rather than a patch.
   `blob-size-telemetry.ts` exists because upstream had to watch that number
   climb. Feeding history into the blob would spend the headroom that the
   product's actual data needs.

## The append-only history log is NOT built

`PROTOCOL.md` has no history endpoint, this service exposes none, and the
milestone's optional design (a separate append-only encrypted log keyed by
`(deviceId, lamport)`) is **not implemented in v1**. It is written down as the
shape a future decision would take, not as a thing that exists.

If it is ever built, it is a separate log with its own endpoint. It is never
merged into the compare-and-swap blob, because a monotonic append stream and a
whole-document swap have opposite write patterns and merging them would give the
append stream the swap's cost.

## What the server knows

Exactly what `PROTOCOL.md` section 9.2 already admits, and nothing this document
adds: the byte length of the blob, its version numbers, when it was written, and
that the account exists. `sync_blobs.size_bytes` is a denormalised copy of the
first of those, so reporting storage usage does not mean reading a 2 MiB column.

There is no history endpoint to leak a query from, and there is no code path in
`app/routes/api.v1.sync.blob.ts` or `app/services/e2ee-storage-adapter.server.ts`
that decrypts, decompresses or parses the payload. The bytes that arrive are the
bytes that are stored.
