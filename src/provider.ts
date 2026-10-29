import * as vscode from 'vscode';
import { Snapshot } from './git';
import { BranchInfo, childrenOf, roots } from './stack';

export type Node =
  | { kind: 'root'; name: string }
  | { kind: 'branch'; name: string; info: BranchInfo };

const MIME = 'application/vnd.code.tree.stackedprs.tree';

export class StackTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  snap?: Snapshot;
  private nodes = new Map<string, Node>();

  constructor(private readonly onDropBranch: (moving: string, target: string) => Promise<void>) {}

  set(snap: Snapshot | undefined) {
    this.snap = snap;
    this.nodes.clear();
    this.emitter.fire(undefined);
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

  getChildren(el?: Node): Node[] {
    if (!this.snap) return [];
    if (!el) {
      const rs = roots(this.snap.parents, this.snap.trunk);
      // hide foreign roots that have nothing under them
      return rs.filter(r => r === this.snap!.trunk || childrenOf(this.snap!.parents, r).length).map(r => this.node(r));
    }
    return childrenOf(this.snap.parents, el.name).map(c => this.node(c));
  }

  getParent(el: Node): Node | undefined {
    const p = this.snap?.parents.get(el.name);
    return p ? this.node(p) : undefined;
  }

  getTreeItem(el: Node): vscode.TreeItem {
    const hasKids = !!this.snap && childrenOf(this.snap.parents, el.name).length > 0;
    const state = hasKids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;

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
    if (isCurrent) ctx.push('current');
    ctx.push(info.worktree ? 'hasWorktree' : 'noWorktree');
    if (pr) ctx.push('hasPr');
    if (baseOutOfSync) ctx.push('baseOutOfSync');
    if (info.rebasing) ctx.push('rebasing');
    item.contextValue = ctx.join(' ');

    const md = new vscode.MarkdownString(undefined, true);
    if (pr) md.appendMarkdown(`**#${pr.number}** ${escapeMd(pr.title)}${pr.isDraft ? ' _(draft)_' : ''}\n\n`);
    md.appendMarkdown(`$(git-branch) \`${info.name}\` → \`${parent ?? '?'}\`\n\n`);
    if (baseOutOfSync) md.appendMarkdown(`$(warning) PR base on GitHub is \`${pr!.baseRefName}\`\n\n`);
    md.appendMarkdown(info.worktree ? `$(folder) ${escapeMd(info.worktree)}` : '$(circle-slash) not checked out in a worktree');
    item.tooltip = md;
    return item;
  }

  // ---- drag & drop ----

  handleDrag(source: readonly Node[], dt: vscode.DataTransfer): void {
    const names = source.filter(n => n.kind === 'branch').map(n => n.name);
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
    const dest = target?.name ?? this.snap.trunk; // dropping on empty space = onto trunk
    if (dest === names[0]) return;
    await this.onDropBranch(names[0], dest);
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
