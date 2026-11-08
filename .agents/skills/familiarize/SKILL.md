---
name: familiarize
description: Use at the very start of a session to familiarize yourself with this repository before proceeding with actual work.
argument-hint: "<low|docs|skim|surface|normal> [task to prepare for]"
---

# Familiarize

Three tiers control how deep you go. The user specifies the tier, or you infer it from the request. Default is docs level.

## Tiers

### Low / docs

Read agent guidelines and project documentation only. No codebase exploration.

- `.agents/AGENTS.md`
- `.agents/skills/unslop/SKILL.md`
- `docs/roadmap.md`
- `docs/styling-guide.md`
- `README.md` (if present)

Do not read source files, config files, or directory trees.

### Skim / surface

Read guidelines (everything in Low) plus a surface-level pass over the codebase. No deep dives.

- Walk the root directory tree and note the layout (`src/client/`, `src/server/`).
- Read package and build configs (`package.json`, `tsconfig.json`, `vite.config.ts`, `drizzle.config.ts`).
- Skim client and server entry points (`src/client/main.tsx`, `src/server/index.ts`, `src/server/app.ts`), but do not open storage engines or trace RPC handlers.

Do not use subagents.

### Normal

Everyday orientation. Rules plus layout plus who owns what.

- Build on the lower tiers. Docs holds the guidelines, skim holds the layout, configs, and entry points.
- Read top-level client and server definitions only as far as skim has not covered.
- Note the conventions in place: local-first SQLite reads, zero-copy streaming, compile-time StyleX styling, TanStack Virtual lists, and 750 MB buffer headroom. New work fits the codebase, not the other way around.
- Stop at module doors. Do not open individual placement algorithms (`placement.ts`), delta sync routines (`delta.ts`), or database init scripts (`init.ts`). Do not trace call chains or data flow. Depth beyond this is task-scoped.

## Subagents

If the harness supports subagents, delegate parts of the Normal tier to run in parallel (directory mapping, manifest reading, subsystem exploration). Have each subagent report a short summary, not raw output.

If the harness does not support subagents, do the work yourself. Never use any pseudo subagents skill as a substitute.
