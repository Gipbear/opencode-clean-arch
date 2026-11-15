# <系统名> 架构概览

<一句话：系统做什么、给谁用。>

![系统上下文](diagrams/overview-context.svg)

<sub>源文件: [overview-context.mmd](diagrams/overview-context.mmd)</sub>

## 主要流程

| 流程 | 入口 | 说明 |
|---|---|---|
| <训练 / 评测 / 在线问答 …> | [`<path>`](../../<path>) | <一句话> |

## 视图导航

| 视图 | 回答的问题 |
|---|---|
| [逻辑视图](logical.md) | 核心概念与类之间的关系 |
| [开发视图](development.md) | 代码如何组织、依赖规则、新代码放哪里 |
| [进程视图](process.md) | 运行时有哪些进程/服务，如何通信 |
| [物理视图](physical.md) | 部署在哪里、依赖哪些资源与配置 |
| [场景视图](scenarios.md) | 关键用例中各部分如何协作 |
| [数据视图](data.md) | 数据集、模型、索引与产物的流向 |
| [设计决策](decisions.md) | 为什么这样设计 |

## 关键约束

- <可度量的约束：显存、延迟、离线运行、依赖的外部服务 …>

<sub>本目录描述代码当前状态，生成于 <日期> / <commit>。面向 AI 的详细索引见 `.clean-arch/modules.md`。</sub>
