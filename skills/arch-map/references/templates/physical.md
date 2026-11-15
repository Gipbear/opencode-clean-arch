# 物理视图

<1-2 句：部署在哪里。若仓库中没有部署文件，写明“以下根据启动脚本推断”。>

![部署](diagrams/physical-deployment.svg)

<sub>源文件: [physical-deployment.mmd](diagrams/physical-deployment.mmd)</sub>

## 节点与资源

| 节点 | 运行内容 | 资源 |
|---|---|---|
| <GPU 服务器> | <模型服务> | <GPU 型号/显存、端口> |

## 配置与密钥

| 配置 | 读取方 | 说明 |
|---|---|---|
| `<config.yaml>` / `<ENV_VAR>` | `<module>` | <用途；密钥只写名字不写值> |

## 存储

| 路径 / 存储 | 内容 | 产生方 → 使用方 |
|---|---|---|
| `<data/...>` | <数据集 / 模型 / 缓存> | <A → B> |
