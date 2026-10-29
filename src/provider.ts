import * as vscode from 'vscode';
import * as path from 'path';
import { Repo, Snapshot } from './git';
import { FileChange, PrChanges, totals } from './diff';
import { BranchInfo, childrenOf, isForeign, roots } from './stack';

export type Node =
  | { kind: 'root'; name: string }
  | { kind: 'branch'; name: string; info: BranchInfo }
  | { kind: 'files'; name: string } // name = branch
  | { kind: 'file'; name: string; change: FileChange; changes: PrChanges } // name = branch
  | { kind: 'note'; name: string; text: string; error?: boolean }; // name = branch

/** Scheme for file rows: lets file icons + the A/M/D badge decorate them. */
export const FILE_SCHEME = 'stackedprs-file';

const STATUS_LABEL: Record<string, string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged',
};

const MIME = 'application/vnd.code.tree.stackedprs.tree';

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

  private filesNode(branch: string): Node {
    let n = this.filesNodes.get(branch);
    if (!n) this.filesNodes.set(branch, (n = { kind: 'files', name: branch }));
    return n;
  }

  constructor(
    private readonly onDropBranch: (moving: string, target: string) => Promise<void>,
    private readonly ctx: { repo: () => Repo | undefined; remote: () => string },
  ) {}

  set(snap: Snapshot | undefined) {
    this.snap = snap;
    this.nodes.clear();
    this.changes.clear();
    this.loaded.clear();
    this.filesNodes.clear();
    this.emitter.fire(undefined);
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
        return changes.files.map(change => ({ kind: 'file', name: el.name, change, changes }));
      } catch (e: any) {
        return [{ kind: 'note', name: el.name, text: `Couldn't load changes: ${e?.message ?? e}`, error: true }];
      }
    }
    if (el.kind === 'file' || el.kind === 'note') return [];
    const kids = childrenOf(this.snap.parents, el.name).map(c => this.node(c));
    return el.kind === 'branch' ? [this.filesNode(el.name), ...kids] : kids;
  }

  getParent(el: Node): Node | undefined {
    if (el.kind === 'files') return this.node(el.name);
    if (el.kind === 'file' || el.kind === 'note') return this.filesNode(el.name);
    const p = this.snap?.parents.get(el.name);
    return p ? this.node(p) : undefined;
  }

  getTreeItem(el: Node): vscode.TreeItem {
    if (el.kind === 'files') return this.filesItem(el.name);
    if (el.kind === 'file') return this.fileItem(el);
    if (el.kind === 'note') {
      const item = new vscode.TreeItem(el.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(el.error ? 'error' : 'info');
      item.tooltip = el.text;
      return item;
    }

    const hasKids = !!this.snap && childrenOf(this.snap.parents, el.name).length > 0;
    const state = el.kind === 'branch'
      ? (hasKids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : (hasKids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);

    if (el.kind === 'root') {
      const item = new vscode.TreeItem(el.name, state);
      item.id = `root:${el.name}`;
      item.iconPath = new vscode.ThemeIcon(el.name === this.snap?.trunk ? 'git-branch' : 'git-merge');
      item.description = el.name === this.snap?.trunk ? 'trunk' : 'base';
      const isCurrent = el.name === this.snap?.current;
      if (isCurrent) item.description += ' · ✓ checked out here';
      item.contextValue = isCurrent ? 'root current' : 'root';
      item.tooltip = 'Drop a PR here to put it directly on top of this branch.';
      return item;
    }

    const { info } = el;
    const pr = info.pr;
    const parent = this.snap?.parents.get(info.name);
    const baseOutOfSync = !!pr && !!parent && pr.baseRefName !== parent;

    const item = new vscode.TreeItem(pr ? `#${pr.number} ${pr.title}` : info.name, state);
    item.id = `branch:${info.name}`;

    const bits: string[] = [];
    const isCurrent = info.name === this.snap?.current;
    if (isCurrent) bits.push('✓ checked out here');
    const foreign = isForeign(info);
    if (foreign) bits.push(`🔒 @${pr!.author?.login ?? '?'}`);
    if (pr) bits.push(info.name);
    if (info.rebasing) bits.push('⚠ rebasing');
    else if (info.dirty) bits.push('● modified');
    if (!info.worktree) bits.push('no worktree');
    if (baseOutOfSync) bits.push(`PR base: ${pr!.baseRefName}`);
    if (pr?.reviewDecision === 'APPROVED') bits.push('✓ approved');
    if (pr?.reviewDecision === 'CHANGES_REQUESTED') bits.push('✗ changes requested');
    item.description = bits.join(' · ');

    item.iconPath = info.rebasing
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : pr
        ? new vscode.ThemeIcon(pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
            pr.reviewDecision === 'APPROVED' ? new vscode.ThemeColor('testing.iconPassed') : undefined)
        : new vscode.ThemeIcon('git-branch');

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
    if (pr?.author) md.appendMarkdown(`$(person) @${escapeMd(pr.author.login)}${foreign ? ' — $(lock) view only: can\'t be moved, rebased or pushed from here' : ''}\n\n`);
    md.appendMarkdown(`$(git-branch) \`${info.name}\` → \`${parent ?? '?'}\`\n\n`);
    if (baseOutOfSync) md.appendMarkdown(`$(warning) PR base on GitHub is \`${pr!.baseRefName}\`\n\n`);
    md.appendMarkdown(info.worktree ? `$(folder) ${escapeMd(info.worktree)}` : '$(circle-slash) not checked out in a worktree');
    item.tooltip = md;
    return item;
  }

  private filesItem(branch: string): vscode.TreeItem {
    const item = new vscode.TreeItem('Files changed', vscode.TreeItemCollapsibleState.Collapsed);
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
      item.description = `${res.files.length} file${res.files.length === 1 ? '' : 's'} · +${t.added} −${t.deleted}`;
    }
    return item;
  }

  private fileItem(el: Extract<Node, { kind: 'file' }>): vscode.TreeItem {
    const f = el.change;
    const name = path.posix.basename(f.path);
    const dir = path.posix.dirname(f.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${el.name}:${f.path}`;
    item.resourceUri = vscode.Uri.from({ scheme: FILE_SCHEME, path: '/' + f.path, query: f.status });
    const bits: string[] = [];
    if (dir !== '.') bits.push(dir);
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
    // dropping on empty space = onto trunk; dropping on a file row = onto its PR
    const dest = target?.name ?? this.snap.trunk;
    if (dest === names[0]) return;
    await this.onDropBranch(names[0], dest);
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/** Colored A/M/D badge on file rows, like the Source Control view. */
export class FileStatusDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
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
