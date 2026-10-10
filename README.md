# dsh-restart-button

在 DSH 窗口标题栏加一颗重启按钮：**先确认，再彻底重启 DSH**——用于安装或更新插件之后的生效重启。

*A restart caption button for the DeepSeek Harness window. It asks first, then closes DSH completely and starts it again, so a freshly installed or updated plugin takes effect. Unofficial dsh plugin; not affiliated with DeepSeek.*

---

## 它是什么

装插件之后常常需要「关掉再打开」才能生效，而 DSH 没有为这件事提供入口。这个插件在标题栏最右侧那组原生按钮（最小化 / 最大化 / 关闭）的左边补上一颗，尺寸、颜色、hover 与按下反馈都对齐原生按钮，看起来本来就该在那儿。

点击**不会**立刻重启：先弹一个确认框，确认后才动手。

| | |
| --- | --- |
| 悬停提示 | `重启` |
| 单击 | 弹出确认框：**确定要重启吗？** / 取消 · 重启 |
| 确认后 | 桌面端：整窗关闭并自动重新打开；`dsh web`：只重启 Host，页面在服务恢复后自动刷新 |
| 进行中 | 图标旋转，提示文字切换为当前阶段；失败时显示失败原因，5 秒后自行复位 |

防误触不是靠一句「你确定吗」：

- 点「取消」、按 <kbd>Esc</kbd>、点遮罩空白处 —— 三条路都只关对话框，不碰进程；
- 打开时焦点落在「重启」上，回车即确认；
- 重启已经开始后再点按钮，不会重复弹框、也不会重复发请求。

## 环境要求

- DSH 桌面端（Windows）或 CLI 的 `dsh web`。
- **整窗重启**（app 模式）要求桌面端 + Windows；`dsh web` / 非 Windows 上是 **Host 重启**（host 模式），页面刷新后即生效。
- 运行期不需要额外依赖：插件本体跑在 Host 进程里，重启助手用 Host 自己的 `process.execPath` 拉起。

## 安装

仓库公开，**按地址直接装**即可：包是纯 JS，没有构建步骤，也不需要先克隆。

把下面任意一种写法填进 DSH 的插件安装入口：

| 写法 | 内容 |
| --- | --- |
| 仓库地址 | `https://github.com/Paniauhs/dsh-restart-button` |
| git 简写 | `github:Paniauhs/dsh-restart-button` |
| 分支 tarball | `https://codeload.github.com/Paniauhs/dsh-restart-button/tar.gz/refs/heads/main` |
| 固定版本 | `github:Paniauhs/dsh-restart-button#v1.0.0` |

桌面端在**设置 → 插件**的安装框里贴地址；命令行是 `dsh plugin add <地址>`。这几种写法都在本机用 dsh 自带的 pnpm 11.7 实装验证过，装出来的正好是运行期需要的 8 个文件（`package.json` 的 `files` 字段把 `tools/` 之类挡在外面）。

想改代码就改用克隆 + 本地目录安装——开发时用这种，改完立即生效：

```sh
git clone https://github.com/Paniauhs/dsh-restart-button
```

装好后 profile 的 bundle 层里会多出一行 `dsh-restart-button`，`shell.overlay` 槽里出现占用者 `dsh-restart-button`（order 30）。按钮**只在窗口标题栏由页面绘制时才出现**（Windows 桌面端）；浏览器里直接开 `dsh web` 的页面没有原生标题栏，插件正常加载但不画按钮。

> 装的那一刻宿主若已经在跑同一个模块，界面会提示要重启一次才生效——点标题栏那颗按钮就是最快的办法。
>
> 另外，在同一个 profile 里连续安装 / 卸载多个插件时，宿主有几率把**别的** bundle 从组合层里移出（实测遇到过）。装完顺手看一眼插件列表，少了哪个就把它重新启用一次。

## 工作原理

```
窗口标题栏
└─ Client（client.js，shell.overlay 槽）
     └─ 单击 → 确认框 → POST /dsh-restart/restart
          └─ Host（index.js）
               └─ 生成计划 + 独立助手 helper.cjs，随即 process.exit(0)
                    └─ 助手：复核父进程 → 结束它 → 等端口释放 → 重新拉起 → 验证服务恢复
```

### 三条路由

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-restart/status` | 当前 `mode`、端口、是否已在重启，以及**这一条请求**能否通过本地栅栏 |
| `POST /dsh-restart/restart` | 交棒给助手并让当前 Host 退出；`?dryRun=1` 只做测量与计划落盘，不杀任何进程 |
| `POST /dsh-restart/diagnostic` | 页面每次挂载上报标题栏实测几何，追加一行到 `<tmp>\dsh-restart-diagnostic.log`；不含任何会话数据 |

### 两种重启

- **app 模式**（桌面端）：Host 由 Electron 主进程以 `ELECTRON_RUN_AS_NODE=1` 拉起，所以 `process.execPath` 就是应用本身、`process.ppid` 就是主进程。助手先向系统复核这个 pid 确实是应用主进程（进程名匹配、命令行不含 `--type=`，排除渲染进程或浏览器），确认后只 `taskkill /F` 它一个，等端口释放再重新拉起应用——这才是「整窗关闭再打开」。
- **host 模式**（`dsh` / `dsh web`）：用**与当前进程完全相同的命令行与环境**重新拉起 Host（`process.argv` 原样重放，调试器参数剔除，否则新进程绑不上同一个调试端口）。

复核不通过时助手绝不乱杀，退化为只重启 Host；两种计划都建不出来时返回 503。

### 助手为什么要绕 WMI

助手自己也在这棵即将被杀掉的进程树里。要让它在整树被杀之后仍然活着，必须换一个父进程——WMI 的 `Win32_Process.Create` 正好提供这一点，它把新进程挂到 WMI provider host 上。

麻烦在于 WMI 创建进程时**没有任何窗口样式控制**，又跑在当前会话里，于是「拿什么当启动器」直接决定了用户会不会看到一个控制台窗口。逐个候选实测（每种都枚举创建后新出现的可见顶层窗口，连闪一下也算）：

| 启动方式（经 WMI，脱离应用进程树） | 包装脚本跑了吗 | 新出现的可见窗口 | 窗口活多久 |
| --- | --- | --- | --- |
| `cmd.exe /c …` | ✅ | 1 个 `PseudoConsoleWindow` | 助手整个生命周期（20 秒～2 分钟），得手动关 |
| `wscript.exe` + `Run(…, 0, False)` | ❌ 脚本根本没执行 | 0 | — |
| `powershell -WindowStyle Hidden` | ❌ | 1 个 | 闪一下 |
| `cmd /c` + 包装脚本 `start /b` 后立即返回 | ✅ | 1 个 | ~0 ms，重启一开始就消失 |
| **`conhost --headless` + 上面那个包装脚本** | ✅ | **0** | 从不出现 |

所以现在用的是最后一行：写一个几行的 `guardian.cmd`（`start /b` 起助手后立刻返回，不把控制台的所有者拖住），再用 `conhost --headless` 无头地跑它。锁文件保证两个副本里只有一个真正干活；若某个系统上 `--headless` 不可用，守护副本抢不到锁自动作罢，由**本来就是隐藏启动**（`CREATE_NO_WINDOW`）的主助手继续完成重启，最坏只是白等 5 秒。

### 判定成功

重启不该只看「进程起来了」——启动失败也会短暂占住端口。助手要求服务端口**连续应答 6 秒**才写 `ok: true`，全过程连同每一步的耗时写进 `<tmp>\dsh-restart-<时间戳>\helper.log` 与 `result.json`。

## 安全边界

重启是**杀进程**级别的操作，所以栅栏在 Host 侧，不在按钮上：

- 只接受**本机回环**调用：对端地址必须是 `127.0.0.1` / `::1`，不能带 `Forwarded` / `X-Forwarded-For` / `X-Real-IP`，`Host` 必须是回环地址（挡住 DNS rebinding）。
- 带 `Origin` 时必须与 `Host` 同源；不带 `Origin` 也放行——桌面端自定义协议转发（`forwardWebRequest`）会按设计剥掉 `Origin` / `Cookie` 再加回 Host cookie，浏览器之外的本地调用正是这个形状。
- 结束进程前必须先从系统读到对方身份并核对，核对不过就退化，绝不乱杀。
- 确认框只挡误触，**不是**安全边界。

## 可调项

在 `:root` 上声明即可：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `--dsh-restart-caption-inset` | 平台实测值，退回 `138px` | 按钮右边缘距窗口右边的距离 |
| `--dsh-restart-caption-width` | `46px` | 按钮宽度 |
| `--dsh-restart-glyph-size` | `12px` | 图标大小 |
| `--dsh-restart-glyph-stroke` | `1px` | 图标描边粗细（原生标题栏字形同为 1px；想更厚重可写 1.2–1.5）。viewBox 与 CSS px 1:1，所以放大 `--dsh-restart-glyph-size` 会一并放大描边，此时按比例调小本值即可 |

按钮横向位置是**量出来的**，不是猜的：Chromium 通过 Window Controls Overlay API 公布留给页面的标题栏区域，右边剩下的就是原生那三颗按钮，于是按钮右边缘正好贴在「最小化」左边缘上。平台不公布时退回常量 `138px`（3 × 46 DIP）。

## 自检与排障

（下面用 `19387` 作例子；端口以你实际运行的那个为准。）

```powershell
# 当前模式、端口、这一条请求能否重启
curl.exe -s http://127.0.0.1:19387/dsh-restart/status

# 干跑：打印计划目录与助手 pid，并写 result.json；不杀任何进程
curl.exe -s -X POST "http://127.0.0.1:19387/dsh-restart/restart?dryRun=1"

# 页面每次挂载上报的标题栏实测几何
type %TEMP%\dsh-restart-diagnostic.log
```

常见失败分支：`mode: null` → 当前宿主无法自我重启（返回 503）；`restartReachable: false` → 请求没走本机回环或带了转发头（返回 403）；`409` → 已经有一次重启在排队。

工具脚本（都需要在 DSH 所在机器上跑）：

```powershell
powershell -File tools/launch-candidates.ps1        # 对比各启动方式会不会带出窗口
powershell -File tools/guardian-lifetime-test.ps1   # 量控制台窗口的存活时长
powershell -File tools/guardian-escape-test.ps1     # 真实助手的逃逸链路端到端（不碰应用）
powershell -File tools/capture-window.ps1           # 按 PID 抓窗口图像，复核像素级外观
```

## 目录结构

```
package.json       bundle 清单：dsh.bundle.patch + dsh.client + 卡片图标/文案
cordis.patch.yml   把插件插进 profile 的 patch 行
index.js           Host 半边：三条路由 + 重启编排 + 本地栅栏
helper.cjs         脱离即将死掉的进程树的独立重启助手
client.js          Client 半边：标题栏按钮（shell.overlay 槽）+ 确认框 + 页内字形自检
icon.svg           插件卡片图标（与按钮同一个字形）
locale/{zh,en}.json 插件卡片标题与描述
tools/             测窗口几何、启动候选、逃逸链路与窗口存活期的脚本
```

## 实现细节

**字形。** 一圈缺口环 + 左上方一个方头钩形箭头：`<circle cx="6" cy="6.06" r="5.42" stroke-dasharray="31.78 2.27" stroke-dashoffset="8.23"/>` 配 `<path d="M0.54 1H3.56V4.02"/>`，画在 12 单位的方框里。两条约束是量出来的：

- `stroke-width` 在 SVG 里是**用户单位**，所以 `viewBox` 必须与 CSS px 1:1——否则 1 单位只有 0.02px，整圈等于没画。周长为 `2π×5.42 = 34.05`，虚线覆盖 31.78（336°），偏移 8.23 把这段虚线从 273° 起排，正好在顶部留出 24° 的缺口。
- 开口环用「圆 + 虚线」而不是一条 `A` 弧：在本页的渲染器里，等价的弧路径只画出 307 像素墨迹，而圆画出 2364——弧的写法在这里不可靠。缺口位置也因此可控。
- 描边取 **1px**，与原生最小化/最大化/关闭的字形同粗。

按钮宽度 46px、高度取 `--dsh-windows-titlebar-height`，正是为了与原生按钮逐像素对齐。页面挂载时会把实际量到的几何连同字形光栅化后的墨迹像素数、环上 300° 与缺口 261° 两点的 alpha 一起上报到诊断日志——所以「图标是不是真的画出来了」是可查的，不靠眼睛。

**插件卡片文案**（`locale/{zh,en}.json` 的 `meta.title` / `meta.description`，缺字段才回退到 `package.json`）由宿主按进程缓存，重装或启停插件都不会让旧文案立刻换掉。改完文案点一下这颗重启按钮即可。

## 已知限制

- 按钮只在**页面绘制的标题栏**上出现（Windows 桌面端）。浏览器直开 `dsh web` 页面时插件会加载，但没有原生标题栏，因此不画按钮——此时请用命令行重启。
- 整窗重启会**中断正在运行的会话**；`dsh web` 的 Host 重启同样会断开当前页面。确认框里写明了这一点。
- 以管理员身份运行的窗口（例如提权后的宿主）拒绝被普通权限的 `taskkill` 结束；这种情况助手会失败并如实写进 `helper.log`。
