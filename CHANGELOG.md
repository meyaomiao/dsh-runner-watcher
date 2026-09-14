# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-09-15

首个公开版本。仓库：<https://github.com/meyaomiao/dsh-runner-watcher>。

### 新增

- **runner 注册表**：runner 是数据而不是写死的路径，支持手工导入与自动关联混用。
- **身份优先的自动关联**：按 `agentId` → `githubUrl+agentName` → 传输+路径的优先级匹配；runner 换目录会更新原条目而不是新增；先按路径登记、后读到 `.runner` 时会原地升级；主机无应答时不误判为 missing；重复 agent 会显式告警。
- **三种传输**：`local`（本机，任意系统）、`wsl`（`wsl.exe`）、`ssh`（远端 POSIX），暴露同一组读写接口。
- **自动发现**：systemd 单元的 `WorkingDirectory` → Windows 服务的 `PathName` → 约定路径扫描，按可靠性排序。
- **日志解析**：从 Listener/Worker 日志还原任务的起止、结果、步骤、子进程、错误行与日志体积；按「同名 + 启动时间相近」配对。
- **RPS 评分模型**：可靠 40% + 速度 25% + 效率 20% + 稳定 15%，缺维度自动重新归一化；难度作为独立的工作负载指标不参与评分。
- **滚动 RPS 趋势**：每个点覆盖最近 N 次（默认 6）任务。
- **交互式仪表盘**：canvas 手绘趋势图，支持准星吸附、悬浮看四维明细、图例开关、按 runner 分线；单文件、可 `file://` 直接打开。
- **DSH 插件**：9 个 `runner_watcher_*` 工具；`/dsh-runner-watcher` 路由提供看板与 JSON 接口；`webServer` 为可选依赖，headless profile 照常注册工具。
- **独立 CLI**：`status` / `list` / `add` / `remove` / `discover` / `adopt` / `collect` / `analyze` / `dashboard` / `serve`。
- **零运行时依赖**，无构建步骤。

### 测试

- 64 项单元测试（解析、评分、注册表关联、存储、插件契约）。
- `scripts/smoke.mjs` 端到端冒烟：造一个合成 runner 安装目录，验证导入→去重→发现→关联→采集→幂等复采→分析→出图。
