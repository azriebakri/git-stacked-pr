# Git Stacked PR (Cursor / VS Code extension)

A sidebar that shows your pull requests as stacks, lets you **drag and drop a PR to reorder the stack**, and does the rebasing for you — each branch inside its **own git worktree**.

```
▾ master                       trunk
   ▸ #4432  Clean Reference Checks…       draft
   ▾ ≡ Stack of 3                 #4802 → #4804 → #4810
      ▸ #4802  Remove Reference Check…   ✓ approved            1
      ▸ #4804  Remove the Purchase ctx…                       2
      ▸ #4810  Clean up tests             ● modified            3
```

Linear stacks are shown as one flat, numbered list under a coloured **Stack** header, so expanding files never pushes later PRs further right. Open PRs have a green icon, drafts grey. Clicking a PR opens it on GitHub (`stackedPrs.clickAction`).

## Install

- **Cursor** (and VSCodium, Windsurf): search **Git Stacked PR** in the Extensions view (from [Open VSX](https://open-vsx.org/extension/azriebakri/git-stacked-pr)).
- **VS Code**: search **Git Stacked PR** in the Extensions view (from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=azriebakri.git-stacked-pr)).
- Or download the `.vsix` from [Releases](https://github.com/azriebakri/git-stacked-pr/releases) → Command Palette → **Extensions: Install from VSIX…**

Requirements: `git` and the GitHub CLI (`gh auth login`). `gh` is auto-detected (including Homebrew paths and your login shell PATH); set `stackedPrs.ghPath` if it still isn't found. Without `gh`, the view still works on local branches/worktrees only.

## Using it

Open any worktree of the repo (main checkout or a branch worktree) and click the **Stacked PRs** icon in the activity bar.

| Action | How |
|---|---|
| Reorder | Drag a PR onto another PR: it goes directly on top of that PR. Drag onto a **Stack** header: it goes to the bottom of that stack. |
| New stack | Drag onto the trunk (or empty space). |
| Move a whole sub-stack | Right-click → **Move onto…** → "This PR and everything stacked on it". |
| Checkout a branch | Right-click → **Checkout Branch** checks it out in the worktree open in this window (offers to stash uncommitted changes). If the branch already lives in another worktree, it offers to open that worktree instead, since git allows a branch in only one worktree at a time. |
| See a PR's files | Expand **Files** under a PR: only that PR's changes compared with the branch below it in the stack, with A/M/D/R badges and +/− counts. Click a file for a side-by-side diff (the right side is the editable file in the PR's worktree). The ⧉ button on **Files** opens all of them in one multi-file diff. |
| Viewed checklist | Tick files (or a whole folder) under **Files** as you review; the node shows `3/12 viewed`. A file unticks itself when its content changes. For PRs, ticks sync both ways with GitHub's "Viewed" checkboxes — including on teammates' PRs, since that state is per reviewer. |
| Open the branch | Inline ⧉ button opens its worktree in a new Cursor window; ▸_ opens a terminal there. |
| Branch with no worktree | Inline **+** creates one in `<repo>.worktrees/<branch>`. |
| After amending a lower PR | Right-click → **Restack Descendants**. |
| PR base on GitHub is stale | Inline ☁ → pushes with `--force-with-lease` and runs `gh pr edit --base`. |

### Mine vs everyone

The filter button (funnel icon) in the view's title bar switches between **Only My PRs** and **Everyone's PRs**. "Mine" also includes any branch you have checked out locally.

Other people's PRs are **view-only** (🔒 @author): you can browse their files, check them out and open them, but they can't be dragged, and no reorder, restack or push will ever touch them. Dropping your PR onto a teammate's PR stacks yours on top without moving anything of theirs. A move that would require rebasing their branch is refused with an explanation.

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
| `stackedPrs.clickAction` | `openPr` | Clicking a PR row: `openPr` / `openWorktree` / `none` |
| `stackedPrs.scope` | `mine` | `mine` / `everyone` — same as the filter button in the view's title bar |

## Develop

```bash
npm install
npm test            # unit tests + end-to-end rebase tests against temp repos with worktrees
npm run package     # builds the .vsix
```

### Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, then push a tag:

```bash
git tag v0.2.1 && git push origin v0.2.1
```

The **Publish** workflow tests, packages, attaches the `.vsix` to a GitHub Release, and publishes to Open VSX (`OVSX_PAT` secret) and the VS Code Marketplace (`VSCE_PAT` secret).
Press F5 in Cursor with this folder open to run an Extension Development Host.

### Layout

- `src/stack.ts` — pure stack model and move planning (unit tested)
- `src/git.ts` — git / worktree / `gh` access
- `src/diff.ts` — parsing `git diff` output for the Files changed list
- `src/viewed.ts` — viewed checklist (local + GitHub sync)
- `src/restack.ts` — ordered rebase execution, conflict pause/resume
- `src/provider.ts` — tree view + drag-and-drop controller
- `src/extension.ts` — commands and wiring
