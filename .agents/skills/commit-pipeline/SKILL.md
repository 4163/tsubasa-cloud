---
name: commit-pipeline
description: Commit and push changes through the repository commit pipeline, or format commit and pull request messages. Trigger when explicitly told to commit, push, or write commit or PR messages.
argument-hint: "<push, push-x, push-a, pr, or commit context>"
---

# Commit pipeline

Use this skill when asked to run, update, or follow the repository commit pipeline, or when asked to format commit messages or pull request titles and bodies. The root `Makefile` provides `make push`, `make push-x`, and `make push-a` shortcuts to `.agents/skills/commit-pipeline/scripts/commit-pipeline.py`.

## Critical constraints

Never modify the working tree while running the commit pipeline. Do not edit, create, or delete files. The permitted Git operations are staging and unstaging, committing, and pushing. Do not rewrite history or create unnecessary micro-commits.

If invoked by the pipeline script itself, or if this skill was called directly by an agent, do not attempt to run `commit-pipeline.py` or `Makefile` shortcuts. Execute raw `git` commands directly to complete the workflow.

This constraint applies to the pipeline run itself. It does not forbid editing this skill when the user explicitly asks to update the pipeline.

## Workflow

1. Review the working tree with `git status` and `git diff`.
2. Check `.gitignore` coverage before staging. Never track private tokens, credentials, personal absolute paths, or temporary scratch files.
3. Group changes into logical commits. Prioritize user-provided context to guide grouping and intent. Keep related changes together even if they span multiple files. Split commits only when changes are independent and could reasonably be reviewed or reverted separately.
4. Stage only the files for the current commit with `git add`, then review staged changes with `git diff --cached`.
5. Commit the logical group with `git commit -m`, following the repository commit format rules below. Repeat until the working tree is clean.
6. Push all commits with `git push`.

## Commit message formatting

Follow established Nicotine+ repository conventions:

- **Header format.** Prefix with the specific module name or subsystem when changes are localized, followed by a colon and a space. For example, `shares.py: add sqlite metadata cache`, `uploads.py: handle empty paths without crashing`, or `slskproto.py: remove redundant transfer counters`. For broader components, use subsystem names such as `GUI: ...`, `CI: ...`, or `Docs: ...`. Omit the prefix and write a direct imperative summary only when changes span multiple disparate subsystems.
- **Header mood and casing.** Use imperative present tense such as `add`, `fix`, `remove`, `replace`, `rework`, or `handle`, not past tense like `added` or `fixed`. Start with a lowercase character after the module prefix colon. Keep the header concise, under 65 characters.
- **Body.** Explain the rationale and context. Focus on why the change was made and what problem it solves. Plain paragraphs work best. Use hyphen bullets only when listing distinct crash symptoms, multiple specific points, or related pull request references. Wrap body text around 72 characters.
- **References.** Note related pull request numbers, issue numbers, or previous commit hashes when fixing regressions or following up on prior commits.

## Pull requests

Write pull request descriptions from the branch diff against base:

- **Title.** Match the commit header convention using imperative present tense, such as `shares.py: add persistent sqlite metadata cache`.
- **Body structure.**
  1. **Summary.** A concise opening paragraph explaining what the branch accomplishes and why.
  2. **Changes.** Bulleted list explaining specific functional adjustments, boundary handling, and performance improvements.
  3. **Verification.** Concrete notes on manual testing and checks performed before merge.

## Serving messages to the user

When asked to draft or format a commit message or pull request description:

- Output the header or title and the body in separate copyable code blocks, one `text` block for the header, and one for the body.
- Follow unslop guidelines: active voice, plain speech, and no em dashes or puffery.
