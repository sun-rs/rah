# RAH 设备认证与配对边界

RAH 是个人工作台，但 daemon 会监听局域网接口并可能经 Tailscale 暴露给其他设备。因此“能连到端口”不能等同于“可以操作 session”。当前认证边界以可信设备为单位，覆盖 HTTP API、事件 WebSocket 和 PTY WebSocket。

## 1. 产品语义

- 通过 `http://127.0.0.1:43111`、`http://localhost:43111` 或 IPv6 loopback 直接访问本机 daemon 时无需配对。
- 通过局域网 IP、Tailscale hostname/IP、Cloudflare Tunnel 或其他代理入口访问时，浏览器必须完成一次配对。
- 配对成功后，该浏览器会保持可信，直到用户主动撤销、清除浏览器站点数据，或删除 RAH 的认证状态。
- Settings > Devices 可以生成新的单次配对码、查看可信设备和撤销设备。
- 撤销设备后，该设备现有的 Chat、Council 和 TUI WebSocket 会立即关闭，不等到下一次请求才失效。
- IP、MAC 地址、User-Agent 和局域网位置都不是身份凭据。

产品上称为“设备”，技术上的持久化单位是浏览器 profile 在某个固定 hostname 下的 cookie。`192.168.x.x`、Tailscale IP 和 `*.ts.net` 是不同 cookie 域；同一台手机分别使用这些入口时需要分别配对。因此应选定一个长期使用的 canonical URL，远程场景推荐 Tailscale HTTPS hostname。loopback 免认证只代表本机直连，不会创建可信设备记录。

## 2. 首次配对

daemon 启动后，在 Mac 本机执行：

```bash
rah pair
```

或从源码 checkout 执行：

```bash
node bin/rah.mjs pair
```

CLI 使用仅存于本机的 management token 请求一个 8 位单次配对码。配对码 10 分钟后过期；在浏览器配对页输入配对码和设备名即可。

已有可信设备也可以从 Settings > Devices 生成配对码，不需要再次操作 Mac 终端。

## 3. 凭据与持久化

认证状态位于：

```text
~/.rah/auth/management-token
~/.rah/auth/devices.json
```

边界如下：

- `management-token` 以 `0600` 保存，只接受来自本机连接的 Bearer 请求。
- 浏览器获得随机 256-bit device token；cookie 使用 `HttpOnly`、`SameSite=Strict`、一年有效期。
- HTTPS 入口会额外设置 `Secure`。
- `devices.json` 只保存 device token 的 SHA-256 hash，不保存原始 token。
- registry 使用临时文件加原子 rename 写入，目录权限为 `0700`，文件权限为 `0600`。
- `lastSeenAt` 最多每 5 分钟落盘一次，避免每个请求都写文件。

## 4. HTTP 与 WebSocket 边界

对于不具备本机直连身份的请求，无需认证的入口只有：

- 前端静态资源
- `GET /readyz`
- `GET /api/auth/status`
- `POST /api/auth/pair`

其余 `/api/*`、`/api/events` 和 `/api/pty/*` 要求可信设备 cookie、本机 management token，或满足严格条件的本机直连身份。直连身份必须同时满足：TCP socket 对端是 loopback、请求 `Host` 是 `127.0.0.1` / `localhost` / `[::1]`，并且请求不带代理转发头。仅伪造 `Host` 或 `X-Forwarded-For` 不能获得该身份；Tailscale Serve、Cloudflare Tunnel 和反向代理即使从 loopback 连接 daemon，也仍需设备认证。浏览器的同源 Origin 检查、`SameSite=Strict` cookie 和写请求的 `x-rah-client` 检查仍保留，作为 CSRF 和错误跨域调用的纵深防护。

设备撤销使用专用 WebSocket close code `4001`。前端收到后停止自动重连，卸载当前工作台并回到配对页。

## 5. 配对安全

- 配对码单次使用，成功后立即失效。
- 每个远端地址在 10 分钟内最多尝试 8 次；超限返回 `429`。
- 生成新配对码会替换旧码并清空上一轮尝试计数。
- management token 不通过 Web UI 展示，也不允许远端 Bearer 请求使用。

8 位配对码用于短时人工确认，不是长期密码。不要把配对码发到聊天、issue 或日志中。

## 6. 网络与 TLS

设备认证不替代链路加密：

- `http://127.0.0.1:43111` / `http://localhost:43111` 只在本机使用，风险最低，并享有直连免认证。
- 局域网 `http://192.168.x.x:43111` 可以工作，但 HTTP 流量未加密；只应在可信 LAN 使用。
- 外网/移动场景推荐 Tailscale Serve 的 HTTPS hostname，由 Tailscale 提供私有网络与 TLS。
- Cloudflare Tunnel 只有在配合 Cloudflare Access 或同等级外层策略时才适合公网入口；不要使用匿名 Funnel 暴露 RAH。

详见 [远程访问：Tailscale、Cloudflare 与 Surge 共存](./remote-access-tailscale-cloudflare.zh-CN.md)。

## 7. 回归要求

认证相关改动至少运行：

```bash
npm run test:auth
npm run typecheck
npm run build:web
```

浏览器回归应覆盖：loopback HTTP/Events/PTY 免认证、伪造 loopback Host 不可绕过远端认证、代理转发请求不可使用本地身份、首次配对、刷新后保持登录、生成第二个配对码、撤销其他设备、撤销当前设备、远端 HTTP 401、Events/PTY WebSocket 拒绝与即时断连。
