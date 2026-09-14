# 设计说明

## 一句话

把「runner 在哪、现在怎么样、过去跑得如何」拆成三层，层与层之间只通过数据结构耦合，这样 CLI、DSH 工具和看板能共用同一套事实。

```
transport  →  registry  →  collect  →  store  →  score/analyze  →  report
 怎么读        读哪些        读一次      存下来      打分             出图
```

## 1. transport：怎么读

三种传输（`local` / `wsl` / `ssh`）暴露同一组最小接口：

| 方法 | 用途 |
| --- | --- |
| `runScript(script)` | 跑一段 POSIX 脚本（local 走 `node:fs`，远端走 `bash -lc`） |
| `readText` / `readJson` | 读文件 |
| `exists` / `listDirs` / `readDir` / `dirSize` | 目录探测 |

**为什么不用统一走 shell**：本机读取用 `node:fs` 既快又免于引号地狱；只有 WSL/SSH 才值得付一次进程启动的代价。

**为什么 `listWslDistros` 要看原始字节**：`wsl.exe -l -q` 输出 UTF-16LE，按 UTF-8 解出来是夹 NUL 的乱码。所以 `execCapture` 保留 `stdoutBuffer`，由调用方决定编码。

## 2. registry：读哪些（项目的心脏）

注册表条目：

```json
{
  "id": "rn_…",
  "label": "wsl-runner-1",
  "transport": { "kind": "wsl", "distro": "Ubuntu", "path": "/opt/actions-runner" },
  "identity": { "agentId": 27, "agentName": "…", "githubUrl": "…", "poolName": "Default" },
  "addedBy": "manual | adopted",
  "state": "present | missing",
  "lastSeenAt": "…"
}
```

### 关联为什么是 identity-first

runner 的**安装路径是易变的**：重装、换盘、把 `/opt/actions-runner` 改成 `/opt/actions-runner-2` 都会变。而 `agentId` 是 GitHub 分配的，跟着 agent 走。所以关联顺序是：

1. `agentId`
2. `githubUrl` + `agentName`（手工登记时通常只有这两个）
3. `transport` + 安装路径（读不到 `.runner` 时的兜底）

### 三个必须处理的边界

**a) 路径键 → 身份键的迁移**
如果先按路径登记、后来才读到 `.runner`，条目的键会从 `path:…` 变成 `agent:27`。只比身份键会让同一台 runner 看起来是新的，于是重复登记。所以 `matchRegistered()` 先比身份，再比 `host + 目录`。

**b) 主机没应答 ≠ runner 消失**
`discover` 会记录失败的主机（`unreachable`）。只有**应答了但没找到**的 runner 才标 `missing`；没应答的保留上次状态。否则 WSL 一停，整个注册表就变成一片 missing。

**c) 重复条目要报，不要悄悄合并**
两个条目指向同一个 agent 是配置错误，报 `WARNING duplicate agent` 让人自己决定删哪个。

## 3. parse：从日志里还原事实

一个 job 的事实分散在两个文件里：

- `Runner_*.log`（listener）：**何时跑、结果如何** —— `Running job:` / `completed with result:`
- `Worker_*.log`（worker）：**里面发生了什么** —— 步骤、子进程、错误行、job id

`Worker_<stamp>-utc.log` 的文件名就是 worker 的启动时间，这正是把两者配对的关键：**同名 + 启动时间相近（≤12s）**。

### 几个刻意的选择

- **孤立行不丢**：listener 日志被轮转时会出现「只有结束没有开始」的行，或「只有 worker 没有 listener」的日志。都保留成记录，宁可标记 `Unknown` 也不要静默丢失历史。
- **`Skipped` 不算失败步骤**：否则一个正常的条件跳过会把 stability 打到 0。
- **worker 知道自己的结果**：孤立 worker 记录里如果日志里有 `Job result after all job steps finish:`，就用它，只有真的没有才写 `Unknown`。
- **`pathInCommand` 必须整段匹配**：`/opt/actions-runner` 是 `/opt/actions-runner-2` 的前缀。用 `includes` 会让两台 runner 互相认领对方的进程和 cgroup 内存。

## 4. store：键去重

`jobs.jsonl` 是**键控集合**，不是追加日志：

- 有 `Job ID` → `id:<job id>`
- 否则 → `runner|name|started`

这样重复 `collect` 是幂等的：worker 的细节晚一点才出现时，是**补全**已有的 listener 记录，而不是新增一条。`snapshots.jsonl` 相反，是纯时间序列，只追加。

## 5. score / analyze：打分与聚合

见 [scoring.md](./scoring.md)。设计上只有两点值得在这里说：

- **打分是纯函数**（`scoreJobs`），存库和读库都会重跑一遍。改评分模型后，历史数据自动按新模型重算，不需要迁移。
- **看板读 `last_state.json` 而不是实时采集**。打开/刷新页面不应该触发一次 runner 扫描——那会让「看一眼」变得有副作用。

## 6. report：无框架看板

`dashboard.html.tpl` 是纯 HTML + 原生 JS + canvas，没有框架、没有打包。理由：生成的 HTML 可以直接从磁盘打开（`file://`），仓库里也能一眼读完。趋势图手写了准星、吸附、悬浮卡和图例开关。

## 已知取舍

| 取舍 | 原因 |
| --- | --- |
| 只支持 POSIX 侧的 systemd/cgroup 细节 | Windows 原生 runner 仍能采（进程 + 目录），但没有 cgroup 内存峰值 |
| `_diag` 只读最近 40 个 listener / 400 个 worker 日志 | 防止目录巨大时一次采集卡死 |
| SSH 传输不做连接池 | 一次 collect 每个主机只连几次，复杂度不值得 |
| 不调用 GitHub API | 免 token、免配额、离线可用；runner 的 online 状态以本地证据为准 |
