# 逻辑视图

<1-2 句：系统的核心数据结构（领域模型）与主要能力组件是什么。>

![核心类与数据模型图](diagrams/logical-classes.svg)

<sub>源文件: [logical-classes.mmd](diagrams/logical-classes.mmd)</sub>

## 核心数据契约与组件

| 名称 | 类型（数据模型 / 编排 / 能力） | 职责与关键字段 | 位置 |
|---|---|---|---|
| `<ModelOrService>` | `<@dataclass / 服务>` | <一句话职责或核心字段> | [`<path>`](../../<path>) |

## 关系与边界说明

- <只解释图中不直观的数据流向、生命周期归属，或真实存在多实现的扩展点。>
