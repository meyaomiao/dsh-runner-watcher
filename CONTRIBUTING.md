# 贡献指南

## 环境

- Node ≥ 22.19（本项目在 24 上开发）
- 零运行时依赖，因此**不需要 `npm install`**

```bash
node --test             # 单元测试
node scripts/smoke.mjs  # 端到端冒烟
node lib/cli.js --help  # CLI 自检
```

## 提交前

1. `node --test` 全过；
2. `node scripts/smoke.mjs` 打印 `SMOKE OK`；
3. 改了行为就补测试；改了评分或解析规则，请在 PR 里说明**对历史数据的影响**。

## 代码约定

- 纯 ESM，`lib/` 就是源码，**不引入构建步骤**；
- 不新增运行时依赖——只用 Node 内置模块。确有必要的，请在 PR 里说明为什么内置模块做不到；
- `lib/core/` 不允许依赖 DSH/cordis。核心必须能脱离宿主单测和脚本化运行；
- 公开函数写 JSDoc；注释解释**为什么**，不解释**是什么**；
- 用户可见文案用中文，标识符与日志用英文。

## 核心不变量（改这些地方请格外小心）

| 不变量 | 位置 | 为什么 |
| --- | --- | --- |
| 路径匹配必须整段 | `util.pathInCommand` | `/opt/actions-runner` 是 `/opt/actions-runner-2` 的前缀，用 `includes` 会让两台 runner 互相认领进程 |
| 关联先身份、后路径 | `registry.matchRegistered` | 否则「先按路径登记、后读到身份」会被当成新 runner，产生重复条目 |
| 主机无应答不算 missing | `registry.associateCandidates` | 否则 WSL 一停，整个注册表变一片 missing |
| `Skipped` 不算失败步骤 | `parse.parseWorkerLog` | 否则正常条件跳过会把 stability 打到 0 |
| 孤立日志行不丢 | `parse.parseListenerJobs` / `attachWorkers` | 日志轮转不该静默抹掉历史 |
| 评分是纯函数 | `score.scoreJobs` | 存库与读库都会重跑，改模型后历史自动重算 |
| 看板不触发采集 | `session.dashboard` | 「看一眼」不应该有副作用 |

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat(registry): 支持按 agentId 合并重复条目
fix(parse): Skipped 步骤不再计入失败步骤
docs(readme): 补充 SSH 接入示例
```

## 分支与 PR

从 `main` 开分支 → 提交 → 开 PR。PR 模板里请填自测结果；涉及评分变化的，贴改动前后的分数对比。
