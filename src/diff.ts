// Parsing for `git diff --name-status -z` / `--numstat -z`. No vscode imports (unit tested).

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileChange {
  status: ChangeStatus;
  path: string;      // path on the PR side (new path for renames)
  oldPath?: string;  // path on the parent side, for renames/copies
  added?: number;    // undefined for binary files
  deleted?: number;
  /** Blob id on the PR side (parent side for deletions); changes whenever the file's content does. */
  blob?: string;
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

/** `git diff --raw -M -z --no-abbrev`: like name-status, plus blob ids. */
export function parseRawZ(out: string): FileChange[] {
  const parts = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++];
    if (!meta || meta[0] !== ':') continue;
    // :<srcmode> <dstmode> <srcsha> <dstsha> <status>[score]
    const [, , srcSha, dstSha, code] = meta.slice(1).split(' ');
    const status = code[0] as ChangeStatus;
    const blob = status === 'D' ? srcSha : dstSha;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      files.push({ status, path: parts[i++], oldPath, blob });
    } else {
      files.push({ status, path: parts[i++], blob });
    }
  }
  return files;
}

// ---- folder tree for the Files changed list ----

export interface FolderEntry {
  /** Full directory path, e.g. "src/data/productCatalogue". */
  dir: string;
  /** Label shown: single-child folder chains are compressed ("src/data/productCatalogue"). */
  label: string;
  folders: FolderEntry[];
  files: FileChange[];
}

export function buildFileTree(files: FileChange[]): FolderEntry {
  const root: FolderEntry = { dir: '', label: '', folders: [], files: [] };
  for (const f of files) {
    const segs = f.path.split('/');
    let cur = root;
    for (const seg of segs.slice(0, -1)) {
      const dir = cur.dir ? `${cur.dir}/${seg}` : seg;
      let next = cur.folders.find(x => x.dir === dir);
      if (!next) cur.folders.push((next = { dir, label: seg, folders: [], files: [] }));
      cur = next;
    }
    cur.files.push(f);
  }
  const compress = (e: FolderEntry): FolderEntry => {
    e.folders = e.folders.map(compress);
    // merge a folder whose only content is one sub-folder
    while (e !== root && e.files.length === 0 && e.folders.length === 1) {
      const only = e.folders[0];
      e = { ...only, label: `${e.label}/${only.label}` };
    }
    e.folders.sort((a, b) => a.label.localeCompare(b.label));
    e.files.sort((a, b) => a.path.localeCompare(b.path));
    return e;
  };
  return compress(root);
}

export function filesUnder(e: FolderEntry): FileChange[] {
  return [...e.files, ...e.folders.flatMap(filesUnder)];
}
