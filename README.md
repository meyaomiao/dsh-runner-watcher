<div align="center">

# 🔭 dsh-runner-scope · 自托管 Runner 观测镜

**把本机 / WSL / SSH 上的 GitHub Actions self-hosted runner 接进 [DeepSeek Harness](https://github.com/deepseek-ai)：自己导入或让自动发现去关联，然后用 RPS 四维评分看清「这台 runner 到底跑得怎么样」，并在可交互的趋势图上看它随时间的变化。**

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4d6bfe)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A522-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

</div>

![仪表盘](./docs/screenshots/dashboard.png)

---

## ✨ 它解决什么

自托管 runner 的日常问题不是「装没装上」，而是：

- 这台机器现在**在跑什么**？内存峰值多少？`_work` 涨到多大了？
- 上周那批 `Verify and package` 为什么老是失败？是任务变重了，还是 runner 变差了？
- 我有两台 runner，**哪台更靠谱**？趋势是在变好还是变坏？

`dsh-runner-scope` 把这三件事合成一条流水线：**接入 runner → 采集 → 打分 → 看趋势**。

---

## 🧩 两种接入方式（本插件与旧脚本最大的不同）

旧版把 runner 安装目录写死在代码里。现在 runner 是一份**注册表**，两种方式随你选，也可以混用。

### 方式一：自己导入

指哪打哪，给一个安装目录（含 `.runner` 的那一层）即可：

```bash
dsh-runner-scope add --kind wsl   --distro Ubuntu --path /opt/actions-runner
dsh-runner-scope add --kind local --path /opt/actions-runner
dsh-runner-scope add --kind ssh   --host build-01 --user ci --path /home/ci/actions-runner
```

在 DSH 会话里也可以直接让 agent 调 `runner_scope_add`。

### 方式二：自动发现 + 自动关联

扫一遍主机，把找到的 runner 按**身份**关联进注册表：

```bash
dsh-runner-scope discover --transport wsl:Ubuntu          # 先看找到什么（落成 pending）
dsh-runner-scope discover --transport wsl:Ubuntu --adopt  # 直接接入
dsh-runner-scope discover                                 # 不指定：本机 + 所有 WSL 发行版 + 注册表里已有主机
```

发现到的 runner 不是靠路径去重的，而是**靠 GitHub 侧的身份**：

| 关联键 | 优先级 | 说明 |
| --- | --- | --- |
| `agentId` | 最高 | GitHub 分配的 agent id，重装、换目录后依然是同一台 |
| `githubUrl` + `agentName` | 次之 | 手工登记的条目通常只有这两个字段 |
| `transport` + 安装路径 | 兜底 | 连 `.runner` 都读不到时才会用到 |

因此：

- runner 换了安装目录 → **更新**原条目，不会多出一条；
- 先按路径登记、后来才读到 `.runner` → **原地升级**为身份关联；
- 主机这次没应答（WSL 没起、SSH 不通）→ 保留上次状态，**不会误标成 missing**；
- 两个条目指向同一个 agent → 会明确报 `WARNING duplicate agent`，而不是悄悄合并。

发现不到的已登记 runner 会被标成 `missing`（保留条目，不删数据），下次扫到自动恢复 `present`。

---

## 📊 RPS 评分：回答「runner 跑得好不好」

难度（difficulty）只描述**这次的活有多重**，刻意不进任何评分——runner 不会因为被派了重活就变差。

RPS（Runner Performance Score，0–100）是四维加权：

| 维度 | 权重 | 0–100 含义 |
| --- | --- | --- |
| 可靠 reliability | 40% | 成功率。失败 0，取消/跳过 35，成功 100 |
| 速度 speed | 25% | 相对**同名任务**历史中位耗时。中位 = 50，快一倍 ≈ 90，慢一倍 ≈ 10 |
| 效率 efficiency | 20% | 子进程忙碌比 + 相对速度 + 成功奖励 |
| 稳定 stability | 15% | 日志错误行、失败步骤、非 0 退出码越少越高 |

等级：**S** ≥90 / **A** ≥80 / **B** ≥70 / **C** ≥60 / **D** ≥50 / **F** <50。

单次任务另有 `job_score`（同样四维，权重 35/25/20/20）。缺维度时权重会自动重新归一化，所以 worker 日志被轮转也能评分，只是证据更少。

趋势图画的**不是**把成功率、耗时、难度三条线硬叠在一起，而是**滚动 RPS**：横轴是任务完成时间，每个点 = 最近 N 次任务（默认 6）的综合分。

<details>
<summary>为什么速度是「相对同名任务中位」而不是绝对秒数</summary>

`Verify and package` 天然要几分钟，`Detect deploy targets` 只要十几秒。用绝对耗时会得出「谁跑得快谁就好」的错误结论。改成同名任务的中位比值之后，**同一个工作流在不同 runner 上的表现才可比**，同一个 runner 的时间趋势才有意义。

同理，只有同名任务样本 ≥3 时才用它的中位，否则退回全局中位，避免冷启动阶段乱打分。
</details>

---

## 📦 安装

```bash
# 从 npm（发布后）
npm i -g dsh-runner-scope
dsh plugin --profile web add dsh-runner-scope

# 从 GitHub 直接装
dsh plugin --profile web add github:meyaomiao/dsh-runner-scope

# 克隆后本地挂载
git clone https://github.com/meyaomiao/dsh-runner-scope.git
cd dsh-runner-scope && node scripts/smoke.mjs
dsh plugin --profile web add .
```

插件自带的 `cordis.patch.yml` 会把自己 insert 进插件树，**不需要手工改 patch**。装完重启 dsh web 并硬刷新浏览器。

然后在 DSH 里说一句「看看 runner 状态」，或直接跑 CLI：

```bash
dsh-runner-scope collect        # 采集 + 入库 + 分析
dsh-runner-scope dashboard --open
```

---

## 🛠 DSH 工具

| 工具 | 作用 |
| --- | --- |
| `runner_scope_status` | 实时状态：state、cgroup 内存/CPU、进程、`_work`、当前任务 |
| `runner_scope_list` | 注册表：已登记 runner + 待确认候选 |
| `runner_scope_add` | 手工导入一台 |
| `runner_scope_remove` | 移出注册表（保留历史任务） |
| `runner_scope_discover` | 扫描主机并按身份关联 |
| `runner_scope_adopt` | 把 pending 候选正式接入 |
| `runner_scope_collect` | 采集 + 入库 + 出分析 |
| `runner_scope_analyze` | 只分析已存历史 |
| `runner_scope_dashboard` | 渲染 HTML 仪表盘并返回路径 |

Web 端在 `/dsh-runner-scope` 提供仪表盘，另有 JSON 接口：`api/status`、`api/analyze`、`api/registry`、`api/jobs`。

> `webServer` 是**可选**依赖：headless profile 里插件照常装载并注册工具，只是不挂路由。

---

## 💻 CLI

不装 DSH 也能用（cron、排障、首次试用）：

```bash
dsh-runner-scope status                    # 实时状态
dsh-runner-scope list                      # 注册表
dsh-runner-scope add --kind wsl --distro Ubuntu --path /opt/actions-runner
dsh-runner-scope discover --transport wsl:Ubuntu --adopt
dsh-runner-scope adopt                     # 接入 pending 候选
dsh-runner-scope collect --hours 168
dsh-runner-scope analyze --hours 48 --json
dsh-runner-scope dashboard --out ./d.html --refresh 15 --open
dsh-runner-scope serve --port 8790         # 起一个只读看板
```

---

## 🗂 数据目录

默认 `<dsh home>/runner-scope`（可用 `--data-dir` / `DSH_RUNNER_SCOPE_DIR` / 插件配置覆盖）。

| 文件 | 含义 |
| --- | --- |
| `runners.json` | 注册表：已登记 runner + pending 候选 |
| `jobs.jsonl` | 去重后的任务记录（含四维与难度） |
| `snapshots.jsonl` | 每次 collect 的资源快照（时间序列，只追加） |
| `last_state.json` | 最近一次完整状态（仪表盘直接读它，翻页不会触发采集） |
| `dashboard.html` | 生成的看板 |

**只读 `.runner`、`_diag`、systemd/进程信息**；不读 `.credentials`、不碰 token、不调用 GitHub API。

---

## 🔍 采集范围

| 传输 | 实时指标来源 | 任务来源 |
| --- | --- | --- |
| `local` | 进程 + 目录体积 | `<dir>/_diag` |
| `wsl` | `systemctl show`（cgroup 内存/CPU/重启）+ `ps` | `<dir>/_diag` |
| `ssh` | 同上（远端 POSIX 命令） | `<dir>/_diag` |

发现候选的来源按可靠性排序：**systemd 单元**（自带 `WorkingDirectory`）→ **Windows 服务**（`PathName`）→ **约定路径扫描**。

---

## ⚙️ 配置

`cordis.patch.yml` 里的 `config:` 全部可选：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `dataDir` | `<dsh home>/runner-scope` | 状态目录 |
| `autoDiscover` | `true` | collect 前是否先扫一遍 |
| `autoAdopt` | `false` | 发现即接入，还是先落 pending |
| `windowHours` | `168` | 分析窗口 |
| `rollingWindow` | `6` | 一个 RPS 点覆盖多少次任务 |
| `refreshSeconds` | `0` | 看板自动刷新间隔，0 关闭 |

---

## 🧪 开发

```bash
node --test            # 64 项单测：解析 / 评分 / 注册表关联 / 插件契约
node scripts/smoke.mjs # 端到端：造一个假 runner 安装目录，走完 导入→关联→采集→分析→出图
```

零运行时依赖（只用 Node 内置模块），无构建步骤，`lib/` 就是源码。

```
lib/
  index.js            DSH 插件入口（工具 + 可选 web 路由）
  cli.js              独立命令行
  core/
    paths.js          状态目录解析
    transport.js      local / wsl / ssh 三种传输
    registry.js       注册表 + 身份关联（项目的心脏）
    discover.js       自动发现 + .runner 解析
    parse.js          Listener / Worker 日志解析
    score.js          RPS 评分模型
    store.js          JSONL 任务库（键去重）
    collect.js        快照采集
    analyze.js        聚合分析
    report.js         看板渲染
  dashboard.html.tpl  无框架的看板模板（canvas 交互图）
```

设计与取舍见 [docs/design.md](./docs/design.md)，评分细节见 [docs/scoring.md](./docs/scoring.md)，接入说明见 [docs/runners.md](./docs/runners.md)。

---

## 📋 兼容性

| 插件版本 | DSH |
| --- | --- |
| 0.1.x | 0.1.5-rc 线（`ctx.tools.register` + `webServer.register`），Node ≥22 |

---

## License

[MIT](./LICENSE) © meyaomiao
