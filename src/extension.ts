import * as vscode from 'vscode';
import { ghBin, git, Repo, setGhPath, snapshot } from './git';
import { ClickAction, FileStatusDecorations, Node, StackTree } from './provider';
import { ViewedStore } from './viewed';
import { filesUnder } from './diff';
import * as fs from 'fs';
import * as path from 'path';
import { execute, Outcome, PendingRestack, preflight, resolveSteps, resume, Step } from './restack';
import { describePlan, descendants, foreignInPlan, isForeign, MovePlan, ownSubtree, planInsertBefore, planMove, planMoveSubtree, Scope } from './stack';

const PENDING_KEY = 'stackedPrs.pending';

export function activate(context: vscode.ExtensionContext) {
  let repo: Repo | undefined;
  let busy = false;
  const cfg = () => vscode.workspace.getConfiguration('stackedPrs');
  const out = vscode.window.createOutputChannel('Stacked PRs');
  const viewed = new ViewedStore(context.workspaceState, () => repo, m => out.appendLine(m));
  const tree = new StackTree((moving, target, mode) => guarded(() => onDrop(moving, target, mode)), {
    clickAction: () => cfg().get<ClickAction>('clickAction', 'openPr'),
    repo: () => repo,
    remote: () => cfg().get('remote', 'origin'),
    viewed,
  });

  // Read-only file contents at a commit, for the left/right sides of diffs.
  const GIT_SCHEME = 'stackedprs-git';
  const gitUri = (ref: string, file: string) =>
    vscode.Uri.from({ scheme: GIT_SCHEME, path: '/' + file, query: JSON.stringify({ ref }) });
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      provideTextDocumentContent: async uri => {
        if (!repo) return '';
        const { ref } = JSON.parse(uri.query) as { ref: string };
        return repo.show(ref, uri.path.slice(1));
      },
    }),
    vscode.window.registerFileDecorationProvider(new FileStatusDecorations()),
  );
  const view = vscode.window.createTreeView('stackedPrs.tree', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    showCollapseAll: true,
    manageCheckboxStateManually: true, // folder ticks fan out to their files ourselves
  });

  // "Viewed" checklist: ticking a folder ticks every file under it.
  context.subscriptions.push(
    view.onDidChangeCheckboxState(async e => {
      const byBranch = new Map<string, { files: Map<string, import('./diff').FileChange>; checked: boolean }[]>();
      for (const [node, state] of e.items) {
        if (node.kind !== 'file' && node.kind !== 'folder') continue;
        const files = node.kind === 'file' ? [node.change] : filesUnder(node.entry);
        const list = byBranch.get(node.name) ?? [];
        list.push({ files: new Map(files.map(f => [f.path, f])), checked: state === vscode.TreeItemCheckboxState.Checked });
        byBranch.set(node.name, list);
      }
      for (const [branch, groups] of byBranch) {
        const pr = tree.snap?.branches.get(branch)?.pr;
        for (const g of groups) await viewed.set(branch, [...g.files.values()], g.checked, pr?.number);
        tree.refreshFiles(branch);
      }
    }),
  );
  context.subscriptions.push(view, out);

  const worktreeOf = (b: string) => tree.snap?.branches.get(b)?.worktree;

  const pending = () => context.workspaceState.get<PendingRestack>(PENDING_KEY);
  const setPending = async (p: PendingRestack | undefined) => {
    await context.workspaceState.update(PENDING_KEY, p);
    await vscode.commands.executeCommand('setContext', 'stackedPrs.pendingRestack', !!p);
    view.message = p ? `Restack paused on ${p.conflicted} — resolve, \`git rebase --continue\`, then ▶ Continue Restack.` : undefined;
  };

  async function refresh() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return tree.set(undefined);
    repo = await Repo.open(folder.uri.fsPath);
    if (!repo) return tree.set(undefined);
    try {
      const scope = cfg().get<Scope>('scope', 'mine');
      void vscode.commands.executeCommand('setContext', 'stackedPrs.scope', scope);
      const snap = await snapshot(repo, { trunk: cfg().get('trunk', ''), scope });
      view.description = scope === 'mine' ? `My PRs${snap.viewerLogin ? ` (@${snap.viewerLogin})` : ''}` : 'All PRs';
      tree.set(snap);
      if (snap.ghError) {
        out.appendLine(`[gh] using: ${await ghBin()}`);
        out.appendLine(`[gh] ${snap.ghErrorDetail ?? snap.ghError}`);
        view.message = pending() ? view.message : `${snap.ghError} Showing local branches only.`;
      } else if (!pending()) {
        view.message = undefined;
      }
    } catch (e: any) {
      out.appendLine(String(e?.stack ?? e));
      vscode.window.showErrorMessage(`Stacked PRs: ${e?.message ?? e}`);
    }
  }

  async function guarded(fn: () => Promise<void>) {
    if (busy) {
      vscode.window.showInformationMessage('Stacked PRs: an operation is already running.');
      return;
    }
    busy = true;
    try {
      await fn();
    } catch (e: any) {
      out.appendLine(String(e?.stack ?? e));
      vscode.window.showErrorMessage(`Stacked PRs: ${e?.message ?? e}`);
    } finally {
      busy = false;
      await refresh();
    }
  }

  // ---------- reorder ----------

  async function onDrop(moving: string, target: string, mode: 'onto' | 'before' = 'onto') {
    if (!repo || !tree.snap) return;
    if (pending()) throw new Error('Finish or cancel the paused restack first.');
    if (isForeign(tree.snap.branches.get(moving))) throw new Error(viewOnly(moving));
    const branches = tree.snap.branches;
    if (mode === 'before') {
      const plan = planInsertBefore(tree.snap.parents, tree.snap.trunk, moving, target);
      await applyPlan(plan, `Move ${label(moving)} to the bottom of the stack, below ${label(target)}?`);
      return;
    }
    const plan = planMove(tree.snap.parents, tree.snap.trunk, moving, target, b => !isForeign(branches.get(b)));
    await applyPlan(plan, `Move ${label(moving)} on top of ${label(target)}?`);
  }

  function label(branch: string) {
    const pr = tree.snap?.branches.get(branch)?.pr;
    return pr ? `#${pr.number}` : branch;
  }

  function viewOnly(branch: string) {
    const pr = tree.snap?.branches.get(branch)?.pr;
    return `#${pr?.number} (${branch}) is @${pr?.author?.login ?? 'someone else'}'s PR — it's view-only, so it can't be moved, rebased or pushed from here.`;
  }

  async function applyPlan(plan: MovePlan, title: string) {
    if (!repo || !tree.snap) return;
    // Never rebase or push someone else's branch.
    const foreign = foreignInPlan(plan, tree.snap.branches);
    if (foreign.length) {
      const who = foreign.map(b => {
        const pr = tree.snap!.branches.get(b)!.pr!;
        return `#${pr.number} ${b} (@${pr.author?.login ?? '?'})`;
      });
      throw new Error(
        `This move would rebase PRs that aren't yours: ${who.join(', ')}. ` +
        `Move your PR somewhere that doesn't sit underneath theirs, or ask the author to restack.`,
      );
    }
    if (plan.reparented.length === 0) return;

    // Branches that must be rebased but aren't checked out anywhere: offer to create worktrees.
    const missing = plan.restack.map(r => r.branch).filter(b => !worktreeOf(b));
    if (missing.length) {
      const ok = await vscode.window.showWarningMessage(
        `These branches need a worktree to be rebased: ${missing.join(', ')}`,
        { modal: true },
        'Create Worktrees',
      );
      if (ok !== 'Create Worktrees') return;
      for (const b of missing) {
        const dir = await repo.addWorktree(b, cfg().get('worktreeRoot', ''));
        tree.snap.branches.get(b)!.worktree = dir;
        out.appendLine(`Created worktree for ${b} at ${dir}`);
      }
    }

    const go = await vscode.window.showInformationMessage(
      title,
      { modal: true, detail: `${describePlan(plan)}\n\nEach branch is rebased in its own worktree.` },
      'Reorder',
    );
    if (go !== 'Reorder') return;

    const stored = await repo.storedParents();
    const steps = await resolveSteps(
      repo,
      plan.restack,
      new Map([...stored].map(([b, e]) => [b, e.parentSha])),
    );
    const problems = await preflight(repo, steps, worktreeOf);
    if (problems.length) throw new Error(`Can't restack:\n${problems.join('\n')}`);

    // Record the new shape first so the tree reflects intent even if a rebase conflicts.
    for (const r of plan.reparented) await repo.setStoredParent(r.branch, r.newParent);

    await runSteps(steps, () => execute(repo!, steps, worktreeOf, msg => out.appendLine(msg)), plan.reparented.map(r => r.branch));
  }

  async function runSteps(steps: Step[], fn: () => Promise<Outcome>, reparented: string[]) {
    const outcome = await vscode.window.withProgress(
      { location: { viewId: 'stackedPrs.tree' }, title: 'Restacking…' },
      fn,
    );
    await handleOutcome(outcome, steps, reparented);
  }

  async function handleOutcome(outcome: Outcome, _steps: Step[], reparented: string[]) {
    if (outcome.kind === 'conflict') {
      await setPending({ ...outcome.pending, reparented });
      const pick = await vscode.window.showWarningMessage(
        `Rebase conflict in ${outcome.branch}. Resolve it in its worktree, run "git rebase --continue", then Continue Restack.`,
        'Open Worktree',
        'Abort Restack',
      );
      if (pick === 'Open Worktree') openFolder(outcome.worktree, true);
      if (pick === 'Abort Restack') await abortPending();
      return;
    }
    await setPending(undefined);
    out.appendLine(`Restacked: ${outcome.rebased.join(', ') || '(nothing)'}`);
    await afterRestack(outcome.rebased, reparented);
  }

  async function afterRestack(rebased: string[], reparented: string[]) {
    if (!repo || !rebased.length) return;
    let mode = cfg().get<string>('afterReorder', 'ask');
    if (mode === 'ask') {
      const pick = await vscode.window.showInformationMessage(
        `Restacked ${rebased.length} branch(es). Push them and update PR bases on GitHub?`,
        'Push & Update PRs',
        'Keep Local',
      );
      mode = pick === 'Push & Update PRs' ? 'pushAndUpdateBase' : 'localOnly';
    }
    if (mode !== 'pushAndUpdateBase') return;
    await refresh();
    await pushAndRetarget(rebased, reparented);
  }

  async function pushAndRetarget(toPush: string[], toRetarget: string[]) {
    if (!repo || !tree.snap) return;
    const remote = cfg().get('remote', 'origin');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Stacked PRs' },
      async p => {
        // Belt and braces: never push or retarget someone else's PR.
        toPush = toPush.filter(b => !isForeign(tree.snap!.branches.get(b)));
        toRetarget = toRetarget.filter(b => !isForeign(tree.snap!.branches.get(b)));
        for (const b of toPush) {
          p.report({ message: `Pushing ${b}` });
          await repo!.pushForce(remote, b);
        }
        for (const b of toRetarget) {
          const pr = tree.snap!.branches.get(b)?.pr;
          const parent = tree.snap!.parents.get(b);
          if (pr && parent && pr.baseRefName !== parent) {
            p.report({ message: `PR #${pr.number} → base ${parent}` });
            await repo!.setPrBase(pr.number, parent);
          }
        }
      },
    );
  }

  async function abortPending() {
    const p = pending();
    if (!p || !repo) return;
    const wt = p.conflicted ? worktreeOf(p.conflicted) : undefined;
    if (wt && (await repo.isRebasing(wt))) await repo.abortRebase(wt);
    await setPending(undefined);
    vscode.window.showInformationMessage(
      'Restack aborted. Branches already rebased keep their new position; run "Restack Descendants" on a branch to finish later.',
    );
  }

  function openFolder(path: string, newWindow: boolean) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { forceNewWindow: newWindow });
  }

  const branchArg = (n?: Node) => {
    const sel = n ?? view.selection[0];
    if (!sel || sel.kind !== 'branch') throw new Error('Select a branch first.');
    return sel;
  };

  // ---------- commands ----------

  const reg = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('stackedPrs.refresh', () => refresh());

  const setScope = async (scope: Scope) => {
    const inspect = cfg().inspect('scope');
    const target = inspect?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg().update('scope', scope, target); // triggers refresh via onDidChangeConfiguration
  };
  reg('stackedPrs.showMine', () => setScope('mine'));
  reg('stackedPrs.showEveryone', () => setScope('everyone'));
  reg('stackedPrs.openWorktree', (n?: Node) => {
    const b = branchArg(n);
    if (b.info.worktree) openFolder(b.info.worktree, true);
  });
  reg('stackedPrs.checkout', (n?: Node) =>
    guarded(async () => {
      const sel = n ?? view.selection[0];
      if (!sel || !repo) throw new Error('Select a branch first.');
      const branch = sel.name;
      const here = repo.cwd;

      if ((await repo.currentBranch(here)) === branch) {
        vscode.window.showInformationMessage(`Already on ${branch}.`);
        return;
      }

      // git allows a branch in only one worktree at a time.
      const holder = (await repo.worktrees()).find(w => w.branch === branch);
      if (holder) {
        const pick = await vscode.window.showInformationMessage(
          `${branch} is checked out in another worktree:\n${holder.path}`,
          { modal: true, detail: 'A branch can only be checked out in one worktree at a time. Open that worktree instead?' },
          'Open in This Window',
          'Open in New Window',
        );
        if (pick) openFolder(holder.path, pick === 'Open in New Window');
        return;
      }

      if (await repo.isRebasing(here)) throw new Error('This worktree is in the middle of a rebase. Finish or abort it first.');

      if (await repo.isDirty(here)) {
        const pick = await vscode.window.showWarningMessage(
          `You have uncommitted changes in this worktree.`,
          { modal: true, detail: `Stash them before checking out ${branch}, or carry them over (git refuses if they conflict).` },
          'Stash & Checkout',
          'Checkout Anyway',
        );
        if (!pick) return;
        if (pick === 'Stash & Checkout') {
          await repo.stash(here, `stacked-prs: before checkout ${branch}`);
          out.appendLine(`Stashed changes in ${here}`);
        }
      }

      await repo.checkout(here, branch, cfg().get('remote', 'origin'));
      vscode.window.setStatusBarMessage(`$(git-branch) Checked out ${branch}`, 4000);
    }),
  );

  reg('stackedPrs.openFileDiff', async (n?: Node) => {
    if (!n || n.kind !== 'file') return;
    const { change: f, changes } = n;
    const parent = tree.snap?.parents.get(n.name) ?? 'parent';
    const left = gitUri(changes.base, f.oldPath ?? f.path);
    // Right side: the real file in the PR's worktree (editable) when it is there and still at the PR tip;
    // otherwise the committed version.
    const wt = tree.snap?.branches.get(n.name)?.worktree;
    const onDisk = wt && f.status !== 'D' ? path.join(wt, f.path) : undefined;
    const tipMatches = wt ? (await git(wt, 'rev-parse', 'HEAD').catch(() => '')) === changes.head : false;
    const right = onDisk && tipMatches && fs.existsSync(onDisk) ? vscode.Uri.file(onDisk) : gitUri(changes.head, f.path);
    const title = `${path.posix.basename(f.path)} (${parent} ↔ ${n.name})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  });

  reg('stackedPrs.openFileAtTip', async (n?: Node) => {
    if (!n || n.kind !== 'file' || n.change.status === 'D') return;
    const wt = tree.snap?.branches.get(n.name)?.worktree;
    const uri = wt ? vscode.Uri.file(path.join(wt, n.change.path)) : gitUri(n.changes.head, n.change.path);
    await vscode.window.showTextDocument(uri, { preview: true });
  });

  reg('stackedPrs.openAllChanges', async (n?: Node) => {
    if (!n || (n.kind !== 'files' && n.kind !== 'branch')) return;
    const changes = await tree.prChanges(n.name);
    // Opens the multi-file diff editor where available (VS Code ≥ 1.86 / recent Cursor).
    const resources = changes.files.map(f => [
      gitUri(changes.head, f.path),
      f.status === 'A' ? undefined : gitUri(changes.base, f.oldPath ?? f.path),
      f.status === 'D' ? undefined : gitUri(changes.head, f.path),
    ]);
    const parent = tree.snap?.parents.get(n.name);
    try {
      await vscode.commands.executeCommand('vscode.changes', `${n.name} vs ${parent}`, resources);
    } catch {
      vscode.window.showWarningMessage('Your editor version has no multi-file diff view; open files one by one instead.');
    }
  });

  reg('stackedPrs.openWorktreeHere', (n?: Node) => {
    const b = branchArg(n);
    if (b.info.worktree) openFolder(b.info.worktree, false);
  });
  reg('stackedPrs.openTerminal', (n?: Node) => {
    const b = branchArg(n);
    if (!b.info.worktree) return;
    const t = vscode.window.createTerminal({ name: b.name, cwd: b.info.worktree });
    t.show();
  });
  reg('stackedPrs.openPr', (n?: Node) => {
    const b = branchArg(n);
    if (b.info.pr) vscode.env.openExternal(vscode.Uri.parse(b.info.pr.url));
  });
  reg('stackedPrs.createWorktree', (n?: Node) =>
    guarded(async () => {
      const b = branchArg(n);
      const dir = await repo!.addWorktree(b.name, cfg().get('worktreeRoot', ''));
      vscode.window.showInformationMessage(`Worktree for ${b.name} created at ${dir}`, 'Open').then(x => {
        if (x) openFolder(dir, true);
      });
    }),
  );

  reg('stackedPrs.moveTo', (n?: Node) =>
    guarded(async () => {
      const b = branchArg(n);
      const snap = tree.snap!;
      if (pending()) throw new Error('Finish or cancel the paused restack first.');
      if (isForeign(b.info)) throw new Error(viewOnly(b.name));
      const below = new Set(descendants(snap.parents, b.name));
      const candidates = [snap.trunk, ...snap.branches.keys()].filter(x => x !== b.name);
      const target = await vscode.window.showQuickPick(
        candidates.map(c => {
          const pr = snap.branches.get(c)?.pr;
          return { label: c, description: pr ? `#${pr.number} ${pr.title}` : c === snap.trunk ? 'trunk' : '', isBelow: below.has(c) };
        }),
        { title: `Move ${b.name} onto…` },
      );
      if (!target) return;
      const how = await vscode.window.showQuickPick(
        [
          { label: 'Just this PR', detail: 'Its children stay where they are (re-attached to its current parent).', id: 'one' },
          ...(target.isBelow ? [] : [{ label: 'This PR and everything stacked on it', detail: 'Moves the whole sub-stack.', id: 'subtree' }]),
        ],
        { title: 'What should move?' },
      );
      if (!how) return;
      const plan = how.id === 'subtree'
        ? planMoveSubtree(snap.parents, snap.trunk, b.name, target.label)
        : planMove(snap.parents, snap.trunk, b.name, target.label);
      await applyPlan(plan, `Move ${b.name} onto ${target.label}?`);
    }),
  );

  reg('stackedPrs.restack', (n?: Node) =>
    guarded(async () => {
      const b = branchArg(n);
      const snap = tree.snap!;
      if (pending()) throw new Error('Finish or cancel the paused restack first.');
      if (isForeign(b.info)) throw new Error(viewOnly(b.name));
      // Rebase the branch onto its parent and everything above it onto theirs —
      // skipping other people's PRs (and anything stacked on them).
      const { own: chain, skipped } = ownSubtree(snap.parents, b.name, x => !isForeign(snap.branches.get(x)));
      if (skipped.length) {
        const ok = await vscode.window.showWarningMessage(
          `Skipping PRs that aren't yours (and anything stacked on them): ${skipped.join(', ')}`,
          { modal: true },
          'Restack the Rest',
        );
        if (!ok) return;
      }
      const plan: MovePlan = {
        newParents: snap.parents,
        reparented: [],
        restack: chain.map(x => ({ branch: x, oldParent: snap.parents.get(x)!, newParent: snap.parents.get(x)! })),
      };
      const stored = await repo!.storedParents();
      const steps = await resolveSteps(repo!, plan.restack, new Map([...stored].map(([k, e]) => [k, e.parentSha])));
      const problems = await preflight(repo!, steps, worktreeOf);
      if (problems.length) throw new Error(`Can't restack:\n${problems.join('\n')}`);
      await runSteps(steps, () => execute(repo!, steps, worktreeOf, m => out.appendLine(m)), []);
    }),
  );

  reg('stackedPrs.continueRestack', () =>
    guarded(async () => {
      const p = pending();
      if (!p || !repo) return;
      const outcome = await vscode.window.withProgress(
        { location: { viewId: 'stackedPrs.tree' }, title: 'Restacking…' },
        () => resume(repo!, p, worktreeOf, m => out.appendLine(m)),
      );
      await handleOutcome(outcome, p.steps, p.reparented ?? []);
    }),
  );

  reg('stackedPrs.cancelRestack', () => guarded(abortPending));

  reg('stackedPrs.abortRebase', (n?: Node) =>
    guarded(async () => {
      const b = branchArg(n);
      if (b.info.worktree) await repo!.abortRebase(b.info.worktree);
      if (pending()?.conflicted === b.name) await setPending(undefined);
    }),
  );

  reg('stackedPrs.syncBase', (n?: Node) =>
    guarded(async () => {
      const b = branchArg(n);
      if (isForeign(b.info)) throw new Error(viewOnly(b.name));
      const snap = tree.snap!;
      const { own: chain } = ownSubtree(snap.parents, b.name, x => !isForeign(snap.branches.get(x)));
      await pushAndRetarget(chain, chain);
    }),
  );

  // Refresh when branches move, worktrees change, or settings change.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,worktrees/*/HEAD,refs/heads/**}');
  let t: NodeJS.Timeout | undefined;
  const soon = () => {
    if (busy) return;
    clearTimeout(t);
    t = setTimeout(refresh, 800);
  };
  watcher.onDidChange(soon);
  watcher.onDidCreate(soon);
  watcher.onDidDelete(soon);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('stackedPrs')) return;
      setGhPath(cfg().get('ghPath', ''));
      refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    view.onDidChangeVisibility(e => e.visible && refresh()),
  );

  setGhPath(cfg().get('ghPath', ''));
  void setPending(pending());
  void refresh();
}

export function deactivate() {}
