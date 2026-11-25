# AGENTS.md

opencode 插件 `opencode-clean-arch`：把“诊断 → 方案评审 → 执行重构 → 收尾门禁 → 架构文档”做成 9 个
skill、6 个命令和 5 个工具，同一个包同时支持 opencode V1（1.x，`@opencode-ai/plugin`）和 V2（2.x，`@opencode/cli`）。
用户说明见 `README.md`（中文）。开发过程和未完成事项见本地文件 `docs/HANDOFF.md`（不入库）。

## 与用户约定的原则

- 回复用户用中文；skill 正文用英文；README 和生成给人看的架构文档用中文。
- 目标代码主要是 Python，偶尔有小前端页面。
- 兼容策略：内部旧实现直接删除，调用方在同一步改完；只有用户确认过的外部契约（已发布 API、CLI 参数、
  checkpoint/文件格式、网络接口）才保留兼容。
- 诊断和方案阶段只读，方案在浏览器检视页面里批准后才改代码。
- 文档：4+1 视图 + 数据视图 + 设计决策，文字 + SVG（由 Mermaid 渲染）。详细但不冗长，给 AI 看的细节放 `.clean-arch/`。
- 目标代码托管平台是 CodeHub：不渲染 Mermaid、不预览 HTML，所以文档嵌入 SVG。

## 目录

| 路径 | 内容 |
|---|---|
| `src/index.ts` | 插件入口：默认导出 `{ id, setup(ctx) /* V2 */, server(input) /* V1 */ }` |
| `src/tools.ts` | 5 个工具的统一定义（`ToolSpec`），再转成 V1 的 zod 形状或 V2 的 JSON Schema |
| `src/skills.ts`、`src/commands.ts` | 读取 `skills/*/SKILL.md`；6 个斜杠命令的模板 |
| `src/python.ts` | 调用 `skills/clean-arch/scripts/*.py`（`CLEAN_ARCH_PYTHON` 可指定解释器） |
| `src/render.ts` | Mermaid → 自包含 SVG（beautiful-mermaid，展开 CSS 变量和 color-mix），以及渲染警告 |
| `src/review/` | 检视页面：node:http 服务、页面（中文 UI）、Markdown 渲染、行级 diff、历史轮次 |
| `src/cli.ts` | `bun src/cli.ts render|review`，不经 opencode 使用 |
| `skills/` | 9 个 skill；`clean-arch/scripts/` 是只用标准库的 Python 分析脚本 |
| `skills/arch-map/references/templates/` | 4+1 文档模板（中文）和 `ai/` 下给 AI 的模板 |
| `tests/` | `plugin.test.ts`、`review.test.ts`（bun test）；`python/test_scripts.py`（unittest）；`fixtures/sample_repo` 是故意埋了各种问题的样例仓库 |

## 命令

```bash
npm install
npm test            # bun test + python3 -m unittest discover -s tests/python -t .
npm run typecheck   # tsc --noEmit
python3 skills/clean-arch/scripts/arch_facts.py --root <repo> summary|json|mermaid|check|importers|verify
python3 skills/clean-arch/scripts/leftover_scan.py --root <repo> [--since <ref>] [--fail-on high]
```

改了脚本行为就在 `tests/fixtures/sample_repo` 里加对应样例并补测试。

## 容易踩的坑

- V1：`config` 钩子里往 `config.skills.paths` 加路径、往 `config.command` 加命令，用 `??=` 不覆盖用户配置；
  工具参数是 zod（`tool.schema`）。V2：`ctx.skill/command/tool.transform`，工具 `execute` 返回 `{ content }`；
  V2 服务刚启动时第一个请求可能早于插件加载完成。
- 安装：V1 `opencode plugin <git-url>`（配置键 `plugin`），V2 `opencode plugin add <git-url>`（配置键 `plugins`）。
- `rules.toml` 顶层键必须写在第一个 `[table]` 之前，否则会被吞进该表（`check` 会对未知键给出警告）。
- beautiful-mermaid 的限制（渲染时会警告）：中文 subgraph id 布局错乱（写 `subgraph id["中文"]`）、
  `<-->` 只画一个箭头、`-.文字.->` 整条边丢失、`o--`/`*--` 菱形被遮住、`autonumber`/`rect rgb()`/`~~~`/`linkStyle` 无效；
  节点要在所属 subgraph 内首次声明。
- 页面客户端脚本写在 `String.raw` 模板里：不能出现反引号，正则里的 `\s` 直接写。
- 检视页面在远程机器上需要端口转发，见 README 的环境变量表（`CLEAN_ARCH_REVIEW_*`）。
