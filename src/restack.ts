import { Repo } from './git';
import { Restack } from './stack';

/** One rebase step with its upstream already resolved to a commit SHA. */
export interface Step extends Restack {
  upstream: string;
}

export interface PendingRestack {
  steps: Step[];   // remaining, first one may be the conflicted step
  conflicted?: string;
  /** Branches whose parent changed in this operation (their PR base may need updating). */
  reparented?: string[];
}

export type Outcome =
  | { kind: 'done'; rebased: string[] }
  | { kind: 'conflict'; branch: string; worktree: string; pending: PendingRestack; rebased: string[] };

/**
 * Resolve each branch's "old base" commit BEFORE anything is rewritten.
 *
 * Preference: the parent SHA we recorded at the last restack (exact, survives the parent
 * being amended/rebased), if it's still an ancestor of the branch. Otherwise the current
 * tip of the old parent, or failing that, the merge-base with it.
 */
export async function resolveSteps(
  repo: Repo,
  restack: Restack[],
  storedSha: Map<string, string | undefined>,
): Promise<Step[]> {
  const steps: Step[] = [];
  for (const r of restack) {
    let upstream: string | undefined;
    const recorded = storedSha.get(r.branch);
    if (recorded && (await repo.isAncestor(recorded, r.branch).catch(() => false))) {
      upstream = recorded;
    } else {
      const tip = await repo.revParse(r.oldParent).catch(() => undefined);
      if (tip && (await repo.isAncestor(tip, r.branch))) upstream = tip;
      else upstream = await repo.mergeBase(r.branch, r.oldParent);
    }
    steps.push({ ...r, upstream });
  }
  return steps;
}

export async function preflight(repo: Repo, steps: Step[], worktreeOf: (b: string) => string | undefined): Promise<string[]> {
  const problems: string[] = [];
  for (const s of steps) {
    const wt = worktreeOf(s.branch);
    if (!wt) {
      problems.push(`${s.branch} has no worktree.`);
      continue;
    }
    if (await repo.isRebasing(wt)) problems.push(`${s.branch}: a rebase is already in progress.`);
    else if (await repo.isDirty(wt)) problems.push(`${s.branch}: worktree has uncommitted changes.`);
  }
  return problems;
}

export async function execute(
  repo: Repo,
  steps: Step[],
  worktreeOf: (b: string) => string | undefined,
  progress?: (msg: string) => void,
): Promise<Outcome> {
  const rebased: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const wt = worktreeOf(s.branch)!;
    progress?.(`Rebasing ${s.branch} onto ${s.newParent}`);
    const parentSha = await repo.revParse(s.newParent);
    try {
      await repo.rebaseOnto(wt, s.newParent, s.upstream);
    } catch (e) {
      if (await repo.isRebasing(wt)) {
        return {
          kind: 'conflict',
          branch: s.branch,
          worktree: wt,
          rebased,
          // keep the conflicted step's metadata so we can record its parent SHA after --continue
          pending: { steps: steps.slice(i), conflicted: s.branch },
        };
      }
      throw e;
    }
    await repo.setStoredParentSha(s.branch, parentSha);
    rebased.push(s.branch);
  }
  return { kind: 'done', rebased };
}

/** Pick up after the user resolved a conflict and ran `git rebase --continue` (or --abort). */
export async function resume(
  repo: Repo,
  pending: PendingRestack,
  worktreeOf: (b: string) => string | undefined,
  progress?: (msg: string) => void,
): Promise<Outcome> {
  let steps = pending.steps;
  if (pending.conflicted && steps[0]?.branch === pending.conflicted) {
    const first = steps[0];
    const wt = worktreeOf(first.branch)!;
    if (await repo.isRebasing(wt)) {
      return { kind: 'conflict', branch: first.branch, worktree: wt, pending, rebased: [] };
    }
    // Finished (or aborted). Only record success if the branch now sits on the new parent.
    const parentSha = await repo.revParse(first.newParent);
    if (!(await repo.isAncestor(parentSha, first.branch))) {
      throw new Error(`${first.branch} is not on top of ${first.newParent} — was the rebase aborted? Restack cancelled.`);
    }
    await repo.setStoredParentSha(first.branch, parentSha);
    steps = steps.slice(1);
    const rest = await execute(repo, steps, worktreeOf, progress);
    rest.rebased.unshift(first.branch);
    if (rest.kind === 'conflict') rest.pending.reparented = pending.reparented;
    return rest;
  }
  return execute(repo, steps, worktreeOf, progress);
}
