# Vibecodus Maximus: Ghost Code

Claude Code writes the code. You **type** it. Only what you type ever reaches git.

Every edit Claude makes in the terminal becomes a *draft*. In VS Code the draft shows up as
faded ghost text behind your code: the rest of the line you're on, `👻 +N ↓` markers where whole
blocks are waiting, strike-through on lines Claude removed. Type it out and the ghost fades.
When the file matches the draft, the draft disappears.

## Setup

```bash
code --install-extension vibecodus-maximus-0.4.0.vsix
```

That's it. Ghost mode is **on by default**: open any git repo in VS Code and the extension wires it up,
then run `claude` there as usual (sessions that were already running need a restart).

It writes, per project:

- `.claude/settings.local.json`: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (Read/Edit/Write) and `Stop` hooks
- `.gitignore`: `.ghost/`
- git `pre-commit` hook: blocks commits while Claude's drafts are on disk or a baseline is marked

Each VS Code start it re-points the hooks at the current extension install, so updates never break them.

- Opt one folder out: `Ghost: Disable ghost mode in this folder` (or click *Disable here* on the first notification). It stays off.
- Opt out everywhere: setting `vibeGhost.autoEnable: false`, then enable folders one by one with `Ghost: Enable ghost mode in this folder`.
- Non-git folders are never enabled automatically. Without VS Code: `node bin/ghost.js install <dir>`.

Recommended: turn on `files.autoSave` (`afterDelay`). The hooks work on files on disk, so unsaved typing is invisible to them.

## How it works

```
your turn                    Claude's turn                          your turn
working tree = your code ──► UserPromptSubmit: park your files  ──► Stop: Claude's version -> .ghost/files
                             in .ghost/user, put drafts on disk        your files restored
                             Claude reads/edits/tests normally         VS Code renders the drafts as ghosts
```

Claude always sees its own coherent version, so its edits, greps and test runs make sense. You
always see your version plus the ghost. Git only sees your version. Claude also gets told each
turn how far you've got typing each draft.

## In VS Code

| | |
|---|---|
| ghost text after cursor line | rest of the line to type |
| `👻 +3 ↓ code…` | 3 lines to type below (hover to see all); press Enter at the end of the line and the next one appears in place |
| red background + `👻 expected` | you typed something different |
| faded strike-through | line Claude's draft doesn't have |
| `Ctrl+Alt+G` | jump to the next line to type |
| `Ghost: Show Claude draft side by side` | diff view |
| `Ghost: Discard Claude draft for this file` | reject it |
| `Ghost: Toggle ghost mode on/off` | Claude edits files directly while off |
| `Ghost: Recover my files…` | if Claude was killed mid-turn |
| status bar `👻 N to type` | list of drafts with progress |

## Ask Claude about a ghost part

Every ghost part has a `💬 Ask Claude about this` CodeLens above it (or press `Ctrl+Alt+Q` on it,
or click the `+` in the gutter). It opens a question box right above the ghost code. Ask "why a Map
here?" and Claude answers in the same thread. Follow-ups keep the thread's context.

Questions run `claude -p` in the background, forked from your latest terminal session in that folder,
so Claude remembers why it wrote the draft. They are read-only (no Edit/Write/Bash) and never saved
as sessions, so your terminal session and `claude -c` are untouched. Settings: `vibeGhost.askModel`
(e.g. `haiku` for quick answers), `vibeGhost.askWithSessionContext`, `vibeGhost.claudePath`, `vibeGhost.askLens`.

Indentation is forgiven (tabs vs spaces, formatter output). Pasting a chunk of the draft (or
accepting an AI completion that matches it) is undone automatically. Turn that off with `vibeGhost.blockPaste`.

## CLI

```bash
node bin/ghost.js status [dir]   # drafts + typed/total lines
node bin/ghost.js out [dir]      # restore your files after an interrupted turn
node bin/ghost.js off|on [dir]
node bin/ghost.js uninstall [dir]
```

## Other AI tools (Cursor, Copilot agent, Codex, Aider, cloud PRs…)

They have no hooks, so their edits land straight in your files. Ghostify turns those edits into drafts:

```bash
node bin/ghost.js run -- codex        # mark, run the tool, ghostify what it changed
```

Or by hand, for tools that live in the editor:

```bash
node bin/ghost.js mark                # before: snapshot what you have
# ...let Cursor / Copilot / whatever write code...
node bin/ghost.js ghostify            # after: every change becomes ghost code, files go back
```

The same commands are in VS Code: `Ghost: Mark baseline` and `Ghost: Ghostify changes`.

- With a mark, only changes made after it count; your own earlier uncommitted typing stays yours.
  Restored files are byte-identical (line endings included).
- Without a mark, the baseline is the last commit, so your uncommitted edits get turned into drafts too
  (nothing is lost, you just retype them).
- New files come back empty, deleted files come back with an empty draft (delete the lines yourself),
  binary files are left as the tool wrote them.
- While a mark is set, the pre-commit hook blocks commits so un-ghostified AI code can't sneak in.
  `ghost.js unmark` drops it.
- Also works for Claude's Bash-made changes: `mark` before, `ghostify` after.

## Limits

- Files Claude changes through Bash (`sed -i`, `mv`, generators, `npm init`) bypass the draft system and land directly (use mark/ghostify for those).
- Don't type in a file while Claude is mid-turn (status bar shows `Claude writing…`): the disk holds Claude's draft then.
- If Claude is interrupted (Esc), `Stop` doesn't fire; the next prompt or session start restores your files automatically, and the pre-commit guard stops you committing in between.

## Dev

```bash
npm test
npx @vscode/vsce package --skip-license --allow-missing-repository
```
