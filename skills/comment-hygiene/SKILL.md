---
name: comment-hygiene
description: Make comments and docstrings short, accurate and useful - explain why and constraints, never narrate edits or restate code; consistent docstrings for public API; one-line module responsibility docstrings. Use at the end of a refactor, when reviewing agent-written code, or when the user asks to clean up comments.
---

# Comment hygiene

Comments are for the next reader of the code as it is now. The reviewer of today's change
is not the audience, and neither is the history of how the code got here.

## Keep

- **Why** something non-obvious is done: a constraint, a workaround with its cause, a
  performance reason, a units or shape convention (`# (batch, seq, hidden)`).
- **Contracts** the code cannot express: invariants, thread-safety, ordering requirements.
- **Module docstring**: 1–3 lines naming the module's single responsibility. Agents use these
  to navigate, so every non-trivial module gets one.
- **Public API docstrings**: one summary line. Add `Args`/`Returns`/`Raises` only for things
  the names and type hints do not already say. Use the project's existing style (Google,
  NumPy or reST) consistently.

## Delete

| Kind | Example |
|---|---|
| Edit narration | `# changed to use the new retriever`, `# 修改为新的接口`, `# fixed bug` |
| History and attempts | `# v2 implementation`, `# old version below`, `# 第二版` |
| Restating the code | `# increment i`, `# return the result`, `# 导入模块` |
| Commented-out code | `# x = model(x)` blocks |
| Stale TODOs | TODOs about work done in this change, or with no owner or actionable content |
| Compatibility notes for removed shims | `# 兼容旧接口引用` once the alias is gone |
| Section banners in short files | `# ========== helpers ==========` when the file is small |
| Apologies and hedges | `# not sure this is right`, `# hack` (write the reason instead) |

## Rewrite

- Turn vague warnings into specific ones: `# hack` becomes
  `# vLLM < 0.5 ignores stop tokens in batch mode, so trim here`.
- Turn long prose into the shortest true statement. If you need a paragraph, the code
  probably needs a better name or a smaller function.
- Keep one comment language per repository. Follow the majority language of the existing
  comments, and do not mix languages within one file.

## Procedure

1. Run `clean_arch_leftovers` (categories `narrative-comment`, `commented-code`, `todo`) on the
   changed files: `since` = the base commit.
2. Read every comment in the files you changed, not just the flagged ones, and apply the
   rules above.
3. Check that every module you created or changed has an accurate responsibility docstring,
   and every public function or class you changed has an accurate summary line.
4. A docstring that disagrees with the code is a bug. Fix the docstring, or ask if the code
   might be what is wrong.
