import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BranchInfo, PrInfo, sanitize } from './stack';

export class CmdError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly code: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${cmd} failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  }
}

export function run(bin: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as any).code === 'number' ? (err as any).code : null;
          reject(new CmdError(`${bin} ${args.join(' ')}`, code, stdout, stderr));
        } else {
          resolve(stdout);
        }
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

export const git = (cwd: string, ...args: string[]) => run('git', args, cwd).then(s => s.trimEnd());
const gitOk = (cwd: string, ...args: string[]) => git(cwd, ...args).then(() => true, () => false);

export interface Worktree {
  path: string;
  branch?: string; // short name, undefined when detached
  bare: boolean;
}

export class Repo {
  private constructor(
    /** A path inside the repo (any worktree). */
    public readonly cwd: string,
    /** The main worktree (where .git lives). */
    public readonly mainPath: string,
  ) {}

  static async open(anyPath: string): Promise<Repo | undefined> {
    try {
      const top = await git(anyPath, 'rev-parse', '--show-toplevel');
      const common = path.resolve(top, await git(top, 'rev-parse', '--git-common-dir'));
      // For a normal repo common dir is <main>/.git; for a bare repo it's the repo itself.
      const mainPath = path.basename(common) === '.git' ? path.dirname(common) : top;
      return new Repo(top, mainPath);
    } catch {
      return undefined;
    }
  }

  async worktrees(): Promise<Worktree[]> {
    const out = await git(this.cwd, 'worktree', 'list', '--porcelain');
    const list: Worktree[] = [];
    let cur: Partial<Worktree> | undefined;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur?.path) list.push({ bare: false, ...cur } as Worktree);
        cur = { path: line.slice('worktree '.length), bare: false };
      } else if (line.startsWith('branch ') && cur) {
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'bare' && cur) {
        cur.bare = true;
      }
    }
    if (cur?.path) list.push({ bare: false, ...cur } as Worktree);
    return list.filter(w => !w.bare);
  }

  async localBranches(): Promise<Set<string>> {
    const out = await git(this.cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    return new Set(out.split('\n').filter(Boolean));
  }

  async detectTrunk(configured: string): Promise<string> {
    if (configured) return configured;
    try {
      const ref = await git(this.cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
      return ref.replace(/^[^/]+\//, '');
    } catch {
      const locals = await this.localBranches();
      for (const c of ['main', 'master', 'develop', 'trunk']) if (locals.has(c)) return c;
      return 'main';
    }
  }

  // ---- stack metadata, stored in git config so it is shared by every worktree ----

  async storedParents(): Promise<Map<string, { parent: string; parentSha?: string }>> {
    const res = new Map<string, { parent: string; parentSha?: string }>();
    let out = '';
    try {
      out = await git(this.cwd, 'config', '--get-regexp', '^branch\\..*\\.stack-?parent(sha)?$');
    } catch {
      return res; // exit 1 = no matches
    }
    for (const line of out.split('\n')) {
      const m = /^branch\.(.+)\.(stackparent|stackparentsha)\s+(.+)$/i.exec(line.trim());
      if (!m) continue;
      const [, branch, key, value] = m;
      const e = res.get(branch) ?? { parent: '' };
      if (key.toLowerCase() === 'stackparent') e.parent = value;
      else e.parentSha = value;
      res.set(branch, e);
    }
    for (const [b, e] of res) if (!e.parent) res.delete(b);
    return res;
  }

  async setStoredParent(branch: string, parent: string): Promise<void> {
    await git(this.cwd, 'config', `branch.${branch}.stackParent`, parent);
  }

  async setStoredParentSha(branch: string, sha: string): Promise<void> {
    await git(this.cwd, 'config', `branch.${branch}.stackParentSha`, sha);
  }

  // ---- worktree state ----

  async isRebasing(wt: string): Promise<boolean> {
    const gitDir = path.resolve(wt, await git(wt, 'rev-parse', '--git-dir'));
    return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
  }

  async isDirty(wt: string): Promise<boolean> {
    return (await git(wt, 'status', '--porcelain', '--untracked-files=no')).length > 0;
  }

  async revParse(ref: string): Promise<string> {
    return git(this.cwd, 'rev-parse', '--verify', `${ref}^{commit}`);
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    return gitOk(this.cwd, 'merge-base', '--is-ancestor', a, b);
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return git(this.cwd, 'merge-base', a, b);
  }

  async addWorktree(branch: string, root: string): Promise<string> {
    const base = root || path.join(path.dirname(this.mainPath), `${path.basename(this.mainPath)}.worktrees`);
    const dir = path.join(base, branch.replace(/[\\/:]/g, '-'));
    const locals = await this.localBranches();
    if (locals.has(branch)) {
      await git(this.mainPath, 'worktree', 'add', dir, branch);
    } else {
      // remote-only PR branch: create a local tracking branch
      await git(this.mainPath, 'fetch', 'origin', branch);
      await git(this.mainPath, 'worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`);
    }
    return dir;
  }

  async rebaseOnto(wt: string, newParent: string, upstream: string): Promise<void> {
    await git(wt, 'rebase', '--onto', newParent, upstream);
  }

  async abortRebase(wt: string): Promise<void> {
    await git(wt, 'rebase', '--abort');
  }

  async pushForce(remote: string, branch: string): Promise<void> {
    await git(this.cwd, 'push', '--force-with-lease', remote, `${branch}:${branch}`);
  }

  // ---- GitHub via gh CLI ----

  async openPrs(author: string): Promise<PrInfo[]> {
    const args = [
      'pr', 'list', '--state', 'open', '--limit', '200',
      '--json', 'number,title,url,headRefName,baseRefName,isDraft,reviewDecision',
    ];
    if (author) args.push('--author', author);
    const out = await run('gh', args, this.cwd);
    return JSON.parse(out) as PrInfo[];
  }

  async setPrBase(pr: number, base: string): Promise<void> {
    await run('gh', ['pr', 'edit', String(pr), '--base', base], this.cwd);
  }
}

export interface Snapshot {
  trunk: string;
  branches: Map<string, BranchInfo>;
  parents: Map<string, string>;
  ghError?: string;
}

/** Collect everything the tree needs: worktrees, PRs, stored parents. */
export async function snapshot(repo: Repo, cfg: { trunk: string; prAuthor: string }): Promise<Snapshot> {
  const trunk = await repo.detectTrunk(cfg.trunk);
  const [wts, stored, locals] = await Promise.all([repo.worktrees(), repo.storedParents(), repo.localBranches()]);

  let prs: PrInfo[] = [];
  let ghError: string | undefined;
  try {
    prs = await repo.openPrs(cfg.prAuthor);
  } catch (e: any) {
    ghError = e?.message ?? String(e);
  }

  const branches = new Map<string, BranchInfo>();
  const touch = (name: string) => {
    let b = branches.get(name);
    if (!b) branches.set(name, (b = { name }));
    return b;
  };

  for (const wt of wts) if (wt.branch && wt.branch !== trunk) touch(wt.branch).worktree = wt.path;
  for (const pr of prs) if (pr.headRefName !== trunk) touch(pr.headRefName).pr = pr;
  for (const [b] of stored) if (b !== trunk && locals.has(b)) touch(b);

  // parent priority: local stack config (latest intent) > PR base > trunk
  const parents = new Map<string, string>();
  for (const b of branches.values()) {
    parents.set(b.name, stored.get(b.name)?.parent || b.pr?.baseRefName || trunk);
  }

  await Promise.all(
    [...branches.values()].filter(b => b.worktree).map(async b => {
      try {
        b.rebasing = await repo.isRebasing(b.worktree!);
        b.dirty = await repo.isDirty(b.worktree!);
      } catch {
        /* worktree missing on disk (prunable) */
      }
    }),
  );

  return { trunk, branches, parents: sanitize(parents, trunk), ghError };
}
