import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planMove, planMoveSubtree, sanitize } from '../stack';
import { Repo } from '../git';
import { execute, Outcome, resolveSteps, resume } from '../restack';

const pm = (o: Record<string, string>) => new Map(Object.entries(o));
const obj = (m: Map<string, string>) => Object.fromEntries([...m].sort());

test('reorder in a linear stack: move B after C', () => {
  // main <- A <- B <- C <- D
  const p = pm({ A: 'main', B: 'A', C: 'B', D: 'C' });
  const plan = planMove(p, 'main', 'B', 'C');
  assert.deepEqual(obj(plan.newParents), { A: 'main', C: 'A', B: 'C', D: 'B' });
  assert.deepEqual(plan.restack.map(r => r.branch), ['C', 'B', 'D']);
});

test('move to the bottom of the stack (drop on trunk)', () => {
  const p = pm({ A: 'main', B: 'A', C: 'B' });
  const plan = planMove(p, 'main', 'C', 'main');
  assert.deepEqual(obj(plan.newParents), { C: 'main', A: 'C', B: 'A' });
  assert.deepEqual(plan.restack.map(r => r.branch), ['C', 'A', 'B']);
});

test('move to the top (drop on last)', () => {
  const p = pm({ A: 'main', B: 'A', C: 'B' });
  const plan = planMove(p, 'main', 'A', 'C');
  assert.deepEqual(obj(plan.newParents), { B: 'main', C: 'B', A: 'C' });
});

test('drop onto a branch with several children forks instead of stealing siblings', () => {
  const p = pm({ A: 'main', X: 'A', Y: 'A', Z: 'main' });
  const plan = planMove(p, 'main', 'Z', 'A');
  assert.deepEqual(obj(plan.newParents), { A: 'main', X: 'A', Y: 'A', Z: 'A' });
  assert.deepEqual(plan.restack.map(r => r.branch), ['Z']);
});

test('dropping on current parent in linear stack is a no-op', () => {
  const p = pm({ A: 'main', B: 'A' });
  const plan = planMove(p, 'main', 'B', 'A');
  assert.equal(plan.reparented.length, 0);
});

test('subtree move rejects moving onto own descendant', () => {
  const p = pm({ A: 'main', B: 'A' });
  assert.throws(() => planMoveSubtree(p, 'main', 'A', 'B'));
  const ok = planMoveSubtree(pm({ A: 'main', B: 'A', Z: 'main' }), 'main', 'A', 'Z');
  assert.deepEqual(ok.restack.map(r => r.branch), ['A', 'B']);
});

test('sanitize breaks cycles', () => {
  const s = sanitize(pm({ A: 'B', B: 'A', C: 'main' }), 'main');
  assert.ok([...s.values()].includes('main'));
});

// ---------- end-to-end against a real repo with one worktree per branch ----------

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'));
  const main = path.join(root, 'repo');
  fs.mkdirSync(main);
  sh(main, 'init', '-q', '-b', 'main');
  sh(main, 'config', 'user.email', 't@t');
  sh(main, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(main, 'base.txt'), 'base\n');
  sh(main, 'add', '.');
  sh(main, 'commit', '-qm', 'base');
  let prev = 'main';
  const wts: Record<string, string> = {};
  for (const b of ['A', 'B', 'C']) {
    const wt = path.join(root, `wt-${b}`);
    sh(main, 'worktree', 'add', '-q', '-b', b, wt, prev);
    fs.writeFileSync(path.join(wt, `${b}.txt`), `${b}\n`);
    sh(wt, 'add', '.');
    sh(wt, 'commit', '-qm', `commit ${b}`);
    sh(main, 'config', `branch.${b}.stackParent`, prev);
    wts[b] = wt;
    prev = b;
  }
  return { main, wts };
}

const log = (cwd: string, ref: string) => sh(cwd, 'log', '--format=%s', ref);

test('e2e: reorder A,B,C -> A,C,B rebases in each worktree', async () => {
  const { main, wts } = makeRepo();
  const repo = (await Repo.open(wts.B))!;
  assert.equal(repo.mainPath, fs.realpathSync(main));

  const parents = pm({ A: 'main', B: 'A', C: 'B' });
  const plan = planMove(parents, 'main', 'B', 'C');
  const steps = await resolveSteps(repo, plan.restack, new Map());
  const outcome = await execute(repo, steps, b => wts[b]);
  assert.equal(outcome.kind, 'done');

  assert.deepEqual(log(main, 'B').split('\n'), ['commit B', 'commit C', 'commit A', 'base']);
  assert.deepEqual(log(main, 'C').split('\n'), ['commit C', 'commit A', 'base']);
  // each worktree still has its own branch checked out
  assert.equal(sh(wts.C, 'branch', '--show-current'), 'C');
  assert.equal(sh(wts.B, 'branch', '--show-current'), 'B');
});

test('e2e: recorded parent SHA lets children restack after parent is amended', async () => {
  const { main, wts } = makeRepo();
  const repo = (await Repo.open(main))!;
  // initial restack records parent SHAs
  const chain = ['A', 'B', 'C'].map((b, i) => ({ branch: b, oldParent: i ? 'ABC'[i - 1] : 'main', newParent: i ? 'ABC'[i - 1] : 'main' }));
  await execute(repo, await resolveSteps(repo, chain, new Map()), b => wts[b]);

  // amend A (rewrites it) — B and C now sit on the old A
  fs.writeFileSync(path.join(wts.A, 'A.txt'), 'A2\n');
  sh(wts.A, 'commit', '-qa', '--amend', '-m', 'commit A v2');

  const stored = await repo.storedParents();
  const steps = await resolveSteps(repo, chain.slice(1), new Map([...stored].map(([k, e]) => [k, e.parentSha])));
  const outcome = await execute(repo, steps, b => wts[b]);
  assert.equal(outcome.kind, 'done');
  assert.deepEqual(log(main, 'C').split('\n'), ['commit C', 'commit B', 'commit A v2', 'base']);
});

test('e2e: conflict pauses, resume continues after manual --continue', async () => {
  const { main, wts } = makeRepo();
  const repo = (await Repo.open(main))!;
  // make C touch B.txt so moving C below B conflicts
  fs.writeFileSync(path.join(wts.C, 'B.txt'), 'B changed by C\n');
  sh(wts.C, 'commit', '-qam', 'C edits B');

  const plan = planMove(pm({ A: 'main', B: 'A', C: 'B' }), 'main', 'C', 'A');
  const steps = await resolveSteps(repo, plan.restack, new Map());
  const out1 = await execute(repo, steps, b => wts[b]);
  assert.equal(out1.kind, 'conflict');
  if (out1.kind !== 'conflict') return;
  assert.equal(out1.branch, 'C');

  // user resolves each conflict by hand, runs `git rebase --continue`, then Continue Restack
  let outcome: Outcome = out1;
  const seen: string[] = [];
  while (outcome.kind === 'conflict') {
    seen.push(outcome.branch);
    const wt = outcome.worktree;
    for (const f of sh(wt, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) {
      fs.writeFileSync(path.join(wt, f), 'resolved\n');
      sh(wt, 'add', f);
    }
    sh(wt, '-c', 'core.editor=true', 'rebase', '--continue');
    outcome = await resume(repo, outcome.pending, b => wts[b]);
  }
  assert.deepEqual(seen, ['C', 'B']);
  // final shape: main <- A <- C <- B
  sh(main, 'merge-base', '--is-ancestor', 'C', 'B');
  sh(main, 'merge-base', '--is-ancestor', 'A', 'C');
  assert.equal((await repo.storedParents()).get('B')?.parentSha, sh(main, 'rev-parse', 'C'));
});

test('e2e: checkout local branch, remote-only branch, and detect branch held by another worktree', async () => {
  const { main, wts } = makeRepo();
  const repo = (await Repo.open(main))!;

  // A free local branch
  sh(main, 'branch', 'free', 'A');
  await repo.checkout(main, 'free', 'origin');
  assert.equal(await repo.currentBranch(main), 'free');

  // Remote-only branch: clone, then check out a branch that only exists on origin
  const clone = path.join(path.dirname(main), 'clone');
  execFileSync('git', ['clone', '-q', main, clone]);
  const cloneRepo = (await Repo.open(clone))!;
  assert.equal((await cloneRepo.localBranches()).has('B'), false);
  await cloneRepo.checkout(clone, 'B', 'origin');
  assert.equal(await cloneRepo.currentBranch(clone), 'B');
  assert.equal(sh(clone, 'rev-parse', '--abbrev-ref', 'B@{upstream}'), 'origin/B');

  // Branch held by another worktree is reported by worktrees(), and git refuses it
  const holder = (await repo.worktrees()).find(w => w.branch === 'C');
  assert.equal(holder && fs.realpathSync(holder.path), fs.realpathSync(wts.C));
  await assert.rejects(repo.checkout(main, 'C', 'origin'));

  // Stash path
  fs.writeFileSync(path.join(main, 'base.txt'), 'dirty\n');
  assert.equal(await repo.isDirty(main), true);
  await repo.stash(main, 'test');
  assert.equal(await repo.isDirty(main), false);
  await repo.checkout(main, 'A', 'origin').catch(() => {}); // A is held by wt-A; ignore
  sh(main, 'checkout', '-q', 'main');
  assert.equal(await repo.currentBranch(main), 'main');
});

test('e2e: PR file changes are relative to the parent in the stack, with renames and stats', async () => {
  const { main, wts } = makeRepo();
  const repo = (await Repo.open(main))!;
  // On C: modify, add, delete, rename, plus a binary file
  fs.writeFileSync(path.join(wts.C, 'B.txt'), 'B\nmore\n');          // modify a file from B
  fs.writeFileSync(path.join(wts.C, 'dir with space.txt'), 'x\n');   // add, with a space
  sh(wts.C, 'rm', '-q', 'A.txt');                                    // delete
  sh(wts.C, 'mv', 'base.txt', 'renamed.txt');                        // rename
  fs.writeFileSync(path.join(wts.C, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
  sh(wts.C, 'add', '-A');
  sh(wts.C, 'commit', '-qm', 'more C');

  const ch = await repo.prChanges('C', 'B', 'origin');
  const by = Object.fromEntries(ch.files.map(f => [f.path, f]));
  // C.txt comes from C's first commit; nothing from A or B leaks in
  assert.deepEqual(Object.keys(by).sort(), ['A.txt', 'B.txt', 'C.txt', 'bin.dat', 'dir with space.txt', 'renamed.txt']);
  assert.equal(by['A.txt'].status, 'D');
  assert.equal(by['B.txt'].status, 'M');
  assert.deepEqual([by['B.txt'].added, by['B.txt'].deleted], [1, 0]);
  assert.equal(by['renamed.txt'].status, 'R');
  assert.equal(by['renamed.txt'].oldPath, 'base.txt');
  assert.equal(by['bin.dat'].added, undefined);
  assert.equal(by['dir with space.txt'].status, 'A');
  // contents for the diff sides
  assert.equal(await repo.show(ch.base, 'B.txt'), 'B\n');
  assert.equal(await repo.show(ch.head, 'B.txt'), 'B\nmore\n');
  assert.equal(await repo.show(ch.base, 'dir with space.txt'), '');

  // A PR with only its own single commit vs its parent
  const a = await repo.prChanges('A', 'main', 'origin');
  assert.deepEqual(a.files.map(f => `${f.status} ${f.path}`), ['A A.txt']);
});
