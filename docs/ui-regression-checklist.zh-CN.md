# RAH UI 回归清单（真机 / 真实视口）

这份清单用于在前端布局、弹层、Inspector、Terminal、History、Composer 等高风险区域改动后，做一轮可重复的 UI 回归。

目标不是“把所有功能重测一遍”，而是优先抓：

- 移动端 safe-area / 键盘遮挡
- iPad / split view 响应式断层
- 底部浮层与 composer 的相互遮挡
- workspace / session / inspector 边界回归
- terminal 和大 diff 的真实交互问题

## 一、自动化预检查

先跑这几条，再做手点：

```bash
npm run typecheck
npm run test:web
npm run build:web
npm run test:p0:browser
npm run test:smoke:terminal-browser
npm run test:smoke:inspector-browser
npm run test:smoke:history-resume
```

通过标准：

- `typecheck` 全绿
- `test:web` 全绿
- `build:web` 成功
- P0 工作区/PWA gate 与 3 条专项 browser smoke 全部通过

如果这里不过，不要进入真机回归，先修自动化失败。

## 二、设备矩阵

至少覆盖这 4 档：

1. iPhone Safari 竖屏
   推荐等价视口：`390 x 844`
2. iPad 11" portrait
   推荐等价视口：`834 x 1194`
3. iPad split view / 窄平板
   推荐等价视口：`694 x 1112`
4. Desktop
   推荐等价视口：`1440+`

## 三、主工作台

### 1. Sidebar / Inspector

检查：

- 左侧 sidebar 能正常展开、折叠
- 触摸拖拽 sidebar 宽度时可用，不会只对鼠标生效
- Desktop rail 与 standalone PWA Sheet 都声明 `data-sidebar-protocol="codex-compact-v1"`；两边计算样式必须同时为：40px header、4px New task 顶距、8px 双侧内容 inset、30px workspace/session 行、10px 圆角、2px 同组间距、6px workspace 组间距、28px action 槽
- RAH / 一级导航 / 分组 / workspace / session 分别为 `16/20/600`、`15/20/500`、`13/18/550`、`14/20/500`、`14/20/450`；workspace/session 标题中心与行中心偏差为 0
- PWA workspace/session 滚动区不得因 scrollbar gutter 比一级导航额外缩窄右边距；Desktop/PWA 的字体、图标、行高、圆角和间距不能由 `md:` 或 coarse-pointer media query 各自覆盖
- 右上角 Inspector 按钮始终存在
- 选中 `workspace` 时不会自动弹出 inspector
- inspector 的开合只由右上角按钮控制
- 选中 `workspace` 后手动打开 inspector，会显示该 workspace 的 `Files / Changes`
- 选中 `session` 后 inspector 正常显示 `Files / Changes / Events`
- iPad portrait / split 下，Inspector tab 不应换行、错位、撑高
- Session `... -> Info` 同时显示 Runtime provider、Model provider 与 Model；OpenCode 的 DeepSeek/Kimi
  等第三方模型不能只显示成 OpenCode
- session 标题栏 provider 图标和 Council 标题栏 Council 图标都应有一致的 pill/card 外壳；小型 badge/button 内可使用 bare 图标，但不能在标题栏裸放 SVG。
- 左侧 sidebar 的 Council bare 图标应为黑色 glyph，尺寸接近同组功能按钮；非 sidebar 位置的 Council 图标应维持橙色 glyph，并与同位置 provider 图标同规格。不要为黑色状态引入单独图片资产。

失败信号：

- 触摸拖拽无效
- Desktop 与 PWA 的同一侧栏元素出现不同的计算行高、字体或左右 inset
- session/workspace 标题贴近 pill 上沿，或右侧 hover surface 贴住 divider / 被 scrollbar gutter 挤窄
- tab 条第二行换行
- 点击 workspace 导致 inspector 自己收起或自己弹出

### 2. Workspace / Session 边界

检查：

- 从 0 个 workspace 的空列表打开真实 picker，添加后只出现一行，刷新后仍存在
- 同时注册父、子 workspace 时，嵌套 session 只出现在最具体的已注册目录下
- 点击工作区行的新建按钮，New task composer 必须选择这一行对应的精确目录
- 移除父 workspace 后，其 session 同步消失，已单独注册的子 workspace 和 session 不受影响
- 移除最后一个 workspace 后，无需刷新即可看到空列表；此时仍能添加新 workspace
- 刷新、切换焦点、重选 session 前后，workspace/session 的数量、顺序和归属保持一致
- `Files` 始终按当前 workspace 范围显示
- `Changes` 只有在 `workspace <= git 项目` 时显示
- `workspace` 位于 git 项目上层、只是包含某个 git 子目录时，`Changes` 为空
- `session` 选中时的 `Changes` 与纯 `workspace` 选中时语义一致

失败信号：

- session 选中后偷偷显示超出 workspace 范围的 git changes
- workspace 高于 git 根时仍显示 nested repo changes
- 添加/移除操作只有刷新后才收敛
- 空列表无法恢复、出现重复 workspace，或 session 留在已移除工作区下
- 工作区新建按钮打开了 composer，但目录仍是旧选择

## 四、移动端弹层

这些弹层在手机上都需要检查：

- `Session History`
- `Settings`
- `WorkspacePicker`
- `FileReferencePicker`
- `Terminal`
- 左 / 右 `Sheet`

检查：

- 顶部不被刘海/状态栏顶住
- 底部不被 home indicator 顶住
- 键盘弹出后，搜索框和底部操作区仍可见
- 手机上应使用一致的全屏弹层策略，而不是有的全屏、有的桌面居中
- iPad split 下仍然可操作，不会出现内容被裁掉

失败信号：

- 标题顶到状态栏
- 底部按钮落在 home indicator 下面
- 键盘弹出后搜索框或确认按钮被遮挡

## 五、Composer / Chat

### 1. iOS PWA workspace 与阅读密度

在 `390 x 844` 级竖屏、以 standalone PWA 打开的页面中检查：

- Home New task 的 workspace selector 位于 composer 外部的独立灰色上下文行，保留 Folder 图标和可读名称
- 名称超过 18 个字符时向左跑马，短名称保持静止且不能出现重复文本轨道
- workspace 上下文行不挤占 agent 配置；390px 下仍复用单行响应式 toolbar rail，权限/Plan 压缩为图标、模型紧贴主动作，页面不存在横向滚动
- Session/Council 对话正文读取 12–20px Appearance 设置；默认 14px/22px，代码随正文在 11–16px 有界联动，且菜单、Sidebar、标题字号不随之改变
- 用户气泡最大宽度为内容区 75%，不重新膨胀到 85%
- 用户消息后的触屏 Copy 动作不占据空白行；消息到 `Working / Worked` 的普通 turn gap 为 12px
- assistant commentary 是白底连续正文，不出现整块浅灰圆角气泡；最终回答仍与 Worked 区域保持明确分隔
- Desktop 对照仍保持同一所选对话字号与原有 Copy action；Desktop/PWA 只允许布局密度不同，不再给 PWA 额外放大正文

失败信号：

- 字号很小但每屏内容没有增加，或一轮消息之间出现约一个按钮高度的空白
- workspace 回到 composer 内挤压 agent 配置、短名称重复滚动、或造成横向溢出
- commentary 重新出现大块浅灰背景和上下 padding
- 为追求“更密”把正文压到 14px 以下、让字号设置改变 UI 菜单，或把气泡放宽到接近整行

### 2. Composer 对齐

检查：

- 已打开 session 的 composer 中：
  - 输入框
  - `+`
  - `send`
  - `stop`
  单行时底边对齐
- 输入增多时，输入框只向上长高
- `+ / send / stop` 不会跟着输入框一起上下漂
- 输入框上限足够高，不会过早内部滚动
- 同一 Session 在普通 Chat 与 Canvas pane 间切换时，未发送文本、附件和注释保持同一份；不同
  Session 之间仍严格隔离

失败信号：

- 输入框比按钮略高/略低
- 多行后按钮被带着上移

### 3. IME / 输入法

检查：

- 中文输入法组合态下按 `Enter` 不会直接发送消息
- 中文、英文、数字、常见符号都能正常输入
- iOS 第三方输入法不应只能输入中文而不能输入英文/数字/符号

失败信号：

- IME `Enter` 误发消息
- 某类字符完全打不进去

### 4. 底部浮层

检查：

- thinking 时 `scroll-to-bottom` 按钮位置稳定
- 最新 assistant 最终回复的起点滚出当前 chat 可视区超过 4px 时，应显示 `Read latest reply`；点击后应精确跳到该回复内容顶部、退出 bottom-follow，并在起点重新可见后隐藏
- 最终回复本体即使能装进视口，只要其后的 Changed Files、visual outputs 或复制动作使回复起点滚出视口，也必须显示 `Read latest reply`
- 用户在一条长 assistant 回复后发出新问题、且新 assistant 回复尚未出现时，不应显示 `Read latest reply`
- 如果最新 assistant 回复较短，即使上一条回复很长，也只能导航到这条最新短回复，不能跳回上一轮
- Canvas pane、pane 最大化、普通 session/council 页面都应按各自 chat 滚动区高度触发，而不是按浏览器整窗高度触发
- Desktop 与 390×844 PWA 点击蓝点 Session 必须落在产生蓝点的最新未读 final 顶部；模拟 `turn.completed` 先到、final projection 慢到时，等待期间只能显示最新尾部，不能跳到旧 final、旧 history page 顶部或回复末尾
- 蓝点定位完成后，第一次轻微 touch/pointer/wheel 手势立即取得 viewport 所有权；手指刚移动时不得再次对齐、抖动或被 ResizeObserver 拉回，Chat/TUI 重挂载也不得重复执行已消费的蓝点导航
- 打开包含超长 assistant row 与多张 lazy image 的 stopped Session，默认仍在最新；连续向上滚动两次后，
  图片进入视口并完成布局时，滚动前位于视口顶部附近的正文必须保持同一像素位置
- `GlobalWorkbenchCallout` 不和 `scroll-to-bottom` 重叠
- 多行 composer、高 safe-area、error callout 同时出现时，底部元素仍然分层清楚

失败信号：

- 两个浮层重叠
- thinking 时浮层上下跳
- `Read latest reply` 在回复起点仍可见时频繁出现，或在回复起点已精确对齐后仍不消失
- 蓝点 Session 偶发落在未读回复末尾/旧历史位置，或首次手势触发第二次程序化定位
- 只在图片丰富的大 Session 上，第二次滚轮后正文突然上下跳动

### 5. Turn Review

- 点 Changed Files 的 `审查` 与任一文件行都打开同一个 Review；点文件时该文件立即选中
- Desktop、PWA、Canvas 都不得因 turn 文件点击而打开右侧 Inspector
- 390×844 下文件列表默认折叠为 Review 顶部选择条，可展开、筛选、切换并再次折叠

## 六、History

检查：

- 手机上 `Session History` 全屏打开
- 列表和搜索可滚动
- recent / all 切换正常
- claim history -> live 升级路径正常
- 长历史打开后仍锚到底部
- 向上加载更旧历史不会把当前位置跳乱
- Canvas 中 running 与 stopped/history Session 都能从左侧标题行拖入任意 pane；drop 后 pane 绑定正确
  provider session，源 Session 不从 Sidebar 消失

失败信号：

- 手机历史弹窗偏移出屏幕
- 长历史打开后不在底部
- stopped Session 显示为不可拖动，或只有按到标题空白区的少数拖动能成功

## 七、Inspector 详情

检查：

- `Changes` 大 diff 不会卡死
- `Load more` 可继续展开
- `Diff / File` 切换正常
- 从 Chat 回复点击图片或本地文件链接时，首次打开必须出现可见 preview/loading dialog，不能是一片空白。
- 大图本地/LAN 打开应显示原图；远程/Tailscale/公网打开应显示 bounded preview，而不是 “too large or unavailable”。
- HTML 文件默认显示静态 `Preview`，内联 CSS / SVG 正常；切换 `Source` 后仍能查看和复制源码。预览不得执行文件脚本、请求外链资源或导航 RAH 主页面；超过读取上限的 HTML 只能显示 source prefix。
- `rename / binary / staged+unstaged` 都能正常显示
- 窄屏 inspector 中 tab 条不乱

失败信号：

- 打开 diff 几秒后页面卡住
- tab 文字换行
- binary / rename 语义丢失

## 八、Terminal

检查：

- terminal 能打开、关闭、新建、重开
- 桌面端输入可用
- 手机端输入桥可用
- iPhone / iPad 上输入不会被弹层 safe-area 挤坏
- 标签页切换/关闭正常

失败信号：

- terminal 头部被刘海挡住
- 手机端输入区域被键盘或底部安全区挡住

## 九、Settings

检查：

- 手机上 `Settings` 为全屏弹层
- `Appearance / Chat / Version / About` 都可达
- `Version` 首次进入会自动加载
- 长版本号会换行，不从右边溢出
- `Hide completed tool calls` 开关立即生效

失败信号：

- `Version` 页面闪烁
- 长版本号溢出
- Chat 开关切了但当前页面不生效

## 十、桌面大屏

检查：

- `OpeningPane` 在大屏上不应过小
- inspector 在大屏上不应仍死锁 320px
- 大屏下没有巨量空白导致信息密度过低

失败信号：

- loading 卡片像一张很小的纸片漂在中间
- inspector 仍过窄导致 diff/file tree 拥挤

## 十一、回归记录建议

建议每次回归记录：

- 日期
- 分支 / commit
- 设备 / 浏览器
- 失败项
- 复现步骤
- 截图 / 录屏链接

最少记录模板：

```text
日期：
分支/提交：
设备：
浏览器：
失败项：
复现步骤：
备注：
```

## 十二、结论标准

可以认为“这轮 UI 改动可放行”的最低条件：

- 自动化预检查全绿
- iPhone Safari 竖屏手点通过
- iPad portrait 或 split 至少一档手点通过
- Desktop 手点通过
- 没有出现：
  - safe-area 遮挡
  - keyboard 遮挡
  - inspector / sidebar 断裂
  - diff / terminal 明显不可用
