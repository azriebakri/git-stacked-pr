# Stacked PRs (Cursor / VS Code extension)

A sidebar that shows your pull requests as stacks, lets you **drag and drop a PR to reorder the stack**, and does the rebasing for you — each branch inside its **own git worktree**.

```
main                       trunk
└─ #101 Add API client     feat/api
   └─ #102 Use client      feat/use-client      ● modified
      └─ #103 Add caching  feat/cache           ✓ approved
```

## Install

```bash
cursor --install-extension stacked-prs-0.1.3.vsix
```
or in Cursor: Command Palette → **Extensions: Install from VSIX…**

Requirements: `git` and the GitHub CLI (`gh auth login`). `gh` is auto-detected (including Homebrew paths and your login shell PATH); set `stackedPrs.ghPath` if it still isn't found. Without `gh`, the view still works on local branches/worktrees only.

## Using it

Open any worktree of the repo (main checkout or a branch worktree) and click the **Stacked PRs** icon in the activity bar.

| Action | How |
|---|---|
| Reorder | Drag a PR onto another PR. It is placed directly on top of the drop target. |
| Move to bottom of stack | Drag onto `main` (or empty space). |
| Move a whole sub-stack | Right-click → **Move onto…** → "This PR and everything stacked on it". |
| Checkout a branch | Right-click → **Checkout Branch** checks it out in the worktree open in this window (offers to stash uncommitted changes). If the branch already lives in another worktree, it offers to open that worktree instead, since git allows a branch in only one worktree at a time. |
| See a PR's files | Expand **Files changed** under a PR: only that PR's changes compared with the branch below it in the stack, with A/M/D/R badges and +/− counts. Click a file for a side-by-side diff (the right side is the editable file in the PR's worktree). The ⧉ button on **Files changed** opens all of them in one multi-file diff. |
| Open the branch | Inline ⧉ button opens its worktree in a new Cursor window; ▸_ opens a terminal there. |
| Branch with no worktree | Inline **+** creates one in `<repo>.worktrees/<branch>`. |
| After amending a lower PR | Right-click → **Restack Descendants**. |
| PR base on GitHub is stale | Inline ☁ → pushes with `--force-with-lease` and runs `gh pr edit --base`. |

### What a drag does

Dragging moves **one PR**, not its subtree:

1. The PR is lifted out; its children re-attach to its old parent.
2. If the drop target has exactly one child, the PR is inserted between them (normal reorder). If the target has zero or several children, the PR becomes a new child (a fork) and siblings stay put.
3. You get a confirmation listing every parent change, then each affected branch (and everything above it) is rebased with `git rebase --onto <newParent> <oldBase>` **inside its own worktree**, parents first.
4. Then it asks whether to push and retarget the PRs on GitHub (configurable).

Before rebasing it refuses if any affected worktree is dirty or already mid-rebase.

### Conflicts

If a rebase conflicts, the restack pauses and the view shows a banner. Resolve in that worktree, run `git rebase --continue`, then press **▶ Continue Restack** in the view title. **■ Cancel Restack** aborts the in-progress rebase; branches already rebased keep their new position.

## Where the stack lives

Parent relationships are stored in git config, so every worktree and any CLI tooling sees them:

```
branch.<name>.stackParent     # parent branch
branch.<name>.stackParentSha  # parent's commit at the last restack
```

Parent priority: `stackParent` config → PR base on GitHub → trunk. The recorded SHA is what makes restacking correct after you amend or rebase a lower branch: only the branch's own commits get replayed.

## Settings

| Setting | Default | |
|---|---|---|
| `stackedPrs.trunk` | auto (`origin/HEAD`) | Trunk branch |
| `stackedPrs.remote` | `origin` | Push remote |
| `stackedPrs.worktreeRoot` | `<repo>.worktrees` | Where new worktrees go |
| `stackedPrs.afterReorder` | `ask` | `ask` / `pushAndUpdateBase` / `localOnly` |
| `stackedPrs.ghPath` | auto | Full path to `gh` if auto-detect fails |
| `stackedPrs.prAuthor` | `@me` | Filter PRs by author; empty = all open PRs |

## Develop

```bash
npm install
npm test            # unit tests + end-to-end rebase tests against temp repos with worktrees
npm run package     # builds the .vsix
```
Press F5 in Cursor with this folder open to run an Extension Development Host.

### Layout

- `src/stack.ts` — pure stack model and move planning (unit tested)
- `src/git.ts` — git / worktree / `gh` access
- `src/diff.ts` — parsing `git diff` output for the Files changed list
- `src/restack.ts` — ordered rebase execution, conflict pause/resume
- `src/provider.ts` — tree view + drag-and-drop controller
- `src/extension.ts` — commands and wiring
