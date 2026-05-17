# RAH Scrollbar UI 协议

本文定义 RAH 前端滚动条规格。目标是避免不同页面各自调粗细、边距和显隐策略，尤其避免弹窗、历史列表、Council、Session Chat、Inspector、Terminal 等区域出现滚动条挤占内容、宽度抖动或风格漂移。

## 1. 核心原则

- 滚动条样式按区域语义分配，不按单个页面临时决定。
- 新代码不要直接使用 `custom-scrollbar`；它只作为旧代码兼容别名。
- 默认滚动条不应挤占正文布局宽度；只有确实需要固定 gutter 的地方才显式加 `scrollbar-stable`。
- 主阅读区可以稍明显，控制面板和弹窗应更轻、更窄，代码/终端类区域需要稳定识别横向滚动。

## 2. 语义类

### `rah-scroll-panel` / `rah-scroll-panel-y`

用途：UI 面板、弹窗、选择器、列表、侧边栏。

适用区域：

- Session History / Council History 选择列表
- Settings、Info、Sheet
- WorkspacePicker、FileReferencePicker
- Inspector 内容区与 Files / Changes 列表
- Session control / model / permission 弹出菜单
- Council agents 侧栏、New Room / Add Agents 弹窗

视觉规则：

- `rah-scroll-panel` 只定义视觉规格。
- `rah-scroll-panel-y` 只用于纵向滚动面板，会强制 `overflow-y: scroll`，确保内容是否溢出都预留同一块滚动槽位。
- 使用 `scrollbar-gutter: stable` 预留滚动条空间。
- WebKit 目标宽度约 `5px`，默认透明，hover 时轻量显示。
- 用于避免弹窗内容从“不溢出”变成“溢出”时，滚动条突然占位并挤压卡片宽度。
- 面板滚动条可以出现，但不能造成 New Room / Add Agents 这类动态配置弹窗左右抖动。

### `rah-scroll-main`

用途：主要阅读区。

适用区域：

- Session Chat feed
- Council Chat feed

视觉规则：

- 明显宽于 panel，WebKit 目标宽度约 `8px`，仍然默认透明。
- hover 后更容易看到当前位置。
- 可以配合 `scrollbar-stable`，避免长聊天滚动时布局横向跳动。

### `rah-scroll-code`

用途：代码、diff、artifact、终端 tab 这类技术内容。

适用区域：

- Markdown code block / JSON / tool input
- Inspector file preview / diff preview
- Activity artifact table
- Workspace terminal tab strip
- Council terminal tab strip

视觉规则：

- thumb 默认可见但保持低对比，WebKit 目标宽度约 `6px`，便于发现横向滚动。
- 横向滚动区域优先使用这个类。

## 3. `scrollbar-stable` 使用边界

`scrollbar-stable` 只表达布局需求，不表达视觉样式。

允许使用：

- 主聊天区需要避免长内容出现/消失滚动条时横向抖动。
- 代码/diff 预览区域需要固定可读宽度。
- Inspector 顶部 tab 条如果横向滚动会造成选项宽度跳变。

不应使用：

- 普通弹窗 body。
- picker / menu。
- Council New Room / Add Agents 这类高度随内容变化的配置弹窗。

## 4. 规格分配

| 区域 | 语义类 | 原因 |
|---|---|---|
| Session Chat | `rah-scroll-main` | 用户长时间阅读的主内容区 |
| Council Chat | `rah-scroll-main` | 与 Session Chat 同级的主内容区 |
| Session History | `rah-scroll-panel` | 选择列表，不应抢视觉焦点，也不能因滚动条出现挤压行宽 |
| Council History / Rooms | `rah-scroll-panel` | 选择列表，与 Session History 保持一致 |
| Settings / Info / Sheet | `rah-scroll-panel` | 弹窗面板 |
| New Room / Add Agents | `rah-scroll-panel` | 配置面板，避免滚动条挤占 agent 卡片 |
| Inspector Files / Changes | `rah-scroll-panel` | 右侧面板内容 |
| Code / Diff / Artifact | `rah-scroll-code` | 技术内容，需要可发现横向滚动 |
| Terminal tab strip | `rah-scroll-code` | 技术容器，常有横向 tab 溢出 |

## 5. 维护规则

- 新增滚动容器时必须选择 `rah-scroll-panel`、`rah-scroll-main`、`rah-scroll-code` 之一。
- 纵向面板容器必须使用 `rah-scroll-panel rah-scroll-panel-y`，而不是只写 `rah-scroll-panel`。
- 横向面板容器只使用 `rah-scroll-panel`，不要加 `rah-scroll-panel-y`。
- Firefox 只支持 `scrollbar-width: auto | thin | none`，不支持 WebKit/Chromium 那种按像素区分 `5px/8px`。因此 Firefox 下不同语义类主要通过颜色深浅区分，精确粗细差异只在 WebKit/Chromium 可见。
- 不要在组件内手写 `::-webkit-scrollbar`。
- 不要为单个业务组件复制一套滚动条样式。
- 面板类弹窗如果内容动态变多，应优先使用 `rah-scroll-panel`，通过稳定 gutter 提前预留宽度；不要用临时 `pr-*` 或局部 scrollbar hack 规避抖动。
- 如果某个新区域无法归入这三类，先更新本文，再改 CSS。
- `custom-scrollbar` 保留为兼容别名，但新增代码不使用。

## 6. 检查命令

修改滚动容器后可用下面命令检查是否还有未归类的滚动区域：

```bash
rg -n "overflow-(x|y)?-(auto|scroll)|overflow-auto|overflow-y-auto|overflow-y-scroll|overflow-x-auto" \
  packages/client-web/src --glob '!**/dist/**' \
  | rg -v "rah-scroll-|custom-scrollbar|terminal-desktop-shortcut|terminal-ios-shortcut"
```

理想结果是没有输出；如有输出，需要判断是否应补上语义类。
