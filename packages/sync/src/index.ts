export interface SyncSnapshotMetadata {
  lastModified: number;
}

export interface SyncItemState {
  lastModified: number;
  deleted?: boolean;
}

export interface SyncSnapshot<
  TMeta extends SyncSnapshotMetadata = SyncSnapshotMetadata,
  TItem extends SyncItemState = SyncItemState,
> {
  metadata: TMeta;
  items: Record<string, TItem>;
}

export interface SyncAction {
  side: "left" | "right";
  type: "put" | "delete";
  key: string;
}

type SyncSide = "left" | "right";
type SyncMode = "push" | "pull" | "merge";

function isDeleted(item: SyncItemState | undefined): boolean {
  return item?.deleted === true || item === undefined;
}

function hasSameEffectiveState(
  left: SyncItemState | undefined,
  right: SyncItemState | undefined,
): boolean {
  if (isDeleted(left) && isDeleted(right)) return true;
  if (left !== undefined && right !== undefined && left.deleted !== true && right.deleted !== true) {
    return left.lastModified === right.lastModified;
  }
  return false;
}

function compareSnapshotMetadata(
  left: SyncSnapshotMetadata,
  right: SyncSnapshotMetadata,
): number {
  if (left.lastModified < right.lastModified) return -1;
  if (left.lastModified > right.lastModified) return 1;
  return 0;
}

function pickWinner(
  left: SyncItemState | undefined,
  right: SyncItemState | undefined,
  leftMeta: SyncSnapshotMetadata,
  rightMeta: SyncSnapshotMetadata,
): SyncSide | null {
  if (left === undefined) return right === undefined ? null : "right";
  if (right === undefined) return "left";

  const leftItem = left;
  const rightItem = right;

  if (leftItem.lastModified > rightItem.lastModified) return "left";
  if (leftItem.lastModified < rightItem.lastModified) return "right";

  const leftDeleted = leftItem.deleted === true;
  const rightDeleted = rightItem.deleted === true;
  if (leftDeleted !== rightDeleted) {
    return leftDeleted ? "left" : "right";
  }

  const metaComparison = compareSnapshotMetadata(leftMeta, rightMeta);
  if (metaComparison < 0) return "right";
  if (metaComparison > 0) return "left";

  return "left";
}

function pushOrPullActions(
  source: Record<string, SyncItemState>,
  target: Record<string, SyncItemState>,
  side: SyncSide,
): SyncAction[] {
  const actions: SyncAction[] = [];
  const keys = new Set([...Object.keys(source), ...Object.keys(target)]);
  for (const key of keys) {
    const sourceItem = source[key];
    const targetItem = target[key];
    if (sourceItem === undefined || sourceItem.deleted === true) {
      if (targetItem !== undefined && targetItem.deleted !== true) {
        actions.push({ side, type: "delete", key });
      }
      continue;
    }
    if (!hasSameEffectiveState(sourceItem, targetItem)) {
      actions.push({ side, type: "put", key });
    }
  }
  return actions;
}

export function getSyncActions<
  TMeta extends SyncSnapshotMetadata = SyncSnapshotMetadata,
  TItem extends SyncItemState = SyncItemState,
>(
  leftData: SyncSnapshot<TMeta, TItem>,
  rightData: SyncSnapshot<TMeta, TItem>,
  mode: SyncMode = "merge",
): SyncAction[] {
  if (mode === "push") {
    return pushOrPullActions(leftData.items, rightData.items, "right");
  }
  if (mode === "pull") {
    return pushOrPullActions(rightData.items, leftData.items, "left");
  }

  const actions: SyncAction[] = [];
  const keys = new Set([...Object.keys(leftData.items), ...Object.keys(rightData.items)]);
  for (const key of keys) {
    const leftItem = leftData.items[key];
    const rightItem = rightData.items[key];
    const winner = pickWinner(leftItem, rightItem, leftData.metadata, rightData.metadata);
    if (winner === null) continue;

    if (winner === "left") {
      if (!hasSameEffectiveState(leftItem, rightItem)) {
        actions.push({
          side: "right",
          type: isDeleted(leftItem) ? "delete" : "put",
          key,
        });
      }
      continue;
    }

    if (!hasSameEffectiveState(rightItem, leftItem)) {
      actions.push({
        side: "left",
        type: isDeleted(rightItem) ? "delete" : "put",
        key,
      });
    }
  }
  return actions;
}
