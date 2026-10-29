import { FileChange } from './diff';

/** Minimal Memento shape (vscode.Memento), so this can be unit tested. */
export interface KV {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface GitHubViewed {
  prViewedState(prNumber: number): Promise<{ prId: string; files: Map<string, string> }>;
  setPrFileViewed(prId: string, file: string, viewed: boolean): Promise<void>;
}

const KEY = 'stackedPrs.viewed';

/**
 * "Viewed" checklist per branch + file.
 *
 * Locally a file counts as viewed while its blob id still matches the one recorded when it was
 * ticked, so it unticks itself when the content changes (same as GitHub). For branches with a PR,
 * ticks are mirrored to GitHub's own "Viewed" checkboxes, and ticks made on github.com show up here.
 */
export class ViewedStore {
  /** branch -> { prId, path -> GitHub state } from the last sync */
  private remote = new Map<string, { prId: string; files: Map<string, string> }>();

  constructor(
    private readonly kv: KV,
    private readonly gh: () => GitHubViewed | undefined,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  private all(): Record<string, string> {
    return this.kv.get<Record<string, string>>(KEY) ?? {};
  }

  private key(branch: string, file: string) {
    return `${branch}\0${file}`;
  }

  isViewed(branch: string, f: FileChange): boolean {
    const local = this.all()[this.key(branch, f.path)];
    const gh = this.remote.get(branch)?.files.get(f.path);
    if (gh !== undefined && gh !== 'VIEWED') return false; // unticked (or dismissed) on GitHub
    if (local !== undefined) return local === f.blob;       // ticked here: valid until content changes
    return gh === 'VIEWED';                                   // ticked on github.com only
  }

  countViewed(branch: string, files: FileChange[]): number {
    return files.filter(f => this.isViewed(branch, f)).length;
  }

  async set(branch: string, files: FileChange[], viewed: boolean, prNumber?: number): Promise<void> {
    const all = { ...this.all() };
    for (const f of files) {
      if (viewed && f.blob) all[this.key(branch, f.path)] = f.blob;
      else delete all[this.key(branch, f.path)];
    }
    await this.kv.update(KEY, all);

    const remote = this.remote.get(branch);
    // Only paths that exist in the GitHub PR diff can be marked there.
    const onGitHub = remote ? files.filter(f => remote.files.has(f.path)) : files;
    for (const f of onGitHub) remote?.files.set(f.path, viewed ? 'VIEWED' : 'UNVIEWED');

    const gh = this.gh();
    if (!gh || prNumber === undefined || !onGitHub.length) return;
    try {
      const prId = remote?.prId ?? (await gh.prViewedState(prNumber)).prId;
      await Promise.all(onGitHub.map(f => gh.setPrFileViewed(prId, f.path, viewed)));
    } catch (e: any) {
      this.log(`[viewed] couldn't sync to GitHub: ${e?.message ?? e}`);
    }
  }

  /** Pull GitHub's checkbox state. Returns true if anything visible changed. */
  async sync(branch: string, prNumber: number, files: FileChange[]): Promise<boolean> {
    const gh = this.gh();
    if (!gh) return false;
    const before = files.map(f => this.isViewed(branch, f)).join();
    try {
      const state = await gh.prViewedState(prNumber);
      this.remote.set(branch, state);
      // Adopt ticks made on github.com, pinned to the current content.
      const all = { ...this.all() };
      let dirty = false;
      for (const f of files) {
        const k = this.key(branch, f.path);
        const g = state.files.get(f.path);
        if (g === 'VIEWED' && all[k] === undefined && f.blob) { all[k] = f.blob; dirty = true; }
        if (g !== undefined && g !== 'VIEWED' && all[k] !== undefined) { delete all[k]; dirty = true; }
      }
      if (dirty) await this.kv.update(KEY, all);
    } catch (e: any) {
      this.log(`[viewed] couldn't read GitHub state for #${prNumber}: ${e?.message ?? e}`);
      return false;
    }
    return files.map(f => this.isViewed(branch, f)).join() !== before;
  }

  forget(branch: string) {
    this.remote.delete(branch);
  }
}
