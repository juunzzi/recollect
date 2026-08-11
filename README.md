# recollect

Personal session memory for [Claude Code](https://claude.com/claude-code).

Every session you run teaches Claude something — a decision, a gotcha, a
preference — and then the session ends and it's gone. recollect distills each
session into durable markdown memories, stores them in a git-backed vault you
own, and injects the relevant ones back into future sessions.

- **Vault is the source of truth** — plain markdown + git. Readable in any
  editor (Obsidian-compatible), diffable, portable. Everything else (indexes,
  embeddings) is a derived cache you can delete at any time.
- **Reads cost zero LLM calls** — hybrid search (BM25 + local embeddings via
  transformers.js, fully offline) served by a small warm daemon with an inline
  fallback.
- **Writes cost ~1 LLM call per session** — extraction runs once at session
  end (or compaction) through your local `claude` CLI, so it uses your
  existing subscription. No API key to manage.
- **Hooks never block** — every hook is a thin trigger that exits 0 no matter
  what fails.

## Install

Requires Node >= 20 and the `claude` CLI.

```bash
# 1. the engine (CLI + daemon + MCP server)
npm install -g github:juunzzi/recollect

# 2. your vault — a PRIVATE git repo is recommended so memories sync across machines
gh repo create <you>/recollect-vault --private
recollect init --remote git@github.com:<you>/recollect-vault.git
# (or just `recollect init` for a local-only vault at ~/recollect-vault)

# 3. the Claude Code plugin (hooks + MCP wiring)
claude plugin marketplace add juunzzi/recollect
claude plugin install recollect@recollect
```

That's it. New sessions will start accumulating memories.

If you install the plugin before running `init`, nothing breaks: recollect
injects a short setup notice into your next session telling you (and Claude)
exactly what's missing, and stays inactive until the vault exists. Re-running
`recollect init --remote ...` later attaches a remote to an existing vault.

> Keep the vault **private** — it will accumulate details about your work.

## How it works

```
SessionStart ──► daemon warm-up + catch-up extraction + memory profile injection
UserPromptSubmit ──► hybrid search(prompt) → top-5 relevant memories injected
PreToolUse (Read/Edit/Write) ──► memories tied to that file injected
Stop ──► session marked "pending" (no LLM)
PreCompact / SessionEnd ──► extractor LLM distills the transcript → vault
```

The extractor only keeps facts that pass four gates: re-applicable, not
derivable from the code itself, stable over time, and specific enough to act
on. Candidates containing anything secret-shaped are rejected outright.
New facts that replace old ones mark them `is_latest: false` (`supersedes`)
instead of deleting them, so history is preserved.

### Vault layout

```
your-vault/
  facts/
    fact/2026-08-11-1423-a1b2c3-some-title.md
    feedback/...
    procedural/...
```

Each memory is one markdown file with YAML frontmatter (`id`, `type`, `title`,
`entities`, `files`, `tags`, `confidence`, `is_latest`, ...) and a body
structured as fact / **Why** / **How to apply**.

### MCP tools

The plugin registers an MCP server with `search`, `get`, `related_to_file`,
and `remember` — so Claude can also pull memories on demand or save one when
you say "remember this".

## CLI

```
recollect search <query>         hybrid search
recollect get <id>               print one memory
recollect related --file <path>  memories tied to a file
recollect remember "<text>"      save a memory manually (no LLM)
recollect status                 vault + daemon status
recollect reindex                backfill/prune local embeddings
recollect sync                   git commit/pull/push the vault
recollect server stop            stop the daemon
```

## Configuration

`~/.recollect/config.json` (written by `init`), overridable per-process via env:

| Env | Meaning |
| --- | --- |
| `RECOLLECT_VAULT` | vault path override |
| `RECOLLECT_DISABLE=1` | kill-switch: disables all hooks/ingest/inject |
| `RECOLLECT_NO_EMBED=1` | lexical-only search (skip embeddings) |
| `RECOLLECT_EXTRACTOR` | extractor command (default `claude`) |
| `RECOLLECT_EXTRACTOR_MODEL` | model flag passed to the extractor |
| `RECOLLECT_GIT_SYNC=0` | don't auto commit/push the vault |

Embeddings are an optional dependency (`@huggingface/transformers`). If it
fails to install, everything still works in BM25-only mode; `npm i -g` again
later and run `recollect reindex`.

## Sync across machines

Give the vault a private git remote (`recollect init --remote ...` or add one
later). After each extraction recollect commits and pushes best-effort; on
conflict it aborts the rebase and retries next time — single-user vaults
rarely conflict. Clone the same setup on another machine and you have your
memory everywhere.

## Uninstall

```bash
claude plugin uninstall recollect@recollect
recollect server stop
npm uninstall -g @juunzzi/recollect
rm -rf ~/.cache/recollect ~/.recollect   # derived data + config
# your vault is yours — keep or delete it
```

## License

MIT
