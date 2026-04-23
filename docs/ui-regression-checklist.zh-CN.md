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
npm run test:smoke:terminal-browser
npm run test:smoke:inspector-browser
npm run test:smoke:history-long-browser
```

通过标准：

- `typecheck` 全绿
- `test:web` 全绿
- `build:web` 成功
- 3 条 browser smoke 全部通过

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
- 右上角 Inspector 按钮始终存在
- 选中 `workspace` 时不会自动弹出 inspector
- inspector 的开合只由右上角按钮控制
- 选中 `workspace` 后手动打开 inspector，会显示该 workspace 的 `Files / Changes`
- 选中 `session` 后 inspector 正常显示 `Files / Changes / Events`
- iPad portrait / split 下，Inspector tab 不应换行、错位、撑高

失败信号：

- 触摸拖拽无效
- tab 条第二行换行
- 点击 workspace 导致 inspector 自己收起或自己弹出

### 2. Workspace / Session 边界

检查：

- `Files` 始终按当前 workspace 范围显示
- `Changes` 只有在 `workspace <= git 项目` 时显示
- `workspace` 位于 git 项目上层、只是包含某个 git 子目录时，`Changes` 为空
- `session` 选中时的 `Changes` 与纯 `workspace` 选中时语义一致

失败信号：

- session 选中后偷偷显示超出 workspace 范围的 git changes
- workspace 高于 git 根时仍显示 nested repo changes

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

### 1. Composer 对齐

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

失败信号：

- 输入框比按钮略高/略低
- 多行后按钮被带着上移

### 2. IME / 输入法

检查：

- 中文输入法组合态下按 `Enter` 不会直接发送消息
- 中文、英文、数字、常见符号都能正常输入
- iOS 第三方输入法不应只能输入中文而不能输入英文/数字/符号

失败信号：

- IME `Enter` 误发消息
- 某类字符完全打不进去

### 3. 底部浮层

检查：

- thinking 时 `scroll-to-bottom` 按钮位置稳定
- `GlobalWorkbenchCallout` 不和 `scroll-to-bottom` 重叠
- 多行 composer、高 safe-area、error callout 同时出现时，底部元素仍然分层清楚

失败信号：

- 两个浮层重叠
- thinking 时浮层上下跳

## 六、History

检查：

- 手机上 `Session History` 全屏打开
- 列表和搜索可滚动
- recent / all 切换正常
- claim history -> live 升级路径正常
- 长历史打开后仍锚到底部
- 向上加载更旧历史不会把当前位置跳乱

失败信号：

- 手机历史弹窗偏移出屏幕
- 长历史打开后不在底部

## 七、Inspector 详情

检查：

- `Changes` 大 diff 不会卡死
- `Load more` 可继续展开
- `Diff / File` 切换正常
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
