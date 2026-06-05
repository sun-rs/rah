# RAH 远程访问：Tailscale、Cloudflare 与 Surge 共存

本文记录 RAH 在外网、移动网络、iOS/PWA 场景下访问本机 daemon 的方案选择和本机实践。目标不是把 RAH 暴露成公网服务，而是在网络抖动、切换基站、离开局域网时，尽量保持安全、连续、少人工干预的访问路径。

## 1. 目标边界

RAH 的运行体仍在 Mac 本机：

- daemon 默认端口是 `43111`。
- provider runtime、tmux/TUI、Codex/OpenCode local server、Claude/Gemini TUI mux 都由本机 daemon 持有。
- 手机/PWA 只是远程 client。断网后恢复访问，依赖浏览器和 RAH WebSocket/HTTP 重连；不会也不应该把 provider runtime 搬到云端。

远程访问要满足：

- 不再依赖 iOS SSH app 手工做 `43111 -> 127.0.0.1:43111` 端口转发。
- 网络短暂中断后，恢复信号即可重新连接，不需要重新开 SSH tunnel。
- Mac 仍可保留 Surge/TUN 翻墙能力，避免影响 Codex/Gemini/Google 登录。
- 默认只对自己 tailnet 内设备暴露 RAH，不使用公网匿名入口。

## 2. 结论

默认推荐 Tailscale。

原因：

- Tailscale 给 iPhone/iPad/Mac 一个稳定 tailnet 地址，PWA 访问固定 URL 即可。
- 网络变化时 Tailscale client 会自动重连，用户不需要重新建立 SSH 端口转发。
- 同一局域网内，Tailscale 有机会走 peer-to-peer 直连；外网或复杂 NAT 下会自动 fallback 到 DERP relay。
- 安全边界默认是 tailnet 成员，不是公网。
- RAH 不需要知道自己是在 LAN、蜂窝网络还是 DERP relay 后面。

Cloudflare Tunnel 作为备选：

- 适合需要分享给非 tailnet 用户、需要标准公网 HTTPS 域名、需要 Cloudflare Access 做集中身份认证时。
- 不适合作为本机私人工具的默认方案，尤其在大陆网络环境下 Cloudflare 访问存在不确定性。
- 如果使用 Cloudflare Tunnel，必须配置 Cloudflare Access 或同等级鉴权；不能把 RAH 裸露到公网。

## 3. 当前本机实践

当前实践是使用 Tailscale Serve，把 tailnet 内的 `43111` 转发到 Mac 本机的 `localhost:43111`。

检查当前 Serve 配置：

```bash
tailscale serve status
tailscale serve status --json
```

本机当前有效配置形态：

```json
{
  "TCP": {
    "43111": {
      "TCPForward": "localhost:43111"
    }
  }
}
```

这意味着：

- iPhone/iPad 在同一 tailnet 内访问 `http://<mac-magicdns-name>:43111/`。
- 或访问 `http://<mac-tailscale-ip>:43111/`。
- Tailscale 只把 tailnet 侧的 `43111` 转发到本机 loopback 服务。
- 不需要让 RAH 自己理解 Tailscale，也不需要 provider runtime 绑定公网地址。

本机验证命令：

```bash
curl -fsS http://127.0.0.1:43111/ | head
curl -fsS http://<mac-tailscale-ip>:43111/ | head
curl -fsS http://<mac-magicdns-name>:43111/ | head
```

当前机器曾验证：

- `tailscale status --json` 显示 Tailscale `BackendState` 为 `Running`。
- MagicDNS 已启用。
- iPhone peer 在线。
- `tailscale serve status --json` 显示 `43111 -> localhost:43111`。
- Mac 本机通过 Tailscale IP 和 MagicDNS 都能访问到 RAH 首页。

不要把真实 tailnet 域名、Tailscale node key、用户邮箱或 auth key 写入仓库。

## 4. 配置方式

### 4.1 RAH 端

RAH daemon 当前默认监听 `43111`。先确认本机可访问：

```bash
curl -fsS http://127.0.0.1:43111/ | head
```

如果本机都不能访问，先修 RAH daemon，不要先排查 Tailscale。

### 4.2 Tailscale 端

查看本机 tailnet 地址：

```bash
tailscale ip -4
tailscale ip -6
tailscale status
```

暴露 RAH 给 tailnet：

```bash
tailscale serve --bg --tcp 43111 localhost:43111
```

不同 Tailscale CLI 版本的 `serve` 语法可能略有差异。以当前机器的 `tailscale serve --help` 为准。关键目标是让 `tailscale serve status --json` 出现：

```json
"TCPForward": "localhost:43111"
```

如果只是暴露一个普通 HTTP 服务，新版 Tailscale 也支持简写：

```bash
tailscale serve --bg 43111
```

但对 RAH 这类本地 WebSocket/HTTP 混合服务，明确 TCP forward 更容易理解和排障。

清空 Serve 配置：

```bash
tailscale serve reset
```

新增多个固定端口时，按同一模式逐个映射：

```bash
tailscale serve --bg --tcp <tailnet-port> localhost:<local-port>
tailscale serve status
```

默认不要使用 `tailscale funnel`。`funnel` 是公网入口，不是 tailnet 私有入口。

## 5. Surge 共存原则

本机使用 Surge 的原因是 Codex/Gemini/Google 等 provider 仍需要稳定外网能力。Tailscale 的目标只是提供“设备之间的私有通道”，不应该接管普通互联网流量。

原则：

- Mac 可以继续开启 Surge。
- iOS 访问 RAH 时可以不开 Surge，只要 iOS Tailscale 在线。
- 不使用 Tailscale exit node。
- 不向 tailnet 广播本机 LAN subnet route，除非明确要做网关。
- 不让 Surge 把 tailnet 私有流量代理到公网。

Surge 规则建议：

```text
IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
IP-CIDR6,fd7a:115c:a1e0::/48,DIRECT,no-resolve
DOMAIN-SUFFIX,ts.net,DIRECT
DOMAIN-SUFFIX,tailscale.com,DIRECT
```

注意：

- `100.64.0.0/10` 是 Tailscale IPv4 tailnet 地址段。
- `fd7a:115c:a1e0::/48` 是 Tailscale ULA IPv6 地址段。
- `*.ts.net` 是 MagicDNS/HTTPS cert 相关域名。
- 如果某个地区直连 `tailscale.com` 控制面不稳定，可以不要强制 `tailscale.com` 走 DIRECT；但 tailnet IP 和 MagicDNS 访问 RAH 的流量必须 DIRECT。

如果开启 Surge TUN/enhanced mode 后 Google/Gemini 登录异常，优先检查：

- 是否启用了 Tailscale exit node。
- 是否让 Tailscale 接管了默认路由或 DNS 到不合适的出口。
- Surge 是否把 `100.64.0.0/10` 或 `*.ts.net` 送进代理。
- Tailscale 是否仍是 `BackendState: Running`。
- `tailscale netcheck` 是否显示 UDP 可用；若 UDP 不可用，Tailscale 会更多走 DERP，延迟会上升但一般仍可用。

RAH 本身不应该要求关闭 Surge。

## 6. 局域网与外网是否能用同一个地址

可以优先使用 Tailscale 地址或 MagicDNS 作为统一入口：

```text
http://<mac-magicdns-name>:43111/
```

同一局域网内，如果 Tailscale 能建立 peer-to-peer direct path，底层会走局域网或近路径；离开局域网后会自动切到可用路径或 DERP relay。用户层 URL 不变。

也可以在家里直接访问：

```text
http://<mac-lan-ip>:43111/
```

但这会产生两个入口：

- 家里：LAN IP
- 外面：Tailscale IP/MagicDNS

为了 PWA 和书签稳定，推荐统一使用 Tailscale MagicDNS。即使在家里，也让 Tailscale 负责选择直连或 relay。

## 7. 与 SSH tunnel / mosh 的区别

SSH 端口转发的问题是 tunnel 本身是一个前台会话：

- iOS 网络中断后 tunnel 可能断开。
- 用户要重新打开 SSH app。
- PWA 里的 `127.0.0.1:43111` 只在 tunnel 活着时有效。

Tailscale 的优势是把“保持设备间连接”交给常驻 client：

- PWA 访问稳定 tailnet URL。
- 网络恢复后 Tailscale 自动重建路径。
- RAH daemon 继续在 Mac 上持有 session runtime。
- Web/PWA 重连后继续从 RAH 读取当前状态。

这不是 TCP 层的 mosh，也不会保留已经断掉的单条 WebSocket；真正的连续性来自：

- RAH daemon 不退出。
- provider runtime 不退出。
- PWA 重新连上同一个 daemon。
- client store 重新同步 session/council state。

## 8. Cloudflare Tunnel 何时使用

Cloudflare Tunnel 适合：

- 给没有 Tailscale 的设备访问。
- 要绑定自己的域名。
- 要 Cloudflare Access 统一登录、设备策略、MFA。
- 要通过普通 HTTPS 被浏览器/PWA 访问，不希望安装 VPN client。

不适合：

- 只给自己 iPhone/iPad 访问本机 RAH。
- 主要使用大陆蜂窝网络，且要求极高可用性。
- 不愿意维护公网鉴权策略。

风险：

- Cloudflare 边缘在大陆网络里可能不可达或质量不稳定。
- 一旦配置错误，RAH 可能被暴露到公网。
- 需要额外维护 `cloudflared`、DNS、Access policy。

如果必须用 Cloudflare：

- 只通过 Cloudflare Tunnel 暴露 `http://127.0.0.1:43111`。
- 必须启用 Cloudflare Access。
- 不要使用“任何人可访问”的公开 URL。
- 不要把 provider API key、Tailscale auth key、RAH 本地敏感路径写进 Cloudflare 配置或日志。

## 9. 排障流程

### 9.1 Mac 本机

```bash
curl -fsS http://127.0.0.1:43111/ | head
lsof -nP -iTCP:43111 -sTCP:LISTEN
```

如果失败，问题在 RAH daemon 或本机监听。

### 9.2 Tailscale 本机状态

```bash
tailscale status
tailscale status --json
tailscale netcheck
tailscale serve status
tailscale serve status --json
```

重点看：

- Backend 是否 Running。
- Mac 是否有 Tailscale IP。
- iPhone/iPad peer 是否 Online。
- Serve 是否有 `43111 -> localhost:43111`。
- netcheck 里 UDP 是否可用；不可用时延迟可能更高。

### 9.3 从 Mac 自测 tailnet 入口

```bash
curl -fsS http://<mac-tailscale-ip>:43111/ | head
curl -fsS http://<mac-magicdns-name>:43111/ | head
```

如果 Mac 自己能访问，而 iOS 不能访问，优先看：

- iOS Tailscale 是否在线。
- iOS 是否在同一个 tailnet。
- 是否用了错误的 host/端口。
- iOS 浏览器是否缓存了旧 PWA URL。

### 9.4 从 iOS 访问

推荐 URL：

```text
http://<mac-magicdns-name>:43111/
```

备选：

```text
http://<mac-tailscale-ip>:43111/
```

如果 MagicDNS 不工作但 IP 工作，问题在 DNS/MagicDNS。可以先用 IP 保持使用，再排查 Tailscale DNS。

## 10. 安全边界

- 默认只使用 Tailscale Serve，不使用 Funnel。
- 只暴露明确端口，不做“所有本机端口通配公开”。
- 不把 RAH 直接绑定到公网 IP。
- 不在文档、commit、issue 中记录真实 auth key、node key、API key、Cloudflare token。
- 如果将来做公网入口，必须先有认证、审计和最小权限策略。

RAH 的正确远程访问模型是：本机 daemon 长驻，tailnet 提供稳定私有入口，PWA 作为可断线重连的 client。
