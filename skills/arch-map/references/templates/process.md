# 进程视图

<1-2 句：运行时由哪些进程/服务组成。>

![运行时进程](diagrams/process-runtime.svg)

<sub>源文件: [process-runtime.mmd](diagrams/process-runtime.mmd)</sub>

## 进程与通信

| 进程 / 服务 | 启动方式 | 通信 | 并发模型 |
|---|---|---|---|
| <web 服务> | `<command>` | HTTP `:<port>` | <asyncio / 线程池 / 单进程> |
| <模型服务> | `<command>` | OpenAI 兼容 API | <批处理> |
| <离线任务> | `<command>` | 读写文件 `<path>` | <多进程> |

## 注意事项

- <超时、重试、资源竞争、GPU 独占等运行时约束。>
