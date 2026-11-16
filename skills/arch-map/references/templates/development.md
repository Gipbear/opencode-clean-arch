# 开发视图

<1-2 句：代码的分层方式。>

![模块依赖](diagrams/development-packages.svg)

<sub>源文件: [development-packages.mmd](diagrams/development-packages.mmd)</sub>

## 目录与职责

| 包 / 目录 | 职责 | 可以依赖 |
|---|---|---|
| `<pkg>/` | <一句话> | <下层包> |

## 依赖规则

- 上层可以依赖下层，反之不行（用 `clean_arch_facts` 的 `check` 检查）。
- <禁止的依赖及原因>

## 新代码放哪里

| 要加的东西 | 位置 | 参照 |
|---|---|---|
| <新的检索器 / 新的评测脚本 / 新页面> | `<path>` | `<现有例子>` |

## 已知违规

<无则写“无”。否则列出 `clean_arch_facts check` 剩余的违规及处理计划。>
