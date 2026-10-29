import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { foreignInPlan, isForeign, ownSubtree, planMove, planMoveSubtree, sanitize } from '../stack';
import type { BranchInfo } from '../stack';
import { Repo, setGhPath, snapshot } from '../git';
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


// ---------- ownership guard ----------

const info = (name: string, mine?: boolean): BranchInfo =>
  mine === undefined ? { name } : { name, pr: { number: 1, title: name, url: '', headRefName: name, baseRefName: 'main', isDraft: false, mine, author: { login: mine ? 'me' : 'alice' } } };

test('guard: dropping my PR onto a teammate PR forks instead of re-parenting their child', () => {
  // main <- T (alice) <- T2 (alice);  M (mine) on main
  const p = pm({ T: 'main', T2: 'T', M: 'main' });
  const branches = new Map([['T', info('T', false)], ['T2', info('T2', false)], ['M', info('M', true)]]);
  const plan = planMove(p, 'main', 'M', 'T', b => !isForeign(branches.get(b)));
  assert.deepEqual(obj(plan.newParents), { M: 'T', T: 'main', T2: 'T' });
  assert.deepEqual(foreignInPlan(plan, branches), []);
});

test('guard: moves that would rebase a teammate PR are flagged', () => {
  // main <- M (mine) <- T (alice): moving M out from under T would rebase T
  const p = pm({ M: 'main', T: 'M', X: 'main' });
  const branches = new Map([['M', info('M', true)], ['T', info('T', false)], ['X', info('X', true)]]);
  const plan = planMove(p, 'main', 'M', 'X', b => !isForeign(branches.get(b)));
  assert.deepEqual(foreignInPlan(plan, branches), ['T']);
  // local branches without a PR count as yours
  assert.equal(isForeign(info('local')), false);
});

test('guard: restack skips teammate PRs and everything stacked on them', () => {
  // M1 <- T (alice) <- M3 ;  M1 <- M2
  const p = pm({ M1: 'main', T: 'M1', M3: 'T', M2: 'M1' });
  const branches = new Map([['T', info('T', false)]]);
  const r = ownSubtree(p, 'M1', b => !isForeign(branches.get(b)));
  assert.deepEqual(r.own, ['M1', 'M2']);
  assert.deepEqual(r.skipped, ['T']);
});

test('e2e: scope filter and ownership come from gh (fake gh)', async () => {
  const { main } = makeRepo(); // local branches A, B, C with worktrees
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  const prs = [
    { number: 1, title: 'A', url: 'u', headRefName: 'A', baseRefName: 'main', isDraft: false, author: { login: 'Me' } },
    { number: 2, title: 'B', url: 'u', headRefName: 'B', baseRefName: 'A', isDraft: false, author: { login: 'alice' } },
    { number: 3, title: 'X', url: 'u', headRefName: 'X', baseRefName: 'main', isDraft: false, author: { login: 'bob' } },
    { number: 4, title: 'Y', url: 'u', headRefName: 'Y', baseRefName: 'main', isDraft: false, author: { login: 'me' } },
  ];
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\nif [ "$1" = api ]; then echo me; else cat <<'EOF'\n${JSON.stringify(prs)}\nEOF\nfi\n`);
  fs.chmodSync(gh, 0o755);
  setGhPath(gh);
  try {
    const repo = (await Repo.open(main))!;
    const mine = await snapshot(repo, { trunk: 'main', scope: 'mine' });
    assert.equal(mine.ghError, undefined);
    assert.equal(mine.viewerLogin, 'me');
    // A (mine, case-insensitive), Y (mine, remote only), B and C (local worktrees); bob's X hidden
    assert.deepEqual([...mine.branches.keys()].sort(), ['A', 'B', 'C', 'Y']);
    assert.equal(isForeign(mine.branches.get('A')), false);
    assert.equal(isForeign(mine.branches.get('B')), true);  // alice's PR, even though checked out locally
    assert.equal(isForeign(mine.branches.get('C')), false); // local branch, no PR

    const all = await snapshot(repo, { trunk: 'main', scope: 'everyone' });
    assert.deepEqual([...all.branches.keys()].sort(), ['A', 'B', 'C', 'X', 'Y']);
    assert.equal(isForeign(all.branches.get('X')), true);
  } finally {
    setGhPath('');
  }
});

// ---------- viewed checklist ----------
import { buildFileTree, FileChange, filesUnder, parseRawZ } from '../diff';
import { ViewedStore } from '../viewed';

test('raw diff parsing carries blob ids, including renames and deletes', () => {
  const z = [
    ':100644 100644 aaa bbb M', 'src/x.ts',
    ':100644 000000 ccc 000 D', 'gone.ts',
    ':100644 100644 ddd eee R087', 'old name.ts', 'new name.ts',
    '',
  ].join('\0');
  assert.deepEqual(parseRawZ(z), [
    { status: 'M', path: 'src/x.ts', blob: 'bbb' },
    { status: 'D', path: 'gone.ts', blob: 'ccc' },
    { status: 'R', path: 'new name.ts', oldPath: 'old name.ts', blob: 'eee' },
  ]);
});

test('file tree compresses single-folder chains like the screenshot', () => {
  const f = (p: string): FileChange => ({ status: 'M', path: p });
  const t = buildFileTree([f('src/data/productCatalogue/addOnsCatalogueData.ts'), f('README.md'), f('src/app/a.ts'), f('src/app/b.ts'), f('src/data/x/y.ts')]);
  const show = (e: typeof t, d = 0): string[] => [
    ...e.folders.flatMap(x => [`${'  '.repeat(d)}${x.label}/`, ...show(x, d + 1)]),
    ...e.files.map(x => `${'  '.repeat(d)}${x.path.split('/').pop()}`),
  ];
  assert.deepEqual(show(t), [
    'src/', '  app/', '    a.ts', '    b.ts', '  data/', '    productCatalogue/', '      addOnsCatalogueData.ts', '    x/', '      y.ts', 'README.md',
  ]);
  const single = buildFileTree([f('src/data/productCatalogue/addOnsCatalogueData.ts')]);
  assert.equal(single.folders[0].label, 'src/data/productCatalogue');
  assert.equal(single.folders[0].dir, 'src/data/productCatalogue');
  assert.equal(filesUnder(t).length, 5);
});

function memKV() {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string) => m.get(k) as T | undefined, update: async (k: string, v: unknown) => void m.set(k, v) };
}

test('viewed: unticks itself when the file content changes', async () => {
  const v = new ViewedStore(memKV(), () => undefined);
  const a1: FileChange = { status: 'M', path: 'a.ts', blob: 'v1' };
  await v.set('feat', [a1], true);
  assert.equal(v.isViewed('feat', a1), true);
  assert.equal(v.isViewed('feat', { ...a1, blob: 'v2' }), false); // new push changed it
  assert.equal(v.isViewed('other-branch', a1), false);
  await v.set('feat', [a1], false);
  assert.equal(v.isViewed('feat', a1), false);
});

test('viewed: syncs both ways with GitHub', async () => {
  const marked: string[] = [];
  const remote = new Map([['a.ts', 'VIEWED'], ['b.ts', 'UNVIEWED'], ['c.ts', 'DISMISSED']]);
  const gh = {
    prViewedState: async () => ({ prId: 'PR_1', files: new Map(remote) }),
    setPrFileViewed: async (id: string, p: string, on: boolean) => void marked.push(`${id} ${p} ${on}`),
  };
  const v = new ViewedStore(memKV(), () => gh);
  const files: FileChange[] = ['a.ts', 'b.ts', 'c.ts', 'local-only.ts'].map(p => ({ status: 'M', path: p, blob: 'x' }));
  // c.ts was ticked here earlier; GitHub has since dismissed it (changed on GitHub)
  await v.set('feat', [files[2]], true);
  marked.length = 0;

  assert.equal(await v.sync('feat', 7, files), true);
  assert.deepEqual(files.map(f => v.isViewed('feat', f)), [true, false, false, false]);

  await v.set('feat', [files[1], files[3]], true, 7);
  assert.deepEqual(marked, ['PR_1 b.ts true']); // local-only.ts isn't in the GitHub PR diff
  assert.deepEqual(files.map(f => v.isViewed('feat', f)), [true, true, false, true]);
});

test('e2e: blob ids change only for files whose content changed', async () => {
  const { main, wts } = makeRepo();
  const repo = (await Repo.open(main))!;
  fs.writeFileSync(path.join(wts.C, 'D.txt'), 'd\n');
  sh(wts.C, 'add', '.');
  sh(wts.C, 'commit', '-qm', 'D');
  const before = await repo.prChanges('C', 'B', 'origin');
  fs.writeFileSync(path.join(wts.C, 'D.txt'), 'd2\n');
  sh(wts.C, 'commit', '-qam', 'D2');
  const after = await repo.prChanges('C', 'B', 'origin');
  const blob = (c: typeof before, p: string) => c.files.find(f => f.path === p)!.blob;
  assert.equal(blob(before, 'C.txt'), blob(after, 'C.txt'));
  assert.notEqual(blob(before, 'D.txt'), blob(after, 'D.txt'));
  assert.match(blob(after, 'D.txt')!, /^[0-9a-f]{40,64}$/);
});

// ---------- flattened layout ----------
import { forkGroups, groupsUnder, planInsertBefore } from '../stack';

test('layout: linear stacks are flattened, lone PRs stay single, forks nest', () => {
  // main <- A <- B <- C ;  main <- S ;  B forks? no.  main <- F <- (G, H<-I)
  const p = pm({ A: 'main', B: 'A', C: 'B', S: 'main', F: 'main', G: 'F', H: 'F', I: 'H' });
  assert.deepEqual(groupsUnder(p, 'main'), [
    { type: 'stack', chain: ['A', 'B', 'C'] },
    { type: 'single', branch: 'F' },
    { type: 'single', branch: 'S' },
  ]);
  assert.deepEqual(forkGroups(p, 'B'), []); // B's single child is in the same flat list
  assert.deepEqual(forkGroups(p, 'F'), [
    { type: 'single', branch: 'G' },
    { type: 'stack', chain: ['H', 'I'] },
  ]);
  // a stack that ends in a fork: the fork hangs off the last row
  const q = pm({ A: 'main', B: 'A', X: 'B', Y: 'B' });
  assert.deepEqual(groupsUnder(q, 'main'), [{ type: 'stack', chain: ['A', 'B'] }]);
  assert.equal(forkGroups(q, 'B').length, 2);
});

test('drop on stack header: insert at the bottom of that stack', () => {
  const p = pm({ A: 'main', B: 'A', C: 'B', S: 'main' });
  const plan = planInsertBefore(p, 'main', 'S', 'A');
  assert.deepEqual(obj(plan.newParents), { S: 'main', A: 'S', B: 'A', C: 'B' });
  // moving a PR from the middle of the same stack to its bottom
  const plan2 = planInsertBefore(p, 'main', 'C', 'A');
  assert.deepEqual(obj(plan2.newParents), { C: 'main', A: 'C', B: 'A', S: 'main' });
  assert.deepEqual(plan2.restack.map(r => r.branch), ['C', 'A', 'B']);
});
