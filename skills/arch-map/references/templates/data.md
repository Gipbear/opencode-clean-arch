# 数据视图

<1-2 句：系统依赖和产生哪些数据。>

![数据流](diagrams/data-flow.svg)

<sub>源文件: [data-flow.mmd](diagrams/data-flow.mmd)</sub>

| 数据 / 产物 | 格式 | 位置 | 产生方 | 使用方 |
|---|---|---|---|---|
| <训练集> | <jsonl> | `<path>` | <脚本> | <训练> |
| <模型 checkpoint> | <safetensors / state_dict> | `<path>` | <训练> | <推理> |

## 实验与可复现

<研究或训练项目填写，否则删除本节。>

| 实验 | 配置 | 运行入口 | 产物目录 | 运行清单 |
|---|---|---|---|---|
| <名称> | `<configs/x.yaml>` | `<python -m pkg.run>` | `<outputs/<run_id>/>` | `<manifest.json：配置、输入指纹、代码版本>` |

## 兼容性

- <哪些文件格式是外部契约（例如已发布的 checkpoint），修改代码时必须保持。>
