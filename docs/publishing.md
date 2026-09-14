# 发布清单（待确认）

> **状态：一切就绪，尚未发布任何东西。**
> 没有任何 `git push`、没有 `npm publish`、没有创建 GitHub 远端、没有改动你现有的 DSH profile。

---

## 1. 需要你拍板的事

| # | 事项 | 当前取值 | 改起来要动哪 |
| --- | --- | --- | --- |
| 1 | 仓库名 / npm 包名 | `dsh-runner-scope` | `package.json` 的 `name`、`cordis.patch.yml` 的 `name`、README 徽章与链接 |
| 2 | GitHub 归属 | `meyaomiao`（与你其它插件一致） | `package.json` 的 `repository` / `homepage` / `bugs`、README 里的 clone 地址 |
| 3 | 可见性 | 公开 | GitHub 建仓时的选项 |
| 4 | 首次版本号 | `0.1.0` | `package.json` 的 `version` |
| 5 | 是否现在就发 npm | 否 | 见下方第 4 步 |
| 6 | `docs/screenshots/dashboard.png` | **已脱敏** | 见下方说明 |

第 6 条说明：README 里的截图原本取自本机真实数据，包含主机名、Windows 用户名、runner 名与仓库名。**已替换为脱敏版本**：用同一份真实数据（106 个任务、同一张曲线）做了字符串替换后重新渲染，图中显示为 `ci-host` / `C:\Users\ci\…` / `wsl-runner-1` / `wsl-runner-2` / `github.com/acme/ci-demo`。曲线形状与数值完全真实，只有标识符是化名。

如果你更想用真实标识符，把截图换回去再 `git commit --amend` 即可（未推送前不会进历史）。

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

- [ ] 看完 `README.md`，确认描述与你的预期一致
- [ ] 决定第 1 节里的 6 项
- [ ] 决定截图是否脱敏
- [ ] `git log` 里没有你不希望公开的邮箱 / 路径
- [ ] `package.json` 的 `repository.url` 与真实远端一致

---

## 4. 发布步骤（确认后再执行）

### 4.1 建仓并推首版

```bash
cd D:/Project/dsh/dsh-runner-scope
git add -A
git commit -m "feat: dsh-runner-scope 0.1.0 — self-hosted runner observability"

# 在 GitHub 上建好空仓 meyaomiao/dsh-runner-scope（不要勾 README/license）
git remote add origin https://github.com/meyaomiao/dsh-runner-scope.git
git push -u origin main
```

### 4.2 打 tag

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
