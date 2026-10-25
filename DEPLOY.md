# 部署与使用：当前 WSLC / 备选 Docker WSL

## 当前机器入口（2026-10-25）

当前使用 **Windows 原生 WSLC 3.0.3.0**，不再通过 Ubuntu Docker 容器提供服务。请优先阅读 [当前 WSLC 部署与管理手册](DEPLOYED-WSLC.md)，其中包含启动／停止、重建命令、参数和安全差异。

- 电脑接收页：<http://localhost:9100>。
- 手机入口：<http://192.168.1.3:9100>；用户已确认手机成功配对。
- 容器 `lan-drop` healthy，局域网 `/health` 返回 `{"ok":true}`；当前 portproxy 列表为空。
- 未配置登录自动启动或故障自动重启；手机完整传输、离线及重启恢复验收见 [测试记录](TESTING.md)。

**以下为备选 Docker Engine / Compose 方案，不是当前 WSLC 的操作步骤。不要同时启动旧 Docker 容器，也不要为已正常的 WSLC 路径添加下述 NAT 转发。**

## 1. 构建并启动

要求：WSL 已安装 Docker Engine 与 Compose 插件。以下命令在项目所在 WSL 目录运行。

```bash
cp .env.example .env
# 编辑 .env：PUBLIC_URL 改成 Windows Wi-Fi 网卡 IPv4，例如 http://192.168.1.8:9100
docker compose up -d --build
docker compose ps
docker compose logs --tail=30
```

Windows 浏览器打开 `http://localhost:9100`。如果 localhost 不可访问，按下一节排查。二维码中的地址来自 PUBLIC_URL，也可以在未配置时由接收页填写；不能填 localhost、Docker 内网 IP。Windows IP 可从 Windows 设置的网络属性或 `ipconfig` 查看，DHCP 改变地址后需更新配置并重建容器。

```bash
docker compose up -d --force-recreate
docker compose down
```

服务不会主动修改你的 WSL 设置、Windows 防火墙或端口转发。仅在可信 Wi-Fi 使用，不映射公网端口。HTTP 无加密，临时凭证不防网络窃听。

## 2. WSL 局域网入口

### 先分层验证

1. WSL 执行 `curl http://localhost:9100/health`，应得到 `{"ok":true}`。
2. Windows 打开 `http://localhost:9100/health`。
3. iPhone Safari 打开 `http://Windows的Wi-Fi地址:9100/health`。
4. 第 3 步成功再扫码。Wi-Fi 开启访客隔离、AP 隔离、VPN 时可能不通。

### WSL 2 默认 NAT 模式

当 Windows localhost 可访问但手机无法访问时，可将 Windows 局域网端口转发到 WSL 地址。以下命令需在**管理员 PowerShell**执行，由用户确认具体发行版与 IP；不要把所有网卡或公网接口一并开放。

```powershell
wsl -l -v
# 把 Ubuntu 换成实际发行版名；输出可能有多个 IP，选择 WSL eth0 地址
wsl -d Ubuntu hostname -I
# 手工填写 Windows Wi-Fi IPv4 和 WSL eth0 IPv4
$lanIp = '192.168.1.8'
$wslIp = '172.24.10.20'
netsh interface portproxy add v4tov4 listenaddress=$lanIp listenport=9100 connectaddress=$wslIp connectport=9100
New-NetFirewallRule -DisplayName 'LAN Drop 9100' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9100 -LocalAddress $lanIp -RemoteAddress LocalSubnet -Profile Private
netsh interface portproxy show all
```

检查网络配置为可信的 Private（专用）网络；不要为了传输关闭整个防火墙。Windows IP Helper 服务需可用。WSL 重启后 NAT 地址可能变化，需要更新转发。电脑 localhost 不可访问但 WSL 地址可访问时，也可以使用该 WSL 地址打开电脑接收页，不过剪贴板 API 可能降级为手动复制。

撤销转发和规则（使用创建时的 Windows 地址）：

```powershell
netsh interface portproxy delete v4tov4 listenaddress=192.168.1.8 listenport=9100
Remove-NetFirewallRule -DisplayName 'LAN Drop 9100'
```

### WSL mirrored 模式

支持 mirrored 的 Windows 11／WSL 可以沿用其现有网络配置，通常无需上述 NAT portproxy。不要为了本工具贸然切换全局网络模式。仍需核对 Windows 和 Hyper-V 防火墙是否允许来自局域网的端口 9100。若 Hyper-V 防火墙阻止，支持相应命令的系统可由用户在管理员 PowerShell 中添加仅该端口的规则：

```powershell
New-NetFirewallHyperVRule -Name 'LAN-Drop-9100' -DisplayName 'LAN Drop 9100' -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 9100
# 不需要时移除：Remove-NetFirewallHyperVRule -Name 'LAN-Drop-9100'
```

系统版本、组织策略可能不支持或禁止这些操作；以第 3 步手机实际访问 health 为准。不要使用全局放开入站的规则。

## 3. 使用

- 电脑打开接收页，检查二维码的局域网地址，iPhone 系统相机扫码。
- 手机 Safari 在前台输入文字或从相册选择图片；每批可多选。
- 发送成功表示本机服务已接收；电脑点击复制、单张下载或 ZIP 批量下载后才完成保存。
- Safari 切后台、锁屏可能中断；失败后可手动重试，不自动重发，重试前留意电脑是否已收到，避免重复。
- HEIC 等格式预览失败不影响下载；应用不改变收到的文件字节。
- 二维码 5 分钟失效且只能配对一次；点击重新配对生成新的二维码。
- 断开手机会撤销其发送权限但保留当前内容；重新配对不自动删除内容。清空会删除内容，但保持当前配对。
- 接收端和手机凭证保存在各自当前标签页的 sessionStorage；接收页支持同 origin、同标签页恢复有效会话。不同地址（如 localhost 与局域网 IP）、不同浏览器或新标签页不能共享恢复状态，可能创建额外会话；旧内容不承诺恢复。关闭页面不会立即释放会话。
- 轮询不刷新闲置时间。成功发送、配对、断开／重配、清空、下载会刷新计时；30 分钟无这些操作，整个会话自动删除。
- 正在上传／下载／清理的会话不会被定时清理；完成传输后重新计时。容器重启即丢失临时内容。

### 会话名额与结束接收

- 不再只靠关闭页面等待 30 分钟：点击“结束接收会话”，确认后立即删除临时内容、断开手机并释放名额。请先保存重要内容；传输／下载／清理中暂不允许结束。
- 关闭空接收页后，无心跳且无业务活动满 120 秒可回收（定时检查最多再延迟 30 秒，创建时也清理）；有内容不会因失联提前回收，仍按业务闲置期限清理。
- 刷新不自动删除会话；后台页面可能被浏览器节流，空会话可过期后重建。状态轮询只证明接收页在线，不延长 30 分钟业务闲置期。
- 名额满时按提示去旧接收页保存内容并结束，或等待空页宽限后手动重试；不要靠反复刷新或扩大上限解决。

## 4. 配置

参见 `.env.example`。所有限制服务端执行；前端提示不替代校验。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| PORT | 9100 | Compose 在宿主发布的端口；容器内保持 9100 |
| PUBLIC_URL | 空 | 手机访问的 HTTP 根地址；空时由页面填写 |
| TEXT_CHARS | 100000 | Unicode 码点数，emoji 可能包含多个码点 |
| FILE_BYTES | 50000000 | 单张图片字节数，50 MB 为十进制 |
| BATCH_COUNT | 20 | 一次上传图片数量 |
| SESSION_BYTES | 200000000 | 文字 UTF-8 字节与图片字节合计 |
| IDLE_MS | 1800000 | 会话闲置清理间隔，毫秒 |
| PAIR_MS | 300000 | 二维码凭证有效期，毫秒 |
| RECEIVER_GRACE_MS | 120000 | 空会话失联且无业务活动的提前回收宽限，毫秒 |
| MAX_SESSIONS | 服务端 8，Compose 10 | 同时存在的接收会话上限；当前 WSLC 为 10，共享存储／内存容量不变 |

每会话另有 2000 条内容的防滥用限制，达到后清空继续。默认 tmpfs 共 512 MiB，容器内存上限 768 MiB；多个会话可能在各自达到额度前耗尽总临时空间，此时上传失败、已提交内容保留，可清空或等待过期。修改 SESSION_BYTES／MAX_SESSIONS 时应同步评估 tmpfs 与内存。ZIP 不压缩图片，下载时流式生成，不持久化第二份副本。

## 5. 离线运行与镜像转移

首次构建需要 Node 基础镜像和 npm 包。镜像构建完成后运行不需要网络，所有页面资源和二维码生成都在本机。

```bash
docker save phone-pc-transfer:1.0.1 -o lan-drop.tar
# 另一台离线机器：
docker load -i lan-drop.tar
# 先复制项目的 compose.yaml 和按实际地址填写的 .env，然后：
docker compose up -d --no-build --pull never
```

## 6. 本地开发与测试

Node.js 22+：

```bash
npm ci
npm test
npm start
```

本地运行未使用 tmpfs 时临时图片可能写到系统临时目录；生产应使用提供的 Compose tmpfs。正常退出会删除本进程目录，崩溃强制结束后系统临时目录可能遗留，因此不建议用宿主裸跑作为隐私部署方案。

测试与限制见 `TESTING.md`。不要将 localhost 自动化通过等同于 iPhone／WSL 局域网验收完成。
