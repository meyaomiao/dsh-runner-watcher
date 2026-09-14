# 发布清单（待确认）

> **状态：仓库已推送到 GitHub；npm 发包与版本 tag 尚未执行。**
>
> - ✅ 仓库已创建并推送：<https://github.com/meyaomiao/dsh-runner-scope>（public，MIT）
> - ✅ 首版提交 `b8a381e`，`main` 已跟踪 `origin/main`
> - ✅ CI 全绿（ubuntu/windows × node 22/24 + 打包内容检查，共 5 个任务）
> - ❌ 尚未 `npm publish`
> - ❌ 尚未打 `v0.1.0` tag / 建 Release
> - ✅ 没有改动你现有的 DSH profile（插件还未安装进 `web`）

---

## 1. 已定 / 待你拍板

| # | 事项 | 当前状态 | 若要改 |
| --- | --- | --- | --- |
| 1 | 仓库名 / npm 包名 | `dsh-runner-scope`（已建仓，**npm 尚未占用这个名字**，先到先得） | 改 `package.json` 的 `name`、`cordis.patch.yml` 的 `name`、README 链接 |
| 2 | GitHub 归属 | `meyaomiao`（已建仓） | 需在 GitHub 上改名或转移 |
| 3 | 可见性 | **public**（已公开） | Settings → Danger Zone → Change visibility |
| 4 | 首次版本号 | `0.1.0` | 改 `package.json` 的 `version` |
| 5 | 是否现在就发 npm | **否，等你确认** | 见第 4.3 步 |
| 6 | `docs/screenshots/dashboard.png` | **已脱敏** | 见下 |

第 6 条说明：README 里的截图原本取自本机真实数据，包含主机名、Windows 用户名、runner 名与仓库名。**推送前已替换为脱敏版本**：用同一份真实数据（106 个任务、同一张曲线）做字符串替换后重新渲染，图中显示为 `ci-host` / `C:\Users\ci\…` / `wsl-runner-1` / `wsl-runner-2` / `github.com/acme/ci-demo`。曲线形状与数值完全真实，只有标识符是化名。仓库里也不再有 `xzb17` / `DESKTOP-8JIQIVM` / `Moiraism` 字样（可用 `git grep` 自查）。

想换回真实标识符的话，替换图片后 `git commit` 再 push 即可（历史里已有脱敏版，注意这会在历史中留下两个版本）。

---

## 2. 已经验证过的事

| 验证 | 方式 | 结果 |
| --- | --- | --- |
| 单测 | `node --test` | **64 项全过**（解析 / 评分 / 注册表关联 / 插件契约 / 存储） |
| 端到端 | `node scripts/smoke.mjs` | 造一个假 runner 安装目录，走完 导入→去重→发现→关联→采集→幂等复采→分析→出图 |
| 真实采集 | 对你的 WSL runner 跑 `discover` / `adopt` / `collect` | 找到 2 台（systemd 单元识别），入库 **106** 个任务，RPS 69.6 C |
| 仪表盘 | 生成的 HTML 在浏览器打开 | 6 个 KPI、运行卡、注册表、7 行任务名、80 行任务、8 项图例；canvas 正常绘制；悬浮显示四维明细 |
| **插件真实装载** | 隔离 `DSH_HOME` 里 `dsh plugin add` + `dsh --profile web --port 18790` | `--dump-config` 显示插件已组合；`GET /dsh-runner-scope` 返回 200 HTML；`GET /dsh-runner-scope/api/registry` 返回 200 JSON |
| 无 webServer 场景 | 插件用 `ctx.inject(['webServer'])` 挂路由 | 路由是可选依赖，headless profile 仍会注册工具 |

隔离验证用的临时 `DSH_HOME` 与 18790 端口的实例**都已清理**，你当前运行在 3080 的 web 实例没有被动过。

### 复现验证

```bash
cd D:/Project/dsh/dsh-runner-scope
node --test
node scripts/smoke.mjs

# 真实采集（只读，不写你的 profile）
node lib/cli.js discover --data-dir "$TEMP/rs-check" --transport wsl:Ubuntu
node lib/cli.js adopt    --data-dir "$TEMP/rs-check"
node lib/cli.js collect  --data-dir "$TEMP/rs-check" --no-discover
node lib/cli.js dashboard --data-dir "$TEMP/rs-check" --open
```

---

## 3. 发布前手工确认

- [x] 仓库已在 GitHub 建好并推送（public，CI 全绿）
- [x] 截图已脱敏；`git grep -E 'xzb17|DESKTOP-8JIQIVM|Moiraism' HEAD` 无命中
- [x] 提交身份统一为 `meyaomiao <47934159+meyaomiao@users.noreply.github.com>`
- [x] `package.json` 的 `repository` / `homepage` / `bugs` 指向真实远端
- [ ] 看完 `README.md`，确认描述与你的预期一致
- [ ] 决定是否现在发 npm（第 4.3 步）

---

## 4. 剩余发布步骤（确认后再执行）

### 4.1 建仓并推首版 ✅ 已完成

仓库地址 <https://github.com/meyaomiao/dsh-runner-scope>，`main` 已跟踪 `origin/main`，首版提交 `b8a381e`。

后续改动直接：

```bash
cd D:/Project/dsh/dsh-runner-scope
git add -A && git commit -m "..." && git push
```

### 4.2 打 tag（待确认）

```bash
git tag -a v0.1.0 -m "dsh-runner-scope 0.1.0"
git push origin v0.1.0
```

### 4.3 发 npm（可选，但推荐——README 的安装方式依赖它）

```bash
npm login
npm publish --access public --dry-run   # 先看打包内容
npm publish --access public
```

`files` 只包含 `lib`、`cordis.patch.yml` 与文档，不会带上 `test/`、`docs/`、`scripts/`。

### 4.4 让本机 DSH 用上它

```bash
dsh plugin --profile web add dsh-runner-scope
# 然后重启 dsh web，硬刷新浏览器
# 看板：http://127.0.0.1:3080/dsh-runner-scope
```

如果暂时不想发 npm，也可以直接挂本地目录：

```bash
dsh plugin --profile web add D:/Project/dsh/dsh-runner-scope
```

---

## 5. 与旧工具的关系

`D:/Project/dsh/gh-runner-monitor`（PowerShell + WSL Python 版）**保持原样，没有改动**。

它是这个插件的前身：RPS 模型、日志解析规则、看板交互都从这里搬过来的。区别在于：

| | `gh-runner-monitor` | `dsh-runner-scope` |
| --- | --- | --- |
| 语言 | PowerShell + Python | 纯 Node（零依赖） |
| runner 来源 | 代码里写死 `/opt/actions-runner*` | 注册表：手工导入 + 自动关联 |
| 运行方式 | 脚本 + 计划任务 | DSH 插件（工具 + web 路由）+ 独立 CLI |
| 测试 | 无 | 64 项单测 + 端到端冒烟 |

旧工具可以继续用，也可以等你确认新插件好用之后再退役。
