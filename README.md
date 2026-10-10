# dsh-restart-button · DSH 重启按钮

在 DSH 窗口标题栏「最小化」左侧加一个重启按钮。**单击先弹确认框**，确认后才**彻底关闭 DSH 并重新启动**，用于安装或更新插件之后的生效重启。图标按你给的那张图逐像素量出来的：外径 600、描边中心半径 271、描边宽 55，顶部留口（249°→273°），左上方是方头钩形箭头（横杆 27→178、竖杆下探到 201），缩放成 **12 单位方框**（1 单位 = 1 CSS px）后写成：`<circle cx="6" cy="6.06" r="5.42" stroke-dasharray="31.78 2.27" stroke-dashoffset="8.23"/>` + `<path d="M0.54 1H3.56V4.02"/>`；描边取 **1px**，与原生最小化/最大化/关闭的字形同粗。

两点踩过的坑（都是页内实测量出来的，不是推算）：`stroke-width` 在 SVG 里是**用户单位**，所以 `viewBox` 必须与 CSS px 1:1，否则 1 单位只有 0.02px，整圈等于没画；另外**那条 `A` 弧在本页的渲染器里不作数**——同样的 `d`（带空格与紧凑两种写法）只画了 307 像素的墨，而等价的圆画了 2364 像素，所以环改用「圆 + 虚线开口」，实测墨迹 2212 像素（整圈减掉 24° 缺口）且缺口正好在顶部。

```
F:\DSH\_apps\dsh-restart-button\
  package.json       bundle 清单（dsh.bundle.patch + dsh.client + 卡片图标/文案）
  cordis.patch.yml   把插件插进 profile 的 patch 行
  index.js           Host 半边：三条路由 + 重启编排 + 本地栅栏
  helper.cjs         被拉起的独立重启助手（脱离即将死掉的进程树）
  client.js          Client 半边：标题栏按钮（shell.overlay 槽）+ 确认框
  icon.svg           插件卡片图标（同一个字形）
  locale/{zh,en}.json 插件卡片标题与描述：标题 `dsh-restart-button`、介绍「一键重启」/「One-click restart」
  tools/capture-window.ps1  （可选）按 PID 抓窗口图像，用于自己复核 UI
```

## 它怎么工作

1. 按钮渲染在帧最上层 `shell.overlay` 槽里，`position:fixed; top:0`，宽度 46px = 与原生最小化/最大化/关闭同宽，高度取 `--dsh-windows-titlebar-height`（本机 40px），颜色取 `--dsw-alias-label-primary`，hover/按下用主题的交互色，光标保持系统箭头（与原生标题栏按钮一致）。
2. 横向位置是**量出来的**：Chromium 通过 Window Controls Overlay API 公布留给页面的标题栏区域，右侧剩下的就是原生三颗按钮，因此按钮右边缘正好贴在「最小化」左边缘上。平台不公布时退回常量 `138px`（3 × 46 DIP）。
3. **悬停提示**就是按钮的 `title` / `aria-label`：空闲态为「重启」，进行中显示当前阶段（“正在重启 DSH…”“DSH 正在关闭并重新启动…”“DSH 正在重启，服务恢复后本页会自动刷新…”），失败时显示失败原因。
4. **单击不直接重启**：先弹一个置顶确认框（`alertdialog`），标题「确定要重启吗？」，正文说明重启会关闭 DSH 并中断正在运行的会话，两个动作分别是「取消」与「重启」。防误触的三条路径都做了：
   - 点「取消」、按 <kbd>Esc</kbd>、或点遮罩空白处 —— 都只关对话框，不碰进程；
   - 打开时焦点落在「重启」上，回车即确认；
   - 重启已经开始（`busy`）时再点按钮不会重复弹框或重复发请求。
5. 只有确认之后才 `POST /dsh-restart/restart`（同源、回环）→ Host 把这次重启交给 `helper.cjs`，随即 `process.exit(0)`。
6. 助手按模式执行：
   - **app 模式**（桌面端，`ELECTRON_RUN_AS_NODE=1` 且父进程是桌面主进程）：先用系统接口复核父进程确实是 `DeepSeek Harness.exe` 主进程（名字匹配、命令行不含 `--type=`），再 `taskkill /F` 只杀这一个进程，等端口释放，然后重新拉起应用。
   - **host 模式**（`dsh` / `dsh web`）：等端口释放，用**完全相同的启动命令行与环境**重新拉起 Host。
   - 助手还会用 WMI 在应用进程树之外复制一份自己，并用锁文件保证只有一个助手干活，这样即使应用被整树杀掉，重启也不会半途而废。这份「守护副本」用 `conhost --headless cmd /c guardian.cmd` 拉起，包装脚本里用 `start /b` 起助手后立刻返回——所以**既不弹窗，也不会留下需要手动关闭的控制台**（见下节实测）。
7. 助手会一直等服务端口连续应答 6 秒才判定成功，并把过程写进 `<tmp>\dsh-restart-<时间戳>\helper.log` 与 `result.json`。

## 控制台窗口（实测，2026-10-10）

WMI 创建进程时没有任何窗口样式控制、又跑在本会话里，所以「谁当启动器」决定了用户看到什么。每种候选都在创建后的采样窗口里枚举可见顶层窗口（连闪一下都能抓到），同时确认包装脚本真的执行了（写 marker）：

| 启动方式（经 WMI，脱离应用进程树） | 包装脚本跑了吗 | 新出现的可见窗口 | 窗口活多久 |
| --- | --- | --- | --- |
| `cmd.exe /c …`（最初版本） | ✅ | 1 个 `PseudoConsoleWindow` | 助手整个生命周期（20 秒～2 分钟），所以得手动关 |
| `wscript.exe` + `Run(…, 0, False)` | ❌ 脚本根本没执行 | 0 | — |
| `powershell -WindowStyle Hidden` | ❌ | 1 个 | 闪一下 |
| `cmd /c` + 包装脚本 `start /b` 后立即返回 | ✅ | 1 个 | **~0 ms**（重启一开始就自己消失） |
| **`conhost --headless` + 上面那个包装脚本（现在用的）** | ✅ | **0** | 从不出现 |

复跑：`tools/launch-candidates.ps1`（候选对比）、`tools/guardian-lifetime-test.ps1`（窗口存活时长）、`tools/guardian-escape-test.ps1`（真实 helper 的逃逸链路端到端，0 窗口且 `ok: true`）。若哪天 `conhost --headless` 在旧系统上不可用，守护副本不会抢到锁，由**本来就是隐藏启动**（`CREATE_NO_WINDOW`）的主助手继续干活，最坏也只是白等 5 秒。

## 安全边界

- 只接受**本机回环**调用：远端地址必须是 127.0.0.1/::1、不能带 `Forwarded`/`X-Forwarded-For`/`X-Real-IP`、`Host` 必须是回环地址（防 DNS rebinding）。
- 带 `Origin` 时必须与 `Host` 同源；不带 `Origin` 也放行，因为桌面端自定义协议转发（`forwardWebRequest`）会按设计剥掉 `Origin`／`Cookie` 再加回 Host cookie——浏览器之外的本地调用就是这种形状。
- 杀进程之前必须先从系统读到父进程身份并核对；核对不过就退化为只重启 Host，绝不乱杀。
- `?dryRun=1` 只做全部测量与计划落盘，不杀任何进程——这是给验证和排障用的。
- 确认框只挡误触，不是安全边界：真正的栅栏在 Host 侧的同源回环校验。

## 自检 / 排障

```powershell
# 当前模式、端口、这条请求能否重启
curl.exe -s http://127.0.0.1:19387/dsh-restart/status
# 干跑一次（会打印计划目录、助手 pid，并写 result.json）
curl.exe -s -X POST "http://127.0.0.1:19387/dsh-restart/restart?dryRun=1"
$env:TEMP\dsh-restart-diagnostic.log      # 页面每次挂载上报的标题栏实测几何
```

打算装/更新插件之后重启，点一下按钮并确认即可：桌面端会整窗关闭再自动打开（冷启动约十几到几十秒），普通 `dsh web` 则只重启 Host，页面在服务恢复后自动刷新。

## 展示文案（locale/*.json）

插件列表里的名字与介绍取自 `locale/{zh,en}.json` 的 `meta.title` / `meta.description`（缺字段才回退到 `package.json` 的 name / description）。当前：标题 `dsh-restart-button`，介绍「一键重启」。

改动**需要重启 DSH 后生效**：宿主把包清单文本按进程缓存（`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 的 `PackageIdentityResolver` 是 immutable per-process cache），重装/启用停用插件都不会让旧文案立刻换掉——点一下标题栏那个重启按钮即可。

## 可调项（`:root` 上声明即可）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `--dsh-restart-caption-inset` | 平台实测值，退回 `138px` | 按钮右边缘距窗口右边的距离 |
| `--dsh-restart-caption-width` | `46px` | 按钮宽度 |
| `--dsh-restart-glyph-size` | `12px` | 图标大小 |
| `--dsh-restart-glyph-stroke` | `1px` | 图标描边粗细（原生标题栏字形同为 1px；想更厚重可写 1.2–1.5）。viewBox 与 CSS px 1:1，所以放大 `--dsh-restart-glyph-size` 会一并放大描边，此时按比例调小本值即可 |

## 改名记录（2026-10-10）

从 `dsh-reload-button` 更名为 `dsh-restart-button`，一次改到底，不留旧名：

| 面 | 旧 | 新 |
| --- | --- | --- |
| 目录 / 包名 / bundle id | `dsh-reload-button` | `dsh-restart-button` |
| Client 模块 id / locale 命名空间 | `dsh-reload-button` | `dsh-restart-button` |
| Host 路由 | `/dsh-reload/{status,restart,diagnostic}` | `/dsh-restart/{status,restart,diagnostic}` |
| CSS 类与 data 属性 | `.dshReload*` / `data-dsh-reload-button` | `.dshRestart*` / `data-dsh-restart-button` |
| CSS 变量 | `--dsh-reload-*` | `--dsh-restart-*` |
| 临时计划目录 / 诊断日志 | `dsh-reload-<时间戳>` / `dsh-reload-diagnostic.log` | `dsh-restart-<时间戳>` / `dsh-restart-diagnostic.log` |

同批改动：悬停提示由「重启 DSH」改为「重启」；点击改为先弹确认框。

## 本机验证记录（2026-10-10）

- 安装：`application: applied`，`shell.overlay` 槽里多出 `dsh-restart-button`（order 30，active）。
- 路由：`GET /status` → `mode: app`；`GET /restart` → 405；带外域 `Origin` 的 POST → 403；无 `Origin` 与同源 `Origin` 的 POST（dryRun）→ 200。
- 干跑：计划里记下了完整启动命令行（`--expose-internals .../dsh-desktop-host/lib/index.js <runtimeDir> <profileDir> <primaryRuntime> <pnpm.mjs> <runtimeBin>`，cwd = profile 目录），助手从系统读到的父进程身份判定为 `kill`（`DeepSeek Harness.exe` 主进程，command line 无 `--type=`）。
- 页面实测：按钮 `46×40`，右边缘贴在原生「最小化」左边缘上，`display:flex`、`visibility:visible`；图标 `12×12`、`stroke-width: 1px`。
- **图标是否真的画出来**由页内自检报告（把图标交给浏览器自己的 SVG 光栅器，数被涂到的像素）：`glyphInk: 2531`、环上 300° 处 alpha `255`、缺口 261° 处 alpha `0`。
- **未验证**：标题栏那一行的像素级外观——抓图时 DSH 窗口被浏览器盖住，其合成帧里标题栏条带返回的是旧内容，所以像素级复核不可用；几何与描边是页面内实测 + 平台 API 交叉确认的。
