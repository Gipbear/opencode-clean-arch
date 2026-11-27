# Clean-Arch 插件使用规范

- 调用本插件暴露的 MCP 工具（`clean_arch_facts`、`clean_arch_leftovers`、`clean_arch_render`、`clean_arch_review`、`clean_arch_perf`）时，始终传入 `root` 为当前工作区根目录的绝对路径。
- 在执行 `/clean-arch` 完整重构流程时，处于诊断和方案待批阶段严禁修改业务源码（插件 `PreToolUse` 钩子也会校验 `.clean-arch/state.json`）；方案需通过 `clean_arch_review` 在侧边栏评审批准后再实施。
- 重构内部模块迁移或重命名时，同一步更新所有调用方并直接删除旧实现，不留兼容转发层或 `_v2` 平行副本。
