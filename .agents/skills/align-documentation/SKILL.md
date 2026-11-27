---
name: align-documentation
description: "Use when the user asks to align README.md, src/cli/README.md, extensions/README.md, site/README.md, or .agents/AGENTS.md with how the codebase currently works."
argument-hint: "<scope, diff, or subsystem>"
---

# Align documentation

Apply `.agents/skills/unslop/SKILL.md` to all edits. Keep everything concise, direct, and free of narration prose or conversational filler.

## Targets

- `README.md`: product overview, setup, runtime paths, dev/build scripts, stack, project layout, links to sub-READMEs.
- `src/cli/README.md`: CLI build, commands, flags, transfers, imports, transport routing, locking, automation output, exit codes.
- `extensions/README.md`: running extensions, runtime setup, manifest schema, child env vars, SQLite isolation boundary.
- `site/README.md`: static site dev/build/preview scripts, `VITE_SITE_ORIGIN`, `sync:demo` workflow, host/demo contracts, layout.
- `.agents/AGENTS.md`: layering, module ownership, and core storage, streaming, SQLite, or sync invariants.
- Git: working tree, recent commits, current branch, or a user-specified range.

## Rules

- **Current state only.** Write direct facts. Never log change history, migrations, slice notes, or "we now..." commentary.
- **Keep docs lean.** Replace stale lines instead of appending clarifications. Trim, split, merge, or reshape sections when text grows dense.
- **Respect file ownership.** Keep `README.md` high-level and link to `src/cli/README.md`, `extensions/README.md`, and `site/README.md` rather than duplicating CLI, extension, or site details.
- **Edit `.agents/AGENTS.md` sparingly.** Update architecture rules only when ownership, layering, or an invariant actually shifts.
- **Formatting.** Prefer short bullets, compact tables, and runnable examples aligned with `package.json` and code. Wrap commands, flags, paths, env vars, and routes in backticks.

## Steps

1. Check the diff or current code for changed behavior, contracts, dependencies, layout, or ownership rules.
2. Map each change to its owning file.
3. Update or tighten affected sections and cut anything stale.
