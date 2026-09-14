<div align="center">

# 🔭 dsh-runner-scope

**Self-hosted GitHub Actions runner observability for [DeepSeek Harness](https://github.com/deepseek-ai): import runners yourself or let auto-discovery link them, then score how well each runner actually performs (RPS) and watch that score move over time.**

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4d6bfe)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A522-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

</div>

![dashboard](./docs/screenshots/dashboard.png)

## Why

Runners installed months ago answer none of the questions that actually matter: what is running right now, is this machine getting slower, and which of my two runners should I trust? `dsh-runner-scope` turns those into one pipeline — **register → collect → score → chart**.

## Two ways to attach a runner

Runners live in a **registry**, not in hard-coded paths.

**Import by hand** — point at the install directory (the one holding `.runner`):

```bash
dsh-runner-scope add --kind wsl   --distro Ubuntu --path /opt/actions-runner
dsh-runner-scope add --kind local --path /opt/actions-runner
dsh-runner-scope add --kind ssh   --host build-01 --user ci --path /home/ci/actions-runner
```

**Or auto-discover and auto-associate:**

```bash
dsh-runner-scope discover --transport wsl:Ubuntu          # inspect first (lands as pending)
dsh-runner-scope discover --transport wsl:Ubuntu --adopt  # register what it finds
dsh-runner-scope discover                                 # default sweep: this machine + every WSL distro + known hosts
```

Matching is **identity-first**, so a runner that moved directories or was reinstalled updates its existing entry instead of creating a duplicate:

| Association key | Priority | Why |
| --- | --- | --- |
| `agentId` | highest | GitHub-assigned; survives reinstalls and moves |
| `githubUrl` + `agentName` | next | covers hand-written entries |
| `transport` + install path | last resort | only when `.runner` cannot be read |

A host that never answered leaves its runners at their last known state (not `missing`). Two entries resolving to one agent raise an explicit `WARNING duplicate agent` rather than being silently merged.

## RPS: how well did the runner perform?

`difficulty` describes how heavy the work was and is deliberately **not** part of any score — a runner is not worse for being handed harder jobs.

| Leg | Weight | 0–100 meaning |
| --- | --- | --- |
| reliability | 40% | success rate; failure 0, cancelled/skipped 35, success 100 |
| speed | 25% | versus the **same job name's** median duration; median = 50, 2× faster ≈ 90 |
| efficiency | 20% | child-process busy ratio + relative speed + success bonus |
| stability | 15% | fewer log errors, failed steps and non-zero exits |

Grades: **S** ≥90 / **A** ≥80 / **B** ≥70 / **C** ≥60 / **D** ≥50 / **F** <50.

The trend chart plots a **rolling RPS** (trailing 6 jobs by default), not three unrelated lines stacked together.

## Install

```bash
npm i -g dsh-runner-scope
dsh plugin --profile web add dsh-runner-scope

# or straight from GitHub
dsh plugin --profile web add github:meyaomiao/dsh-runner-scope

# or clone and mount locally
git clone https://github.com/meyaomiao/dsh-runner-scope.git
cd dsh-runner-scope && node scripts/smoke.mjs
dsh plugin --profile web add .
```

The bundled `cordis.patch.yml` inserts the plugin into the tree — no manual patch editing. Restart dsh web and hard-refresh.

## Tools

`runner_scope_status`, `runner_scope_list`, `runner_scope_add`, `runner_scope_remove`, `runner_scope_discover`, `runner_scope_adopt`, `runner_scope_collect`, `runner_scope_analyze`, `runner_scope_dashboard`.

The dashboard is served at `/dsh-runner-scope` with JSON endpoints `api/status`, `api/analyze`, `api/registry`, `api/jobs`. `webServer` is an **optional** dependency: headless profiles still load the plugin and register its tools.

## CLI

```bash
dsh-runner-scope status
dsh-runner-scope list
dsh-runner-scope discover --transport wsl:Ubuntu --adopt
dsh-runner-scope collect --hours 168
dsh-runner-scope analyze --hours 48 --json
dsh-runner-scope dashboard --open
dsh-runner-scope serve --port 8790
```

## Privacy

Reads `.runner`, `_diag`, process and systemd/cgroup data only. It never reads `.credentials`, never touches a token, and never calls the GitHub API.

## Development

```bash
node --test             # 64 unit tests: parsing, scoring, registry association, plugin contract
node scripts/smoke.mjs  # end-to-end over a synthetic runner install
```

Zero runtime dependencies, no build step — `lib/` is the source.

## License

[MIT](./LICENSE) © meyaomiao
