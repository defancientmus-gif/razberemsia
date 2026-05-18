# Claude Code instructions for Razberemsia

This file is the working contract for Claude Code in this repository.

## Start every session

1. Read `README.md`, `PROJECT_CONTEXT.md`, `TODO.md`, and `CHANGELOG.md`.
2. Check `git status --short` before editing.
3. Treat uncommitted changes from the user or other assistants as protected. Do not revert them unless the user explicitly asks.
4. Use `rg` / `rg --files` to inspect the project before making assumptions.

## Editing rule

The production entry point is `index.html`, but do not rewrite it directly for experiments.

For a new idea, visual variant, or uncertain change:

1. create or update a prototype in `incoming/`, for example `incoming/index6dark.html`;
2. describe what changed and what risk remains;
3. wait for a clear command such as `применяй`, `делай рабочим`, `в index`, `commit`, or `push`;
4. only then copy the accepted version into `index.html`.

For small confirmed fixes, editing `index.html` is allowed, but keep the change scoped.

## Git workflow

- Prefer a separate branch or Claude Code worktree for non-trivial work.
- Do not commit `.claude/`, temporary worktrees, local secrets, logs, or generated scratch files.
- Commit only the files related to the user's request.
- Before push, show what is staged with `git diff --cached --stat`.
- Never run destructive git commands such as `git reset --hard` or `git checkout -- <file>` without explicit permission.

## Project source of truth

- `index.html` is the live PWA prototype.
- `manifest.json` and `sw.js` are PWA runtime files.
- `supabase/functions/ai/index.ts` is the server-side AI function source.
- API keys and service secrets must never be placed in `index.html`.
- Anthropic/OpenAI keys belong in local environment variables or Supabase Secrets.

## Prompt and memory organization

Canonical project memory lives in `Ai Memory/Memory Bank/`.

Use this mental grouping:

- `CORE`: stable mission, product philosophy, audience, tone.
- `SYSTEM`: technical rules, safety, architecture, deployment.
- `CREATIVE`: product ideas, interface experiments, future branches.
- `SESSION`: short summaries of recent decisions and unresolved tasks.

When context grows, compress instead of copying raw history:

- keep the current decision;
- keep the reason;
- keep affected files;
- keep next action;
- remove outdated attempts and duplicate wording.

Legacy folders such as `Master PROMT/` and `Ai Memory/Master Modes/` are source archives. Do not move or delete them unless the user explicitly asks for a cleanup pass.

## Product tone

`Разберёмся` is a calm assistant for people who feel anxious or unsure around technology.

Prefer:

- short and human wording;
- one helpful next step;
- no shame, no exam feeling;
- no jargon unless necessary;
- preserving the user's original note unless they confirm a change.

Avoid:

- turning every note into a task;
- making AI look omnipotent;
- adding noisy controls;
- breaking mobile layout.

## Verification

After frontend changes, open the local page and verify the relevant UI path when possible.

For simple static testing:

```bash
python3 -m http.server 8000
```

Then check `http://localhost:8000/`.
