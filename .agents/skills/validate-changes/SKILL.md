---
name: validate-changes
description: "Trigger only when asked to 'validate'. Runs an architectural review against AGENTS.md and checks for stale code and references."
argument-hint: "<target file, diff, commit range, branch, or working tree>"
---

# Validate changes

Use this skill to run a strict compliance check of code changes against the repository's architectural standards (`.agents/AGENTS.md`). This acts as an adversarial review after multiple revision passes, reverts, or slices to catch regressions, drift, redundant code, and stale references before a branch is considered done.

## Important constraint

**Reporting only.** This skill is strictly an adversarial review tool. Do NOT attempt to automatically fix the violations you find. Your goal is solely to identify issues and report them to the user.

## Workflow

1. **Scope the review.** Determine what to check:
   - **File as an anchor.** Use the specified file to find where a slice began: run `git log <upstream> --full-history --oneline -- "*<name>*"`. The review covers all code changed across that range: `git diff <commit>^..HEAD -- ":(exclude)*.md"`.
   - **Branch or commit range.** Run `git diff <range>` or `git diff <base>..HEAD`.
   - **Working tree.** Run `git diff` or `git diff --cached`.
   If the diff spans multiple revisions or reverts, focus on core logic, interface boundaries, and performance.

2. **Review against `.agents/AGENTS.md`:**
   Read and cross-reference the changes specifically against the guidelines in `.agents/AGENTS.md`. Pay special attention to:
   - **Code guidelines and performance directives:** Are we using flat control flow and early returns? Are reads hitting indexed local SQLite tables (< 2ms) without calling Google Drive? Do streaming uploads and downloads avoid buffering complete files on disk or exceeding 50 MB memory? Are virtual operations applied instantly to SQLite with lazy async Drive sync? Does sync use `changes.list` with page tokens rather than tree walks?
   - **Shared architecture and boundaries:** Does each responsibility have exactly one writer? Do server models and storage placement modules stay free of DOM or client imports? Does the client communicate strictly via type-safe Hono RPC (`src/client/api.ts`) without reaching into backend internals?
   - **Frontend and StyleX styling:** Are styles written using StyleX rather than inline styles or runtime CSS-in-JS? Are design tokens referenced from `tokens.stylex.ts`? Are WCAG AAA contrast ratios (minimum 7:1) preserved across dark and light themes? Are file and folder lists rendered using TanStack Virtual to keep DOM node counts constant?
   - **Storage placement and quota integrity:** Does placement logic strictly enforce the 750 MB safety buffer ceiling (14.25 GB max on 15 GB accounts) and the 14.25 GB single-file limit? Does placement respect path affinity and folder cohesion? Are uploads recorded in the 24-hour rolling transfer window (`transfer_logs`)?
   - **Preserving contracts and metadata schemas:** Did the changes alter SQLite schemas (`schema.ts`), Google Drive `appProperties` keys (`tsubasa_managed`, `tsubasa_virtual_path`), or RPC route contracts without updating all callers, sync handlers, and owning documentation?
   - **Redundant code and shared helpers:** Did the diff inline repeated code for identical operations across callsites instead of using or extracting an intuitive shared helper? Did it miss an existing helper that already does the job?
   - **Stale code and references:** Are there unused imports or variables, dead functions, orphaned files, outdated comments, or stale paths that point to moved or renamed modules? Does the diff leave behind code that is no longer reachable? Use grep for old names, check imports, and verify every moved file has its callers updated.

   For every finding, mark severity:
   - `[Blocking]`: Direct rule breaks, breached quota or buffer ceilings, remote Drive calls in read paths, broken RPC or database contracts, or regression risks.
   - `[Warning]`: Architectural drift, premature abstractions, inline styles instead of StyleX, duplicated logic, or hot-path allocations.
   - `[Nit]`: Dead code, unused imports or variables, stale comments, or minor hygiene issues.

3. **Synthesize the verdict:**
   Output your findings in a structured Markdown format for the user:

   ```markdown
   ## Validation report

   **Target:** (e.g., Working tree, staged changes, or commit range)
   **Summary:** (A high-level 1-2 sentence description of what the diff accomplishes)

   ### AGENTS.md violations
   (List blocking issues, architectural drift, behavioral contract breaks, or rule violations found during the review. If none, explicitly state "None".)
   - [File:Line] [Blocking|Warning|Nit] Describe the violation and which AGENTS.md rule it breaks.

   ### Redundant code and shared helpers
   (List inlined repetitive code, duplicated logic across callsites, or missed opportunities to reuse or extract intuitive shared helpers. If none, explicitly state "None".)
   - [File:Line] [Blocking|Warning|Nit] Describe the duplicated logic and the recommended shared helper.

   ### Stale code and references
   (List unused imports or variables, dead functions, orphaned files, outdated comments, or stale paths that point to moved or renamed modules. If none, explicitly state "None".)
   - [File:Line] [Blocking|Warning|Nit] Describe the stale reference and why it is no longer needed.

   ### Verdict
   (Pass / Pass with warnings / Fail)
   (Provide recommendations on how the user should remediate the violations, if any.)
   ```
