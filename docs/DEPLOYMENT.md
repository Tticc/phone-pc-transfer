# LAN Drop 部署说明

## 当前部署入口（2026-10-25 更新）

当前机器已迁移至 **Windows 原生 WSLC 3.0.3.0**，以 [当前 WSLC 部署与管理手册](../DEPLOYED-WSLC.md) 为准。容器 `lan-drop` healthy，发布 `0.0.0.0:9100 -> 9100/tcp`，电脑入口 <http://localhost:9100>，手机入口 <http://192.168.1.3:9100>。用户已确认手机成功配对；本次复查局域网健康接口正常、日志无报错、portproxy 列表为空。

手机完整文字／相册图片传输、无互联网运行和重启恢复等仍需逐项验收，见 [测试记录](../TESTING.md) 与 [待办](../TODO.md)。未配置登录自动启动或故障自动重启。WSLC 不等价支持下文全部 Compose 加固项，差异在当前部署手册中列明。

**下文保留为 Docker Engine / Compose 的备选部署与配置参考，不是当前 WSLC 操作手册；不得同时启动旧容器争用 9100，也无需为当前已打通的路径添加手工 portproxy。**

## 1. 适用范围与验证边界

目标：Windows + WSL 内的 Docker Engine + Docker Compose v2，iPhone Safari 与电脑处于可信、可互访的家庭／个人 Wi-Fi。不是 Docker Desktop 专用说明，不需要公网、HTTPS、账号、STUN/TURN 或第三方中转。HTTP 内容和凭证不加密，切勿配置路由器公网转发、将端口暴露到互联网或在不可信网络使用。

本文基于[服务端源码](../server.js)、[容器构建文件](../Dockerfile)和 [Compose 配置](../compose.yaml)核对编写。最初编写时未执行 Docker 部署；之后已完成目标机 Docker 部署及当前 WSLC 迁移，实际通过范围见 [测试记录](../TESTING.md) 和 [当前部署记录](../DEPLOYED-WSLC.md)。下文通用检查步骤不等于已全部通过；尤其不能把 Compose 配置声明视为 WSLC 已具备的安全保证。

> 本文所有 Windows 网络／防火墙命令均为供人工核对后执行的示例，本次没有执行系统变更。示例地址 `192.168.1.8`、WSL 发行版名 `Ubuntu` 应替换为实际值。

## 2. 启动和使用

先安装并启动 WSL 内的 Docker Engine，确保当前 WSL 用户获准使用 Docker；不在此脚本中自动安装或更改系统权限。WSL 终端内切换到项目目录（例如 `/mnt/c/Users/18883/IdeaProjects/test/lan-drop`）：

```bash
docker version
docker compose version
# 先完成第 5 节网络入口，替换为手机可访问的 Windows 局域网 IPv4。
PUBLIC_URL=http://192.168.1.8:9100 docker compose up -d --build
docker compose ps
docker compose logs --tail=50
curl --fail http://127.0.0.1:9100/health
```

Windows Edge／Chrome 打开 `http://localhost:9100`。接收页生成二维码，iPhone 用相机扫描并以 Safari 打开，保持发送页面前台。文字、图片收到后仍需在电脑复制或下载；批量下载生成单个 ZIP，不会自动永久保存。HEIC 等格式的预览由浏览器支持情况决定，不转换格式；传输的是浏览器实际提交的文件，不承诺相册底层原件。

未设置 `PUBLIC_URL` 时，接收页要求输入手机可访问地址；没有正确地址就不能创建可用配对会话。该地址不影响电脑从 localhost 访问。

需要持久保存启动参数时，可在项目根目录创建仅本地使用的 `.env`，例如：

```dotenv
PUBLIC_URL=http://192.168.1.8:9100
PORT=9100
MAX_SESSIONS=10
```

Compose 自动读取该文件用于变量替换；它不是密钥管理机制，也不会自动把其中所有键传给服务。Shell 同名变量可覆盖文件值。不要提交本地环境文件。使用配置示例时应与下表及 Compose 的当前默认值核对，特别注意 Compose 的会话数默认为 10；共享 tmpfs 与内存不变，不保证所有会话同时存满。

```bash
# 修改配置后重新创建容器；单纯 restart 不应用新的环境参数。
docker compose up -d --build --force-recreate
# 停止并删除容器；临时内容不可恢复。
docker compose down
```

首次 `npm ci`、构建或拉取 Node 基础镜像通常需网络。已构建镜像及本地静态资源在运行时不依赖互联网；离线机器需事先取得镜像（可用 `docker image save` / `docker image load` 搬运）。离线时使用 `docker compose up -d --no-build --pull never`，前提是本地已有 `phone-pc-transfer:1.0.1` 镜像。不要误将“运行可离线”理解成首次构建可离线。

## 3. 配置：以服务端真实逻辑为准

| 变量 | 直接运行服务的默认值 | 含义与 Compose 行为 |
| --- | --- | --- |
| `PORT` | `9100` | 服务监听 `0.0.0.0` 的 TCP 端口。Compose 中此变量替换的是**宿主发布端口**，容器内 `PORT` 明确固定为 `9100`；如 `PORT=8090`，电脑与手机使用 8090，容器和健康检查仍用 9100。 |
| `PUBLIC_URL` | 空 | 手机入口的完整 HTTP origin，例如 `http://192.168.1.8:9100`，不是电脑接收页 URL；不修改监听接口、不创建转发或防火墙规则。可在创建会话时由接收页输入值覆盖。 |
| `DATA_DIR` | 操作系统临时目录 | 必须可创建临时子目录。Compose 固定为 `/data`，不是通过同名宿主环境变量覆盖；每次进程启动创建随机 `lan-drop-*` 子目录。 |
| `TEXT_CHARS` | `100000` | 单次文字 Unicode 码点数量，以 `[...text].length` 计数，不是 UTF-16 单元或字节数；组合字符可能占多个码点。 |
| `FILE_BYTES` | `50000000` | 单张图片最大字节数，即十进制 50 MB。 |
| `BATCH_COUNT` | `20` | 单批图片数；仍受单张与会话总量约束，不保证 20 张均可为 50 MB。 |
| `SESSION_BYTES` | `200000000` | 每会话已接收文字 UTF-8 字节数与图片字节数总和，十进制 200 MB；不含 JS 对象、元数据或进程开销。 |
| `IDLE_MS` | `1800000` | 会话闲置期限，毫秒，即默认 30 分钟。 |
| `PAIR_MS` | `300000` | 一次性二维码／配对凭证有效期，毫秒，即默认 5 分钟；不是已配对手机每 5 分钟强制断线。 |
| `MAX_SESSIONS` | `8` | 当前未清理的接收会话总数，非每会话手机数；**Compose 默认及当前 WSLC 为 `10`**（用户指定），共享 tmpfs 与内存不变，不能同时存满各会话额度。刷新或多开电脑页可能占用额外会话直至过期。 |
| `NODE_ENV` | 服务端无相关分支 | 镜像设为 `production`，不是应用功能开关。 |

数值配置均经 `Number(...)` 转换后要求**大于零的安全整数**，否则启动报 `Limits must be positive integers`。直接运行时未定义才使用默认值；空串不会使用默认值而会报错。Compose 的 `${VAR:-default}` 则会把缺失或空值替换为示例默认值。不要加 `MB`、`m`、`s` 后缀。端口还必须处于操作系统可监听范围；不要把正整数校验理解为端口有效性保证。

`PUBLIC_URL` 服务端只接受 `http:`，禁止账号密码、非根路径、查询串和片段，拒绝明确列出的 localhost／回环等地址；无效非空环境值会导致启动失败。根路径尾斜杠可被归一化。此校验**不证明地址确实属于局域网或手机可达**，也不是局域网 IP 白名单；部署者仍需选择正确的入口。不要填写 `localhost`、`127.0.0.1`、`0.0.0.0`、容器 IP 或 NAT 下不可路由的 WSL 私有 IP。公网域名即使通过语法校验也不属于本项目使用范围。

另有固定的每会话约 2,000 内容条目保护：文字达到 2,000 项拒绝继续；图片上传入口按当前条目数加 `BATCH_COUNT` 预留检查，因此可能在未满 2,000 项前要求清空。该项不由环境变量配置。

### 接收会话释放与名额恢复（生命周期修复）

接收页新增“结束接收会话”，使用现有接收令牌调用 `DELETE /api/session`。确认后删除临时文件并撤销所有凭证，立即释放会话名额；忙碌中的上传／下载／清理返回 409，不能强行结束。先保存需要的内容。

状态轮询更新接收页存活时间但不更新业务活动时间。`RECEIVER_GRACE_MS` 默认 `120000` 毫秒（同样要求大于零的安全整数），Compose 已透传。无内容且非 busy 的会话，在接收端心跳与最近业务活动均超过宽限后可清理；已配对但空的会话也适用。有内容不做失联提前清理，仍保留原业务闲置期限。

定时清理扫描间隔为 `min(IDLE_MS, RECEIVER_GRACE_MS, 30000)`，创建会话也主动清理。关闭页面不立即删除，也不依赖 unload 事件，刷新有效会话仍可恢复。浏览器后台节流可能导致空会话被回收，须重新创建。429 返回 `Retry-After` 与 `retryAfterSeconds`，界面给出保存／结束旧会话及手动重试提示；重试时间是建议，不是名额预留或恢复承诺。

### 闲置、断开和超时

- 配对、成功发送、上传开始、下载开始／结束、显式断开、重新配对和清空等更新活动时间；状态轮询不续期，持续打开页面也会闲置过期。
- 上传、下载或清空中的会话不由闲置清理器删除。定时器每 `min(IDLE_MS, 30000)` 毫秒扫描，鉴权也检查过期；不是精确到毫秒的物理删除保证。
- 断开撤销手机权限但保留已收内容供电脑下载；重新配对撤销旧手机和旧二维码。二维码使用一次即失效。会话闲置过期后需创建新会话。
- 正常 SIGTERM／SIGINT 尝试关闭连接并清理进程临时目录；容器停止／重启后 tmpfs 内容丢失，无恢复功能。不要将 tmpfs 当作取证级绝不落盘保证，宿主可能启用 swap。
- 服务端请求超时与 socket 空闲超时 120 秒，请求头超时 15 秒。前端上传／文件／ZIP 下载限时 120 秒，普通 API 默认 15 秒，状态检查 10 秒，发送文字 20 秒。慢网络建议减小批量；超时结果可能未确认，先查看电脑接收箱再手动重试。

## 4. 容器安全与配额审查

[Dockerfile](../Dockerfile)使用 `node:24-alpine`、锁文件 `npm ci --omit=dev` 和非 root `node` 用户。构建阶段安装依赖，运行阶段不会调用 npm 或在线安装资源。基础镜像标签可随上游更新；需要可复现发布时应由维护者固定并定期更新 digest，而不是把当前标签当成永远不变。

[Compose](../compose.yaml)设置：

- 根文件系统只读；应用源码和依赖不可运行时改写。`DATA_DIR=/data` 与 `/tmp` 是独立可写 tmpfs，不挂载永久内容目录。
- `/data` 为 `512m`，`uid=1000,gid=1000,mode=0700`，与当前官方 Node 镜像 `node` 用户匹配。仅在镜像层 `chown /data` **不足以**保证挂载后的权限；此处在 tmpfs 挂载参数指定所有权。更换镜像用户时必须同步调整 uid/gid。
- `/tmp` 为 `16m,mode=1777`；两处 tmpfs 均加 `noexec,nosuid,nodev`。这些是 Docker Engine Linux 挂载选项，仍需目标环境实际确认。
- 丢弃全部 Linux capabilities，禁止新增权限，PID 上限 100，内存上限 `768m`，日志最多约 2 × 5 MB。Docker 的 `m` 按二进制 MiB 理解，而应用的 MB 为十进制。
- 默认 Compose 两会话 × 200,000,000 字节约 381.5 MiB，低于 512 MiB tmpfs；原服务默认八会话合计 1.6 GB 不适合这份配额。因此 Compose 默认降为 2，但显式配置仍可覆盖。
- tmpfs 大小是共享上限而非预分配／每会话预留；tmpfs 页计入容器内存，再加文字、元数据、Node 堆、请求缓冲和 ZIP／下载流开销。不能把 `SESSION_BYTES × MAX_SESSIONS < tmpfs` 视为不会 OOM 的证明。大量并发、大文字或调大批量时需留出更多余量；768 MiB 也不是性能保证。
- 没有应用级全局配额／磁盘容量预留。调大 `SESSION_BYTES`、`MAX_SESSIONS`、`TEXT_CHARS` 或批量时，必须同时审视 tmpfs、内存及宿主可用资源。空间耗尽可能返回通用 500，OOM 可能导致重启并丢失内容。不要用 bind mount 持久化目录“解决”问题而破坏临时存储边界。

镜像健康检查每 30 秒请求容器自身 `127.0.0.1:$PORT/health`（内部 2 秒超时、Docker 3 秒超时、启动宽限 5 秒、连续 3 次失败为 unhealthy）。该接口仅验证 HTTP 进程响应，不检查 tmpfs 剩余空间、上传能力、Windows 转发或 iPhone 可达。`restart: unless-stopped` 会在进程退出时重启，**不会仅因 unhealthy 自动重启**。

直接 `docker run` 不会继承 Compose 的 tmpfs、只读根和资源限制。不要只运行镜像就假设安全配置相同；镜像默认 `/data` 在非 root 下也未必可写，推荐使用 Compose。部署者可执行下列只检查命令核对实际状态：

```bash
docker compose exec lan-drop id
docker compose exec lan-drop node -e 'const fs=require("node:fs");fs.accessSync("/data",fs.constants.W_OK);console.log("/data writable")'
docker inspect "$(docker compose ps -q lan-drop)" --format '{{json .State.Health}}'
docker inspect "$(docker compose ps -q lan-drop)" --format '{{json .HostConfig}}'
docker stats --no-stream
```

## 5. WSL 网络：只选符合实际模式的一条路径

共同前提：Compose 发布 `HOST_PORT:9100` 默认绑定 WSL 的可用接口，不是只监听 localhost。主机端口与容器端口是两层；修改宿主 `PORT` 后，要同步修改 `PUBLIC_URL`、防火墙及 NAT 规则。查看 Windows `ipconfig` 确认正在使用的 Wi-Fi／以太网 IPv4；不要选 VPN、Docker 或不相关虚拟网卡。建议为电脑做 DHCP 地址保留，地址变化后更新配置并重建容器和配对二维码。

### 路径 A：WSL 默认 NAT + Windows portproxy

路径：iPhone → Windows 局域网 IPv4:9100 → Windows TCP portproxy → WSL NAT IPv4:9100 → Docker 发布端口 → 容器 9100。

1. 先在 WSL 中确认 `curl http://127.0.0.1:9100/health` 成功，再在 Windows 确认 `http://localhost:9100/health`。WSL 的 localhost forwarding 通常支持 Windows 本机访问，但**不等于**局域网设备可访问。
2. Windows 普通 PowerShell 查询地址和现有规则：

```powershell
ipconfig
wsl -l -v
wsl -d Ubuntu -- hostname -I
netsh interface portproxy show all
Get-Service iphlpsvc
```

`hostname -I` 可能返回多个地址（含 Docker 网桥等），不要未经核实取全部输出或误选网桥。选 WSL `eth0` 的 NAT IPv4，可在 WSL 用 `ip -4 addr show eth0` 核对。以下示例假设为 `172.28.10.20`。

3. **管理员 PowerShell，人工核对后执行**。监听 Windows 当前局域网 IP，而不是 `0.0.0.0`；仅放行 Private 网络及 LocalSubnet。若当前可信 Wi-Fi 被识别为 Public，请先判断网络可信性并人工配置正确 profile，不要简单新增 Public 全网放行。

```powershell
netsh interface portproxy add v4tov4 listenaddress=192.168.1.8 listenport=9100 connectaddress=172.28.10.20 connectport=9100 protocol=tcp
New-NetFirewallRule -DisplayName "LAN Drop TCP 9100" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.1.8 -LocalPort 9100 -Profile Private -RemoteAddress LocalSubnet
```

portproxy 依赖 Windows IP Helper（`iphlpsvc`）；受企业策略、服务状态或现有端口占用影响时先诊断，不要盲目更改系统。WSL 虚拟机重启后 NAT IP 可能变化，届时人工更新规则指向新 IP。必要时检查 WSL 内 Linux 防火墙及 Docker 转发链，不要禁用全部防火墙。

4. Windows 用 `http://192.168.1.8:9100/health` 检查入口，再用 iPhone Safari 打开同一地址检查。两者成功后才扫码配对。

移除示例（同样仅供人工执行，参数须与自己创建的规则一致）：

```powershell
netsh interface portproxy delete v4tov4 listenaddress=192.168.1.8 listenport=9100 protocol=tcp
Remove-NetFirewallRule -DisplayName "LAN Drop TCP 9100"
```

### 路径 B：WSL mirrored networking

适用于支持 mirrored 的 Windows 11 22H2+ 和较新的 WSL（先用 `wsl --version` 检查并参考微软兼容说明）。不支持时使用 NAT 路径，不把该设置强塞给所有 WSL 环境。

人工编辑 Windows 用户目录 `%UserProfile%\.wslconfig`，合并到已有配置，**不要覆盖其他设置**：

```ini
[wsl2]
networkingMode=mirrored
```

应用配置一般需人工运行 `wsl --shutdown` 后重开 WSL；此操作会终止所有正在运行的 WSL 发行版和其中服务，应先保存工作并安排窗口，再重新启动 Docker Engine／容器。mirrored 通常不需要 NAT 的 portproxy；旧规则可能冲突，应核对后仅移除本应用自己创建的规则。

路径：iPhone → Windows 对应局域网地址:9100 → mirrored WSL 网络／Docker 发布端口 → 容器。仍须确认 Docker 的发布端口能在该 WSL／Docker 版本组合下从局域网进入；mirrored 模式不是可达性保证。

Windows Defender 防火墙与 WSL Hyper-V 防火墙均可能参与。较新 WSL 默认启用 Hyper-V 防火墙；不要采用全局 `DefaultInboundAction Allow`。先检查，再由管理员为必要端口创建针对 WSL 的入站规则（示例）：

```powershell
Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
New-NetFirewallHyperVRule -Name "LAN-Drop-9100" -DisplayName "LAN Drop TCP 9100 WSL" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 9100 -RemoteAddresses LocalSubnet -Action Allow
```

上述 GUID 为 WSL 的 VM creator ID。可用 cmdlet／参数受系统版本影响；命令不存在时检查系统支持，不要改为关闭防火墙。根据生效策略，还可能需要与 NAT 示例相同的 Windows Defender Private／LocalSubnet 端口规则；管理员策略也可能不允许本地规则。仅开放实际端口与可信网段；LocalSubnet 可能涵盖多网卡直连子网，必要时替换为明确家庭网段。Hyper-V 规则不等同于 Windows Private profile 规则，应在切换网络后复查其适用范围，用完可移除：

```powershell
Remove-NetFirewallHyperVRule -Name "LAN-Drop-9100"
```

无论哪种模式，先 Windows localhost、再 Windows 局域网地址、最后 iPhone 实测。不要因为 localhost 成功就宣布网络部署完成。

参考微软说明：[WSL 网络访问与 mirrored](https://learn.microsoft.com/windows/wsl/networking)、[WSL 高级配置](https://learn.microsoft.com/windows/wsl/wsl-config)、[Hyper-V 防火墙](https://learn.microsoft.com/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall)。系统更新可能改变具体行为，以部署机器版本为准。

## 6. 故障排查与部署后检查清单

| 现象 | 检查方向 |
| --- | --- |
| 容器立即退出 | 日志里的环境变量校验；`PUBLIC_URL` 是否完整 HTTP origin；端口是否冲突；数据 tmpfs 是否匹配用户权限。不要输出或传播配对 URL／令牌。 |
| `/data` 报权限错误 | 核对 `docker compose exec lan-drop id` 与 tmpfs uid/gid；确认不是遗漏 Compose 参数的裸镜像运行。不用 root 运行来掩盖问题。 |
| unhealthy 但仍运行 | 检查内部服务、容器 PORT 和日志；healthcheck 不测试外部网络，restart 策略不会因 unhealthy 自动重启。 |
| WSL 能访问，Windows localhost 不通 | Docker 发布端口、WSL 运行状态／localhost 转发、端口占用与防火墙。 |
| Windows localhost 通、手机不通 | `PUBLIC_URL` 地址及端口、NAT portproxy 目标 IP 是否变化、mirrored 是否实际启用、Windows／Hyper-V／Linux 防火墙、Wi-Fi 客户端隔离、访客网络、VPN。不要开公网路由转发。 |
| 页面通但扫码不通 | 二维码是否仍指向旧 IP 或端口、是否已使用或超过 5 分钟；电脑重新配对后扫新二维码。 |
| 接收会话名额已满（429） | 默认 Compose／当前 WSLC 为 10 会话。在旧页先保存再点击“结束接收会话”立即释放；已关闭空页在 120 秒失联与无活动宽限后回收（扫描最多再延迟 30 秒，创建时也清理），有内容保留至原闲置期。按页面建议手动重试，不扩大上限掩盖问题。 |
| 会话失效（401／410） | 状态轮询不延长 30 分钟闲置期；重新创建会话／重新配对，过期内容不可恢复。 |
| 413／通用 500／进程重启 | 先看单张、批量、会话总量和条目限制，再检查 tmpfs 空间、容器内存／OOM 与日志；清空或减小批量。 |
| 下载／发送超时 | 先查看接收箱确认是否已收，再手动重试；手机 Safari 保持前台，减小批量。 |
| 复制失败 | 电脑优先 localhost 安全上下文；按页面提示手动 Ctrl+C，不引入 HTTPS 作为前提。 |

部署者需自行确认：

1. Docker 实际构建成功，非 root 能写 `/data`，只读根、tmpfs、内存/PID 限额和健康检查生效。
2. Windows 和 iPhone 均能访问选定局域网入口，正确配对并阻止第二部手机重复使用凭证。
3. 中文／网址／图片／ZIP 下载正常，下载字节与浏览器提交文件一致；HEIC 不支持预览时仍可下载。
4. 保留 Wi-Fi、断开互联网后新开页面和传输仍正常；不要据此推断首次镜像构建不需要互联网。
5. 清空、闲置过期、容器停止／重启后，服务不能取回已清理内容；重要内容已另行保存。
6. 真实 iPhone Safari、NAT 或 mirrored、防火墙及资源压力场景分别记录实际观察，不把此说明文件作为验收结果。
