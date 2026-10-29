// Parsing for `git diff --name-status -z` / `--numstat -z`. No vscode imports (unit tested).

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileChange {
  status: ChangeStatus;
  path: string;      // path on the PR side (new path for renames)
  oldPath?: string;  // path on the parent side, for renames/copies
  added?: number;    // undefined for binary files
  deleted?: number;
}

export interface PrChanges {
  base: string;  // merge-base commit (parent side)
  head: string;  // branch tip commit
  files: FileChange[];
}

export function parseNameStatusZ(out: string): FileChange[] {
  const parts = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push({ status, path, oldPath });
    } else {
      files.push({ status, path: parts[i++] });
    }
  }
  return files;
}

/** Returns new-path -> [added, deleted] (undefined counts for binary files). */
export function parseNumstatZ(out: string): Map<string, [number | undefined, number | undefined]> {
  const res = new Map<string, [number | undefined, number | undefined]>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const n = (s: string) => (s === '-' ? undefined : Number(s));
    let path = m[3];
    if (path === '') {
      // rename/copy: "<add>\t<del>\t\0<old>\0<new>\0"
      i++; // old path
      path = parts[i++];
    }
    res.set(path, [n(m[1]), n(m[2])]);
  }
  return res;
}

export function mergeStats(files: FileChange[], stats: Map<string, [number | undefined, number | undefined]>): FileChange[] {
  return files.map(f => {
    const s = stats.get(f.path);
    return s ? { ...f, added: s[0], deleted: s[1] } : f;
  });
}

export function totals(files: FileChange[]) {
  let added = 0, deleted = 0;
  for (const f of files) {
    added += f.added ?? 0;
    deleted += f.deleted ?? 0;
  }
  return { added, deleted };
}
