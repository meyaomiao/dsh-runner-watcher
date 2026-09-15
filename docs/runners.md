# 接入 Runner

runner 是一份注册表里的条目，不是代码里的常量。有两种接入方式，也可以混用。

## 一、自己导入

给一个安装目录——**含 `.runner` 的那一层**（不是 `bin/`，也不是 `_work/`）。

```bash
# WSL
dsh-runner-watcher add --kind wsl --distro Ubuntu --path /opt/actions-runner

# 本机（Windows / Linux / macOS）
dsh-runner-watcher add --kind local --path /opt/actions-runner
dsh-runner-watcher add --kind local --path 'C:\actions-runner'

# 远端
dsh-runner-watcher add --kind ssh --host build-01 --user ci --path /home/ci/actions-runner

# 远端 Windows 主机，命令改道进它的 WSL 发行版（DSH 跑在 macOS/Linux 上也能用）
dsh-runner-watcher add --kind ssh --host win-pc --user me --wsl-distro Ubuntu --path /opt/actions-runner
```

导入时会先读 `.runner`，所以：

- 条目的 `label` 默认取 agent 名；
- 条目从一开始就按 `agentId` 关联，而不是按路径；
- 读不到 `.runner` 也不会拒绝登记，只是先按路径关联，等下次发现时自动升级。

在 DSH 会话里让 agent 代劳也行：`runner_watcher_add`。

## 二、自动发现 + 自动关联

```bash
# 只看，不动注册表（结果落成 pending）
dsh-runner-watcher discover --transport wsl:Ubuntu

# 看到没问题，接进来
dsh-runner-watcher adopt
# 或者一步到位
dsh-runner-watcher discover --transport wsl:Ubuntu --adopt

# 不指定 --transport：扫本机 + 所有 WSL 发行版 + 注册表里已有主机
dsh-runner-watcher discover
```

发现候选按可靠性排序：

| 来源 | 说明 |
| --- | --- |
| `systemd` | `/etc/systemd/system/actions.runner.*.service` 里的 `WorkingDirectory=`，最权威 |
| `windows-service` | `actions.runner.*` 服务的 `PathName` |
| `path-scan` | 约定路径：`/opt/actions-runner*`、`~/actions-runner*`、`C:\actions-runner*`、`%ProgramData%`、`%ProgramFiles%` |

只有**含可读 `.runner`** 的目录才算候选。

## 关联规则

| 情况 | 结果 |
| --- | --- |
| 同一个 `agentId` | 更新原条目（路径变了就更新路径） |
| 条目原本按路径登记，现在能读到身份 | 原地升级为身份关联，不新增 |
| 新 agent | `--adopt` 则接入；否则落 `pending` |
| 主机没应答（WSL 未启动、SSH 不通） | 保留上次状态，**不标 missing** |
| 应答了但没找到 | 标 `missing`，**保留条目与历史** |
| 两个条目指向同一 agent | 报 `WARNING duplicate agent`，等你决定删哪个 |

## 增删与排查

```bash
dsh-runner-watcher list                    # 已登记 + pending
dsh-runner-watcher status                  # 实时状态（含错误信息）
dsh-runner-watcher remove <id|label|path>  # 移出注册表，历史任务保留
```

对应工具：`runner_watcher_list` / `runner_watcher_status` / `runner_watcher_remove`。

## 采集范围

```bash
dsh-runner-watcher collect                 # 默认先 discover 再采集
dsh-runner-watcher collect --no-discover   # 跳过发现，只采已登记的
```

每次采集对每台 runner 做：

1. 读 `.runner`（身份、workFolder）
2. `systemctl show` 取 cgroup 内存/峰值/CPU/重启次数（POSIX）
3. `ps` 按**整段路径**匹配进程（`/opt/actions-runner` 不会认领 `/opt/actions-runner-2`）
4. `du` 量 `_work` 体积
5. 解析 `_diag` 里的 Listener / Worker 日志

失败不会中断整轮：该 runner 记一条 `state: "error"`，其余照常。仪表盘上会直接显示错误原因。

## 常见问题

**Q：插件找不到我的 runner。**
先 `status` 看这台主机通不通；再 `discover --transport <主机>` 看候选。若路径不常规，`add` 手工指过去即可。也可以 `discover --extra-path <目录>` 让扫描额外探测某个目录。

**Q：会不会重复登记？**
不会。关联是身份优先的，而且路径键会在读到身份时原地升级。真出现重复（比如手工重复 `add` 了两个不同 `agentId` 的条目指向同一个 GitHub agent），插件会明确报 `WARNING duplicate agent`。

**Q：runner 暂时下线，历史会丢吗？**
不会。`missing` 只是标记，条目和 `jobs.jsonl` 都保留；下次扫到会恢复 `present`。

**Q：`_work` 很大，采集会不会很慢？**
`du` 只统计体积，不读内容。解析日志只取最近 40 个 Listener / 400 个 Worker 文件。
