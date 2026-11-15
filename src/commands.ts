export interface CommandSpec {
  name: string
  description: string
  /** Prompt sent to the agent; `$ARGUMENTS` is replaced with what the user typed after the command. */
  template: string
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "clean-arch",
    description: "诊断 → 方案评审 → 重构 → 收尾检查 → 架构文档（完整流程）",
    template:
      "Load the `clean-arch` skill and run its workflow. Scope: $ARGUMENTS (the whole repository if empty). " +
      "Diagnosis and planning are read-only; do not change source code before the plan is approved in clean_arch_review.",
  },
  {
    name: "arch-diagnose",
    description: "只读诊断代码结构问题（重复、循环依赖、遗留版本、上帝类……）",
    template:
      "Load the `arch-diagnose` skill and diagnose: $ARGUMENTS (the whole repository if empty). " +
      "Read-only: write only .clean-arch/diagnosis.md and show me a short summary.",
  },
  {
    name: "arch-map",
    description: "生成/更新 4+1 架构文档与 SVG 类图、设计图",
    template:
      "Load the `arch-map` skill and document the current architecture of: $ARGUMENTS (the whole repository if empty). " +
      "Do not change source code.",
  },
  {
    name: "clean-finish",
    description: "收尾检查：遗留版本、兼容层、注释代码、调试输出、断裂导入",
    template:
      "Load the `clean-finish` skill and run the gate on the current changes. Base ref: $ARGUMENTS " +
      "(if empty, use the base commit in .clean-arch/baseline.md, or the merge base with the main branch). Fix what fails.",
  },
  {
    name: "arch-review",
    description: "在浏览器中评审一个 Markdown 文档（方案、设计）",
    template:
      "Call clean_arch_review for the file $ARGUMENTS (default .clean-arch/plan.md). " +
      "When it returns, apply the feedback to the file if changes were requested and submit it for review again until approved.",
  },
]

export function expandTemplate(template: string, args: string): string {
  return template.replaceAll("$ARGUMENTS", args.trim())
}
