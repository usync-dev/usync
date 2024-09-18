# `@usync/sync` Spec

This package provides a pure sync decision engine.

It does not do IO, parsing, file discovery, or snapshot construction. Those responsibilities belong to adapters or callers.

The engine receives two normalized snapshots and emits abstract actions.

## Concepts

### Logical Item

A logical item is the unit of synchronization.

Examples:

- a single file
- a pair of files, such as `item.data` and `item.meta`
- a larger bundle of related files

Each logical item has a stable `key` chosen by the adapter or caller.

### Snapshot

A snapshot is the normalized state of one side of sync.

```ts
export interface SyncSnapshot<TMeta = unknown, TItem = unknown> {
  metadata: TMeta;
  items: Record<string, TItem>;
}
```

The engine expects:

- `metadata.lastModified` to be a finite number
- `items[key].lastModified` to be a finite number
- `items[key].deleted` to be optional and boolean-like

### Action

An action is an instruction to update one side of sync.

```ts
export interface SyncAction {
  side: "left" | "right";
  type: "put" | "delete";
  key: string;
}
```

Action semantics:

- `side` identifies the target side for the action.
- `put` means write the winning item to the target side.
- `delete` means delete the item from the target side.
- An action applies to the item as defined by the adapter or caller, not necessarily to a single physical file.

## Exports

### `getSyncActions(leftData: SyncSnapshot, rightData: SyncSnapshot, mode: "push" | "pull" | "merge" = "merge"): SyncAction[]`

Computes the minimal set of actions needed to transform one side toward the other.

General rules:

- Compare only normalized snapshots.
- Operate by logical item `key`, not by physical file name.
- Return at most one action per `key` and target side.
- A missing item on one side is treated as deleted on that side.
- The engine must be deterministic for the same inputs.

Mode rules:

- `push`
  - The left side is the source of truth.
  - Every item present on the left must be mirrored to the right side.
  - Items missing on the left must be deleted from the right side if they exist there.
  - The left side is not modified.

- `pull`
  - The right side is the source of truth.
  - Every item present on the right must be mirrored to the left side.
  - Items missing on the right must be deleted from the left side if they exist there.
  - The right side is not modified.

- `merge`
  - Build the union of item keys from both snapshots.
  - For each key:
    - If the item exists on only one side, use that side as the winner.
    - If it exists on both sides, compare the item metadata provided by the snapshots.
    - The newer item wins.
    - If the item metadata is equal, prefer the side with the newer snapshot metadata.
    - If both snapshot metadata values are equal, prefer the left side for determinism.
  - If the winning item is deleted, both sides must end up deleted for that key.
  - If the winning item is active, the other side must end up with the winning item contents.

Conflict rules:

- A deleted item can win over an active item if it is newer.
- If both sides already match the winning state, no action is emitted.

## Adapter Responsibility

All format-specific work is out of scope for this package.

Adapters or callers are responsible for:

- reading drives or other backing stores
- parsing metadata files
- normalizing invalid input
- grouping physical files into logical items
- deciding how logical items map to `TItem`
- applying the returned actions

## File Sync Examples

The engine is intended to work with multiple layouts, including:

- one file per item
- two-file bundles
- metadata-plus-content bundles
- folder-backed items

## Out of Scope

- Authorization
- Drive lifecycle management
- File discovery
- Metadata parsing
- Snapshot construction
- Remote cleanup
- Expiring tombstones unless the adapter explicitly implements it
- Partial file sync inside one logical item unless the adapter explicitly models it

## Example Flow

```ts
const leftData = await adapter.loadSnapshot(leftDrive);
const rightData = await adapter.loadSnapshot(rightDrive);

const actions = getSyncActions(leftData, rightData, "merge");

// The caller applies actions and persists metadata.
```
