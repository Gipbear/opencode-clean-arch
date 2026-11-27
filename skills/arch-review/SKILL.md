---
name: arch-review
description: Open an interactive Markdown review session for an architecture plan, diagnosis, or performance report so the reviewer can add inline comments, deletions, replacements, inspect diffs, and submit approval or revision feedback. Use on /arch-review or whenever a plan needs human sign-off.
---

# Interactive Markdown review

Submit a Markdown document (`.clean-arch/plan.md` by default, or any file path passed by the user) for interactive review using `clean_arch_review` (pass `root` set to the workspace root when calling via MCP).

## Procedure

1. Resolve the target file path (default `.clean-arch/plan.md` when no path is given).
2. Prefer the interactive review tool `clean_arch_review`:
   - **MCP App hosts (Antigravity side pane)**: call `clean_arch_review` with `path` (and `root` if needed; `action: "panel"` is the default). The review UI opens in the side pane without blocking. Stop editing source code and wait for the reviewer's submitted decision message to arrive in the conversation.
   - **HTTP browser hosts (opencode, CLI, or MCP hosts without MCP App UI)**: call `clean_arch_review` with `path` and `action: "open"`, display the returned URL to the user, then immediately call `clean_arch_review` with `path` and `action: "wait"` to receive the structured feedback.
   - **No review tool available**: point the user to the Markdown file path and ask them to reply `"approved"` or provide feedback in chat.
3. Handle the returned decision:
   - `approved`: proceed with execution.
   - `approved_with_notes`: apply scope-preserving notes to the file, then proceed.
   - `changes_requested`: apply every inline annotation (*replace*, *delete*, *comment*) cleanly to the file and submit for review again until approved.
