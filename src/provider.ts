import * as vscode from 'vscode';
import * as path from 'path';
import { Repo, Snapshot } from './git';
import { buildFileTree, FileChange, filesUnder, FolderEntry, PrChanges, totals } from './diff';
import { ViewedStore } from './viewed';
import { BranchInfo, childrenOf, forkGroups, Group, groupsUnder, isForeign, roots } from './stack';

export type Node =
  | { kind: 'root'; name: string }
  | { kind: 'stack'; name: string; chain: string[] } // name = bottom branch of the stack
  | { kind: 'branch'; name: string; info: BranchInfo }
  | { kind: 'files'; name: string } // name = branch
  | { kind: 'folder'; name: string; entry: FolderEntry; changes: PrChanges } // name = branch
  | { kind: 'file'; name: string; change: FileChange; changes: PrChanges } // name = branch
  | { kind: 'note'; name: string; text: string; error?: boolean }; // name = branch

/** Scheme for file rows: lets file icons + the A/M/D badge decorate them. */
export const FILE_SCHEME = 'stackedprs-file';

const STATUS_LABEL: Record<string, string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged',
};

const MIME = 'application/vnd.code.tree.stackedprs.tree';

/** Scheme for PR rows, so they can carry a position badge (1, 2, 3 … within their stack). */
export const PR_SCHEME = 'stackedprs-pr';

// Each stack gets its own colour so rows that belong together are easy to pick out.
// (Green is reserved for open-PR icons, red for errors.)
const STACK_COLORS = ['charts.blue', 'charts.purple', 'charts.orange', 'charts.yellow', 'terminal.ansiCyan', 'terminal.ansiMagenta'];
const stackColor = (key: string) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return new vscode.ThemeColor(STACK_COLORS[Math.abs(h) % STACK_COLORS.length]);
};

export type ClickAction = 'openPr' | 'openWorktree' | 'none';

export class StackTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  snap?: Snapshot;
  private nodes = new Map<string, Node>();

  private changes = new Map<string, Promise<PrChanges>>();
  private loaded = new Map<string, PrChanges | Error>();
  private filesNodes = new Map<string, Node>();
  private trees = new Map<string, FolderEntry>();
  private synced = new Set<string>();

  private filesNode(branch: string): Node {
    let n = this.filesNodes.get(branch);
    if (!n) this.filesNodes.set(branch, (n = { kind: 'files', name: branch }));
    return n;
  }

  constructor(
    private readonly onDropBranch: (moving: string, target: string, mode: 'onto' | 'before') => Promise<void>,
    private readonly ctx: {
      repo: () => Repo | undefined;
      remote: () => string;
      viewed: ViewedStore;
      clickAction: () => ClickAction;
    },
  ) {}

  /** Structural parent of each node as last laid out (for reveal / getParent). */
  private parentOf = new Map<Node, Node>();
  private stackNodes = new Map<string, Node>();
  /** branch -> [position, stack length] for rows inside a stack */
  private position = new Map<string, [number, number]>();

  set(snap: Snapshot | undefined) {
    this.snap = snap;
    this.nodes.clear();
    this.parentOf.clear();
    this.stackNodes.clear();
    this.position.clear();
    this.changes.clear();
    this.loaded.clear();
    this.filesNodes.clear();
    this.trees.clear();
    this.synced.clear();
    this.emitter.fire(undefined);
  }

  /** Re-render one PR's Files changed node (counts + checkboxes). */
  refreshFiles(branch: string) {
    this.emitter.fire(this.filesNode(branch));
  }

  private entryNodes(branch: string, e: FolderEntry, changes: PrChanges): Node[] {
    return [
      ...e.folders.map(entry => ({ kind: 'folder' as const, name: branch, entry, changes })),
      ...e.files.map(change => ({ kind: 'file' as const, name: branch, change, changes })),
    ];
  }

  /** Diff of one PR against its parent in the stack (cached until the next refresh). */
  prChanges(branch: string): Promise<PrChanges> {
    let p = this.changes.get(branch);
    if (!p) {
      const repo = this.ctx.repo();
      const parent = this.snap?.parents.get(branch);
      if (!repo || !parent) return Promise.reject(new Error('Not in a stack.'));
      const snap = this.snap;
      p = repo.prChanges(branch, parent, this.ctx.remote());
      this.changes.set(branch, p);
      p.then(
        c => { if (this.snap === snap) { this.loaded.set(branch, c); this.emitter.fire(this.filesNode(branch)); } },
        e => { if (this.snap === snap) { this.loaded.set(branch, e); this.changes.delete(branch); this.emitter.fire(this.filesNode(branch)); } },
      );
    }
    return p;
  }

  private groupNodes(groups: Group[]): Node[] {
    return groups.map(g => {
      if (g.type === 'single') return this.node(g.branch);
      const key = g.chain.join('\0');
      let n = this.stackNodes.get(key);
      if (!n) this.stackNodes.set(key, (n = { kind: 'stack', name: g.chain[0], chain: g.chain }));
      g.chain.forEach((b, i) => this.position.set(b, [i + 1, g.chain.length]));
      return n;
    });
  }

  private withParent(parent: Node, kids: Node[]): Node[] {
    for (const k of kids) this.parentOf.set(k, parent);
    return kids;
  }

  private node(name: string): Node {
    let n = this.nodes.get(name);
    if (!n) {
      const info = this.snap?.branches.get(name);
      n = info ? { kind: 'branch', name, info } : { kind: 'root', name };
      this.nodes.set(name, n);
    }
    return n;
  }

  async getChildren(el?: Node): Promise<Node[]> {
    if (!this.snap) return [];
    if (!el) {
      const rs = roots(this.snap.parents, this.snap.trunk);
      // hide foreign roots that have nothing under them
      return rs.filter(r => r === this.snap!.trunk || childrenOf(this.snap!.parents, r).length).map(r => this.node(r));
    }
    if (el.kind === 'files') {
      try {
        const changes = await this.prChanges(el.name);
        if (!changes.files.length) return [{ kind: 'note', name: el.name, text: 'No changes against parent' }];
        let tree = this.trees.get(el.name);
        if (!tree) this.trees.set(el.name, (tree = buildFileTree(changes.files)));
        // Pull GitHub's "Viewed" ticks once per refresh, then re-render if they differ.
        const pr = this.snap.branches.get(el.name)?.pr;
        if (pr && !this.synced.has(el.name)) {
          this.synced.add(el.name);
          const snap = this.snap;
          void this.ctx.viewed.sync(el.name, pr.number, changes.files).then(changed => {
            if (changed && this.snap === snap) this.refreshFiles(el.name);
          });
        }
        return this.entryNodes(el.name, tree, changes);
      } catch (e: any) {
        return [{ kind: 'note', name: el.name, text: `Couldn't load changes: ${e?.message ?? e}`, error: true }];
      }
    }
    if (el.kind === 'folder') return this.entryNodes(el.name, el.entry, el.changes);
    if (el.kind === 'file' || el.kind === 'note') return [];
    if (el.kind === 'stack') return this.withParent(el, el.chain.map(b => this.node(b)));
    if (el.kind === 'root') return this.withParent(el, this.groupNodes(groupsUnder(this.snap.parents, el.name)));
    // A PR row holds its files, plus nested groups only where the stack forks.
    return this.withParent(el, [this.filesNode(el.name), ...this.groupNodes(forkGroups(this.snap.parents, el.name))]);
  }

  getParent(el: Node): Node | undefined {
    if (el.kind === 'files') return this.node(el.name);
    if (el.kind === 'file' || el.kind === 'note' || el.kind === 'folder') return this.filesNode(el.name);
    return this.parentOf.get(el);
  }

  getTreeItem(el: Node): vscode.TreeItem {
    if (el.kind === 'files') return this.filesItem(el.name);
    if (el.kind === 'file') return this.fileItem(el);
    if (el.kind === 'folder') return this.folderItem(el);
    if (el.kind === 'note') {
      const item = new vscode.TreeItem(el.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(el.error ? 'error' : 'info');
      item.tooltip = el.text;
      return item;
    }

    if (el.kind === 'stack') return this.stackItem(el);

    if (el.kind === 'root') {
      const hasKids = !!this.snap && childrenOf(this.snap.parents, el.name).length > 0;
      const item = new vscode.TreeItem(el.name, hasKids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.id = `root:${el.name}`;
      item.iconPath = new vscode.ThemeIcon(el.name === this.snap?.trunk ? 'git-branch' : 'git-merge');
      const isCurrent = el.name === this.snap?.current;
      item.description = [el.name === this.snap?.trunk ? 'trunk' : 'base', isCurrent ? 'checked out' : ''].filter(Boolean).join(' · ');
      item.contextValue = isCurrent ? 'root current' : 'root';
      item.tooltip = 'Drop a PR here to start a new stack on this branch.';
      return item;
    }

    return this.prItem(el);
  }

  private stackItem(el: Extract<Node, { kind: 'stack' }>): vscode.TreeItem {
    const snap = this.snap!;
    const label = (b: string) => {
      const pr = snap.branches.get(b)?.pr;
      return pr ? `#${pr.number}` : b;
    };
    const item = new vscode.TreeItem(`Stack of ${el.chain.length}`, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `stack:${el.chain[0]}`;
    item.iconPath = new vscode.ThemeIcon('layers', stackColor(el.chain[0]));
    item.description = el.chain.map(label).join(' → ');
    item.contextValue = 'stack';
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Stack of ${el.chain.length}** on \`${snap.parents.get(el.chain[0])}\`, bottom to top:\n\n`);
    el.chain.forEach((b, i) => {
      const pr = snap.branches.get(b)?.pr;
      md.appendMarkdown(`${i + 1}. ${pr ? `#${pr.number} ${escapeMd(pr.title)}` : `\`${b}\``}\n`);
    });
    md.appendMarkdown('\n_Drop a PR on this header to put it at the bottom of the stack._');
    item.tooltip = md;
    return item;
  }

  private prItem(el: Extract<Node, { kind: 'branch' }>): vscode.TreeItem {
    const { info } = el;
    const pr = info.pr;
    const snap = this.snap!;
    const parent = snap.parents.get(info.name);
    const baseOutOfSync = !!pr && !!parent && pr.baseRefName !== parent;
    const forks = forkGroups(snap.parents, info.name).length > 0;

    const item = new vscode.TreeItem(
      pr ? `#${pr.number}  ${pr.title}` : info.name,
      forks ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `branch:${info.name}`;

    // Short, scannable status only; the branch name and details live in the tooltip.
    const foreign = isForeign(info);
    const isCurrent = info.name === snap.current;
    const bits: string[] = [];
    if (info.rebasing) bits.push('⚠ rebasing');
    if (pr?.reviewDecision === 'APPROVED') bits.push('✓ approved');
    if (pr?.reviewDecision === 'CHANGES_REQUESTED') bits.push('✗ changes requested');
    if (pr?.isDraft) bits.push('draft');
    if (foreign) bits.push(`🔒 @${pr!.author?.login ?? '?'}`);
    if (!info.rebasing && info.dirty) bits.push('● modified');
    if (isCurrent) bits.push('checked out');
    if (baseOutOfSync) bits.push('⚠ base');
    if (!pr) bits.push('no PR');
    item.description = bits.join('  ·  ');

    // GitHub-style state colours: open = green, draft = grey.
    item.iconPath = info.rebasing
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : pr
        ? pr.isDraft
          ? new vscode.ThemeIcon('git-pull-request-draft', new vscode.ThemeColor('disabledForeground'))
          : new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('git-branch');

    // Position badge (1, 2, 3 …) inside a stack.
    const pos = this.position.get(info.name);
    if (pos) item.resourceUri = vscode.Uri.from({ scheme: PR_SCHEME, path: '/' + info.name, query: String(pos[0]) });

    const ctx = ['branch'];
    if (foreign) ctx.push('foreign');
    if (isCurrent) ctx.push('current');
    ctx.push(info.worktree ? 'hasWorktree' : 'noWorktree');
    if (pr) ctx.push('hasPr');
    if (baseOutOfSync) ctx.push('baseOutOfSync');
    if (info.rebasing) ctx.push('rebasing');
    item.contextValue = ctx.join(' ');

    const md = new vscode.MarkdownString(undefined, true);
    if (pr) md.appendMarkdown(`**#${pr.number}** ${escapeMd(pr.title)}${pr.isDraft ? ' _(draft)_' : ''}\n\n`);
    if (pos) md.appendMarkdown(`$(layers) ${pos[0]} of ${pos[1]} in its stack\n\n`);
    if (pr?.author) md.appendMarkdown(`$(person) @${escapeMd(pr.author.login)}${foreign ? ' — $(lock) view only: can\'t be moved, rebased or pushed from here' : ''}\n\n`);
    md.appendMarkdown(`$(git-branch) \`${info.name}\` → \`${parent ?? '?'}\`\n\n`);
    if (baseOutOfSync) md.appendMarkdown(`$(warning) PR base on GitHub is \`${pr!.baseRefName}\` — use ☁ to update it\n\n`);
    md.appendMarkdown(info.worktree ? `$(folder) ${escapeMd(info.worktree)}` : '$(circle-slash) not checked out in a worktree');
    if (pr && this.ctx.clickAction() === 'openPr') md.appendMarkdown('\n\n_Click to open on GitHub_');
    item.tooltip = md;

    const click = this.ctx.clickAction();
    if (click === 'openPr' && pr) item.command = { command: 'stackedPrs.openPr', title: 'Open PR', arguments: [el] };
    else if (click === 'openWorktree' && info.worktree) item.command = { command: 'stackedPrs.openWorktree', title: 'Open Worktree', arguments: [el] };
    return item;
  }

  private filesItem(branch: string): vscode.TreeItem {
    const item = new vscode.TreeItem('Files', vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `files:${branch}`;
    item.iconPath = new vscode.ThemeIcon('diff');
    item.contextValue = 'files';
    const parent = this.snap?.parents.get(branch);
    item.tooltip = `Changes in ${branch} compared with ${parent} (this PR only)`;
    // Counts load in the background; the node re-renders when they arrive.
    const res = this.loaded.get(branch);
    if (!res) {
      item.description = 'loading…';
      void this.prChanges(branch).catch(() => undefined);
    } else if (res instanceof Error) {
      item.description = 'error';
    } else {
      const t = totals(res.files);
      const seen = this.ctx.viewed.countViewed(branch, res.files);
      item.description = `${seen}/${res.files.length} viewed   +${t.added} −${t.deleted}`;
      if (res.files.length && seen === res.files.length) item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    }
    return item;
  }

  private check(viewed: boolean, what: string): vscode.TreeItemCheckboxState | { state: vscode.TreeItemCheckboxState; tooltip: string } {
    return {
      state: viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: viewed ? `Mark ${what} as not viewed` : `Mark ${what} as viewed`,
    };
  }

  private folderItem(el: Extract<Node, { kind: 'folder' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(el.entry.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `folder:${el.name}:${el.entry.dir}`;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.resourceUri = vscode.Uri.from({ scheme: 'stackedprs-folder', path: '/' + el.entry.dir });
    const files = filesUnder(el.entry);
    const seen = this.ctx.viewed.countViewed(el.name, files);
    item.checkboxState = this.check(seen === files.length, 'every file in this folder');
    item.description = seen && seen < files.length ? `${seen}/${files.length}` : undefined;
    item.tooltip = el.entry.dir;
    item.contextValue = 'folder';
    return item;
  }

  private fileItem(el: Extract<Node, { kind: 'file' }>): vscode.TreeItem {
    const f = el.change;
    const name = path.posix.basename(f.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${el.name}:${f.path}`;
    item.resourceUri = vscode.Uri.from({ scheme: FILE_SCHEME, path: '/' + f.path, query: f.status });
    item.checkboxState = this.check(this.ctx.viewed.isViewed(el.name, f), 'this file');
    const bits: string[] = [];
    if (f.oldPath) bits.push(`← ${f.oldPath}`);
    if (f.added !== undefined) bits.push(`+${f.added} −${f.deleted}`);
    else bits.push('binary');
    item.description = bits.join(' · ');
    item.tooltip = `${STATUS_LABEL[f.status] ?? f.status}: ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}`;
    item.contextValue = 'file';
    item.command = { command: 'stackedPrs.openFileDiff', title: 'Open Changes', arguments: [el] };
    return item;
  }

  // ---- drag & drop ----

  handleDrag(source: readonly Node[], dt: vscode.DataTransfer): void {
    // only your own PR rows are draggable
    const rows = source.filter((n): n is Extract<Node, { kind: 'branch' }> => n.kind === 'branch');
    const foreign = rows.filter(n => isForeign(n.info));
    if (foreign.length) {
      const pr = foreign[0].info.pr!;
      vscode.window.showWarningMessage(`#${pr.number} is @${pr.author?.login ?? 'someone else'}'s PR — view only, it can't be moved.`);
      return;
    }
    const names = rows.map(n => n.name);
    if (names.length) dt.set(MIME, new vscode.DataTransferItem(names));
  }

  async handleDrop(target: Node | undefined, dt: vscode.DataTransfer): Promise<void> {
    const item = dt.get(MIME);
    if (!item || !this.snap) return;
    const names: string[] = typeof item.value === 'string' ? JSON.parse(item.value) : item.value;
    if (names.length !== 1) {
      vscode.window.showWarningMessage('Stacked PRs: drag one PR at a time.');
      return;
    }
    // Empty space = new stack on trunk. Stack header = bottom of that stack.
    // PR row (or anything inside it) = directly on top of that PR.
    if (target?.kind === 'stack') {
      if (target.chain[0] !== names[0]) await this.onDropBranch(names[0], target.chain[0], 'before');
      return;
    }
    const dest = target?.name ?? this.snap.trunk;
    if (dest === names[0]) return;
    await this.onDropBranch(names[0], dest, 'onto');
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/** Colored A/M/D badge on file rows (like Source Control), and position badges on PR rows. */
export class FileStatusDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === PR_SCHEME) return { badge: uri.query, tooltip: `Position ${uri.query} in its stack` };
    if (uri.scheme !== FILE_SCHEME) return;
    const s = uri.query;
    const color = {
      A: 'gitDecoration.addedResourceForeground',
      M: 'gitDecoration.modifiedResourceForeground',
      D: 'gitDecoration.deletedResourceForeground',
      R: 'gitDecoration.renamedResourceForeground',
      C: 'gitDecoration.addedResourceForeground',
      T: 'gitDecoration.modifiedResourceForeground',
      U: 'gitDecoration.conflictingResourceForeground',
    }[s];
    return { badge: s, tooltip: STATUS_LABEL[s], color: color ? new vscode.ThemeColor(color) : undefined };
  }
}
