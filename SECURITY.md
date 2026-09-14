# 安全说明

## 这个插件读什么

| 数据 | 用途 |
| --- | --- |
| `<runner>/.runner` | 取 `agentId` / `agentName` / `gitHubUrl` / `poolName` / `workFolder`，用于身份关联与展示 |
| `<runner>/_diag/Runner_*.log`、`Worker_*.log` | 解析任务起止、结果、步骤、错误行 |
| `<runner>/_work` 的**体积** | 只统计字节数，不读取内容 |
| 进程列表、systemd 单元、cgroup 计数 | 实时指标 |

## 这个插件不读什么

- **不读 `<runner>/.credentials`、`.credentials_rsaparams`、`.env`**；
- **不读取仓库内容**（`_work` 只量体积）；
- **不调用 GitHub API**，不需要 token、不消耗配额、可离线使用；
- **不向任何远端发送数据**。所有数据都留在本地状态目录（默认 `<dsh home>/runner-scope`）。

## 执行的外部命令

| 场景 | 命令 |
| --- | --- |
| WSL 传输 | `wsl.exe -d <distro> [-u <user>] -- bash -lc <script>` |
| SSH 传输 | `ssh -o BatchMode=yes -o ConnectTimeout=8 [-p <port>] [-i <key>] <target> <script>` |
| 本机（Windows） | `powershell.exe -NoProfile -NonInteractive -Command Get-CimInstance Win32_Service …`、`cmd /c dir /s /-c` |
| 本机（POSIX） | `du -sb`（其余用 `node:fs`，不起进程） |

传进 shell 的路径一律经过单引号转义（`transport.shq`）。脚本内容是**代码里写死的固定字符串**，只把路径作为参数插入——不会拼接用户提供的任意命令。

## 执行策略

SSH 传输固定使用 `BatchMode=yes`：**不接受密码提示**，认证失败直接报错，避免挂住或静默降级。

## 报告漏洞

请通过 GitHub Security Advisory 私下报告，不要开公开 issue。收到后会在 7 天内回应。

## 已知边界

- 本插件以启动 DSH 的用户身份运行，能读到该用户可读的一切。请按同等权限对待它；
- 仪表盘默认只绑 `127.0.0.1`。若用 `serve --host 0.0.0.0` 暴露，请自行加访问控制——看板会显示 runner 名、仓库地址与安装路径；
- `docs/screenshots/dashboard.png` 是真实环境截图，可能包含主机名、runner 名与仓库名。公开发布前请自行决定是否替换。
