import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BranchInfo, PrInfo, sanitize, Scope } from './stack';
import { mergeStats, parseNumstatZ, parseRawZ, PrChanges } from './diff';

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

// ---- locating gh ----
// Apps launched from the macOS Dock / Linux launchers don't inherit the shell PATH,
// so `gh` installed via Homebrew etc. is invisible to a plain spawn. Look harder.

let ghOverride = '';
let ghResolved: Promise<string> | undefined;

/** Called when the `stackedPrs.ghPath` setting changes. */
export function setGhPath(p: string) {
  ghOverride = p.trim();
  ghResolved = undefined;
}

const isExec = (f: string) => {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

async function findGh(): Promise<string> {
  if (ghOverride) return ghOverride;
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    '/usr/bin',
    '/snap/bin',
    'C:\\Program Files\\GitHub CLI',
  ].filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, exe);
    if (isExec(f)) return f;
  }
  // Last resort: ask the user's login shell (picks up asdf/mise/nix/custom PATHs).
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || '/bin/zsh';
    try {
      const out = await new Promise<string>((res, rej) =>
        execFile(shell, ['-ilc', 'command -v gh'], { timeout: 5000 }, (e, o) => (e ? rej(e) : res(o))),
      );
      const f = out.trim().split('\n').pop()?.trim();
      if (f && isExec(f)) return f;
    } catch {
      /* fall through */
    }
  }
  return 'gh';
}

export function ghBin(): Promise<string> {
  return (ghResolved ??= findGh());
}

/** Turn a gh failure into something actionable. */
export function explainGhError(e: any): string {
  const msg: string = e?.message ?? String(e);
  if (e?.code === 'ENOENT' || /ENOENT|not found|spawn .*gh/i.test(msg) && !/HTTP|graphql/i.test(msg)) {
    return 'GitHub CLI (gh) not found. Install it, or set "stackedPrs.ghPath" to the output of `which gh`.';
  }
  if (/auth login|not logged|authentication|401|GH_TOKEN/i.test(msg)) {
    return 'gh is not logged in for this host. Run `gh auth login` in a terminal, then Refresh.';
  }
  if (/no git remotes|none of the git remotes|could not determine|not a git repository/i.test(msg)) {
    return 'gh could not match this repo to a GitHub remote. Check `git remote -v`, or run `gh repo set-default`.';
  }
  const first = msg.split('\n').find(l => l.trim()) ?? msg;
  return `gh failed: ${first.slice(0, 200)}`;
}

export function run(bin: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } },
      (err, stdout, stderr) => {
        if (err) {
          const raw = (err as any).code;
          const code = typeof raw === 'number' ? raw : null;
          const ce = new CmdError(`${bin} ${args.join(' ')}`, code, stdout, stderr || (raw === 'ENOENT' ? `spawn ${bin} ENOENT` : ''));
          if (raw === 'ENOENT') (ce as any).code = 'ENOENT';
          reject(ce);
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

  async currentBranch(wt: string = this.cwd): Promise<string | undefined> {
    const b = await git(wt, 'branch', '--show-current').catch(() => '');
    return b || undefined;
  }

  /** Check out `branch` in worktree `wt`, creating a local tracking branch from `remote` if needed. */
  async checkout(wt: string, branch: string, remote: string): Promise<void> {
    if ((await this.localBranches()).has(branch)) {
      await git(wt, 'checkout', branch);
      return;
    }
    await git(wt, 'fetch', remote, branch);
    await git(wt, 'checkout', '--track', '-b', branch, `${remote}/${branch}`);
  }

  /** Local branch if it exists, else the remote-tracking ref. */
  async resolveRef(name: string, remote: string): Promise<string> {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/${remote}/${name}`]) {
      if (await gitOk(this.cwd, 'rev-parse', '--verify', '--quiet', ref)) return ref;
    }
    // remote-only PR branch that was never fetched
    await git(this.cwd, 'fetch', remote, name).catch(() => undefined);
    if (await gitOk(this.cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`)) {
      return `refs/remotes/${remote}/${name}`;
    }
    throw new Error(`Branch ${name} not found locally or on ${remote}.`);
  }

  /** Files changed by `branch` relative to where it forks from `parent` (i.e. just this PR's diff). */
  async prChanges(branch: string, parent: string, remote: string): Promise<PrChanges> {
    const [headRef, parentRef] = await Promise.all([this.resolveRef(branch, remote), this.resolveRef(parent, remote)]);
    const head = await this.revParse(headRef);
    const base = await this.mergeBase(parentRef, head);
    const [ns, num] = await Promise.all([
      git(this.cwd, 'diff', '--raw', '--no-abbrev', '-M', '-z', base, head),
      git(this.cwd, 'diff', '--numstat', '-M', '-z', base, head),
    ]);
    const files = mergeStats(parseRawZ(ns), parseNumstatZ(num));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { base, head, files };
  }

  /** File content at a commit, or '' if it doesn't exist there. */
  async show(ref: string, file: string): Promise<string> {
    return run('git', ['show', `${ref}:${file}`], this.cwd).catch(() => '');
  }

  /** GitHub's per-file "Viewed" checkboxes for the signed-in user on a PR. */
  async prViewedState(prNumber: number): Promise<{ prId: string; files: Map<string, string> }> {
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$number){ id
        files(first:100,after:$after){ nodes{ path viewerViewedState } pageInfo{ hasNextPage endCursor } } } } }`;
    const files = new Map<string, string>();
    let prId = '';
    let after: string | undefined;
    for (let page = 0; page < 30; page++) {
      const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${prNumber}`, '-f', `query=${query}`];
      if (after) args.push('-f', `after=${after}`);
      const res = JSON.parse(await run(await ghBin(), args, this.cwd));
      const pr = res?.data?.repository?.pullRequest;
      if (!pr) throw new Error(`PR #${prNumber} not found`);
      prId = pr.id;
      for (const n of pr.files.nodes) files.set(n.path, n.viewerViewedState);
      if (!pr.files.pageInfo.hasNextPage) break;
      after = pr.files.pageInfo.endCursor;
    }
    return { prId, files };
  }

  async setPrFileViewed(prId: string, file: string, viewed: boolean): Promise<void> {
    const op = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    const query = `mutation($id:ID!,$path:String!){ ${op}(input:{pullRequestId:$id,path:$path}){ clientMutationId } }`;
    await run(await ghBin(), ['api', 'graphql', '-f', `id=${prId}`, '-f', `path=${file}`, '-f', `query=${query}`], this.cwd);
  }

  async stash(wt: string, message: string): Promise<void> {
    await git(wt, 'stash', 'push', '--include-untracked', '-m', message);
  }

  async pushForce(remote: string, branch: string): Promise<void> {
    await git(this.cwd, 'push', '--force-with-lease', remote, `${branch}:${branch}`);
  }

  // ---- GitHub via gh CLI ----

  /** All open PRs in the repo (filtering by scope happens locally, so ownership is always known). */
  async openPrs(): Promise<PrInfo[]> {
    const args = [
      'pr', 'list', '--state', 'open', '--limit', '500',
      '--json', 'number,title,url,headRefName,baseRefName,isDraft,reviewDecision,author',
    ];
    const out = await run(await ghBin(), args, this.cwd);
    return JSON.parse(out) as PrInfo[];
  }

  private static viewer: Promise<string> | undefined;
  /** Login of the account gh is signed in as. */
  async viewerLogin(): Promise<string> {
    Repo.viewer ??= run(await ghBin(), ['api', 'user', '--jq', '.login'], this.cwd).then(s => s.trim());
    return Repo.viewer.catch(e => {
      Repo.viewer = undefined;
      throw e;
    });
  }

  async setPrBase(pr: number, base: string): Promise<void> {
    await run(await ghBin(), ['pr', 'edit', String(pr), '--base', base], this.cwd);
  }
}

export interface Snapshot {
  /** Branch checked out in the worktree open in this window. */
  current?: string;
  trunk: string;
  branches: Map<string, BranchInfo>;
  parents: Map<string, string>;
  ghError?: string;
  ghErrorDetail?: string;
  viewerLogin?: string;
}

/** Collect everything the tree needs: worktrees, PRs, stored parents. */
export async function snapshot(repo: Repo, cfg: { trunk: string; scope: Scope }): Promise<Snapshot> {
  const trunk = await repo.detectTrunk(cfg.trunk);
  const [wts, stored, locals, current] = await Promise.all([
    repo.worktrees(),
    repo.storedParents(),
    repo.localBranches(),
    repo.currentBranch(),
  ]);

  let prs: PrInfo[] = [];
  let ghError: string | undefined;
  let ghErrorDetail: string | undefined;
  let viewerLogin: string | undefined;
  try {
    const [all, viewer] = await Promise.all([repo.openPrs(), repo.viewerLogin()]);
    const me = viewer.toLowerCase();
    prs = all.map(pr => ({ ...pr, mine: !!me && pr.author?.login?.toLowerCase() === me }));
    viewerLogin = viewer;
  } catch (e: any) {
    ghError = explainGhError(e);
    ghErrorDetail = e?.message ?? String(e);
  }

  const branches = new Map<string, BranchInfo>();
  const touch = (name: string) => {
    let b = branches.get(name);
    if (!b) branches.set(name, (b = { name }));
    return b;
  };

  for (const wt of wts) if (wt.branch && wt.branch !== trunk) touch(wt.branch).worktree = wt.path;
  for (const pr of prs) {
    if (pr.headRefName === trunk) continue;
    // Branches you have locally always show (with their PR, marked view-only if not yours).
    // Other PRs show only in "everyone" scope.
    if (cfg.scope === 'everyone' || pr.mine || branches.has(pr.headRefName)) touch(pr.headRefName).pr = pr;
  }
  for (const [b] of stored) {
    if (b === trunk || !locals.has(b) || branches.has(b)) continue;
    const info = touch(b);
    info.pr = prs.find(p => p.headRefName === b);
  }

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

  return { trunk, branches, parents: sanitize(parents, trunk), ghError, ghErrorDetail, current, viewerLogin };
}
