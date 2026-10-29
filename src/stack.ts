// Pure stack model: no vscode / git imports, so it can be unit tested.

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision?: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  author?: { login: string };
  /** Opened by the signed-in GitHub user. */
  mine?: boolean;
}

export type Scope = 'mine' | 'everyone';

/** Someone else's PR: view only, never rebased or pushed by this extension. */
export function isForeign(b: BranchInfo | undefined): boolean {
  return !!b?.pr && !b.pr.mine;
}

/** Branches in a plan that belong to someone else (the plan must not run if non-empty). */
export function foreignInPlan(plan: MovePlan, branches: Map<string, BranchInfo>): string[] {
  return plan.restack.map(r => r.branch).filter(b => isForeign(branches.get(b)));
}

/** `root` plus its descendants, skipping (and not descending into) branches that fail `keep`. */
export function ownSubtree(parents: ParentMap, root: string, keep: (b: string) => boolean): { own: string[]; skipped: string[] } {
  const own: string[] = [];
  const skipped: string[] = [];
  const walk = (b: string) => {
    if (!keep(b)) { skipped.push(b); return; }
    own.push(b);
    for (const c of childrenOf(parents, b)) walk(c);
  };
  walk(root);
  return { own, skipped };
}

export interface BranchInfo {
  name: string;
  worktree?: string;   // absolute path of the worktree that has this branch checked out
  pr?: PrInfo;
  rebasing?: boolean;  // worktree is mid-rebase
  dirty?: boolean;     // worktree has uncommitted changes
}

/** child branch -> parent branch */
export type ParentMap = Map<string, string>;

export function childrenOf(parents: ParentMap, name: string): string[] {
  const out: string[] = [];
  for (const [child, parent] of parents) {
    if (parent === name) out.push(child);
  }
  return out.sort();
}

export function ancestors(parents: ParentMap, name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([name]);
  let cur = parents.get(name);
  while (cur !== undefined && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parents.get(cur);
  }
  return out;
}

export function descendants(parents: ParentMap, name: string): string[] {
  const out: string[] = [];
  const queue = [...childrenOf(parents, name)];
  const seen = new Set<string>([name]);
  while (queue.length) {
    const b = queue.shift()!;
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(b);
    queue.push(...childrenOf(parents, b));
  }
  return out;
}

/** Roots are parents that are not themselves tracked branches (trunk, or a foreign base). */
export function roots(parents: ParentMap, trunk: string): string[] {
  const rs = new Set<string>([trunk]);
  for (const parent of parents.values()) {
    if (!parents.has(parent)) rs.add(parent);
  }
  return [trunk, ...[...rs].filter(r => r !== trunk).sort()];
}

/**
 * Break cycles (can happen with hand-edited config / odd PR bases) by
 * re-pointing the offending branch at trunk.
 */
export function sanitize(parents: ParentMap, trunk: string): ParentMap {
  const out = new Map(parents);
  out.delete(trunk);
  for (const b of [...out.keys()]) {
    const seen = new Set<string>([b]);
    let cur = out.get(b);
    while (cur !== undefined) {
      if (seen.has(cur)) { out.set(b, trunk); break; }
      seen.add(cur);
      cur = out.get(cur);
    }
  }
  return out;
}

export interface Restack {
  branch: string;
  oldParent: string;
  newParent: string;
}

export interface MovePlan {
  newParents: ParentMap;
  /** Branches whose parent changed. */
  reparented: Restack[];
  /** Every branch that must be rebased, in a safe order (parents before children). */
  restack: Restack[];
}

/**
 * Drop `moving` onto `target`.
 *
 * Semantics ("move one PR, not its subtree"):
 *  1. `moving` is lifted out of its stack; its children re-attach to its old parent.
 *  2. If `target` then has exactly one child, `moving` is inserted between them
 *     (target -> moving -> oldChild). This is the normal "reorder a linear stack" case.
 *     If target has zero or several children (or its only child is someone else's PR),
 *     `moving` just becomes a new child
 *     of target (a fork), and existing siblings are left alone.
 */
export function planMove(
  parents: ParentMap,
  trunk: string,
  moving: string,
  target: string,
  /** Branches that may be re-parented; a target's only child that may not is left alone (fork instead). */
  canReparent: (b: string) => boolean = () => true,
): MovePlan {
  if (moving === trunk) throw new Error(`Can't move the trunk branch (${trunk}).`);
  if (moving === target) throw new Error('Drop target is the same branch.');
  if (!parents.has(moving)) throw new Error(`Unknown branch: ${moving}`);

  const oldParent = parents.get(moving)!;
  const next: ParentMap = new Map(parents);

  // 1. lift out
  for (const c of childrenOf(parents, moving)) next.set(c, oldParent);
  next.delete(moving);

  // 2. insert
  const targetKids = childrenOf(next, target);
  if (targetKids.length === 1 && canReparent(targetKids[0])) next.set(targetKids[0], moving);
  next.set(moving, target);

  return finishPlan(parents, next, trunk);
}

/** Re-parent a branch together with its whole subtree (used by "Move onto…" when asked). */
export function planMoveSubtree(
  parents: ParentMap,
  trunk: string,
  moving: string,
  target: string,
): MovePlan {
  if (moving === trunk) throw new Error(`Can't move the trunk branch (${trunk}).`);
  if (moving === target) throw new Error('Drop target is the same branch.');
  if (descendants(parents, moving).includes(target)) {
    throw new Error(`Can't move ${moving} with its subtree onto its own descendant ${target}.`);
  }
  const next: ParentMap = new Map(parents);
  next.set(moving, target);
  return finishPlan(parents, next, trunk);
}

function finishPlan(old: ParentMap, next: ParentMap, trunk: string): MovePlan {
  const reparented: Restack[] = [];
  for (const [b, np] of next) {
    const op = old.get(b);
    if (op !== np) reparented.push({ branch: b, oldParent: op ?? trunk, newParent: np });
  }

  // Everything reparented, plus everything below them in the new tree, needs a rebase.
  const need = new Set<string>();
  for (const r of reparented) {
    need.add(r.branch);
    for (const d of descendants(next, r.branch)) need.add(d);
  }

  const depth = (b: string) => ancestors(next, b).length;
  const restack = [...need]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .map(b => ({ branch: b, oldParent: old.get(b) ?? trunk, newParent: next.get(b)! }));

  return { newParents: next, reparented, restack };
}

export function describePlan(plan: MovePlan): string {
  if (plan.reparented.length === 0) return 'Nothing changes.';
  const lines = plan.reparented.map(r => `• ${r.branch}: ${r.oldParent} → ${r.newParent}`);
  const extra = plan.restack.length - plan.reparented.length;
  if (extra > 0) lines.push(`• +${extra} descendant branch(es) restacked`);
  return lines.join('\n');
}
