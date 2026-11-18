# 当前部署：原生 WSLC

2026-10-25 已从 Ubuntu Docker Engine 迁移到 Windows 原生 WSL Containers（wslc 3.0.3.0）。本记录取代 DEPLOYED-WSL.md 的当前运行状态；原文为历史部署记录。

## 命名调整

项目目录及 GitHub 仓库名为 `phone-pc-transfer`；为了方便终端日常启停，WSLC 容器名已简化为 **`ptc`**，镜像已统一为 **`ptc:1.1.0`**（含 `ptc:latest` 标签，支持电脑/手机双向互传）。启动命令为 `wslc start ptc`。重建已清空临时内容，需重新配对。页面品牌已统一为 Phone PC Transfer，存储键平滑兼容旧会话。

## 当前状态

- 容器名：`ptc`；当前镜像：`ptc:1.1.0`（电脑 ⇄ 手机双向互传版）。
- 发布端口：`0.0.0.0:9100 -> 9100/tcp`，Windows 监听进程由 WSLC 管理。
- 电脑入口：<http://localhost:9100>。
- 手机配对地址：`http://192.168.1.2:9100`（若 IP 变动可运行 `start.cmd` 自动刷新）。
- 未新增 portproxy，实际检查转发列表为空；无需绑定 Ubuntu IP。
- 支持功能：手机与电脑双向发送文字（支持链接识别与快捷键）、图片上传与预览、单文件与批量 ZIP 下载、显式结束会话。
- 会话生命周期与配额：单会话上限 10、空会话 120 秒失联宽限、内存 tmpfs 512 MiB、容器内存 768 MiB。

## 验证结果

原迁移已通过 Windows 局域网地址验证健康接口、配对、中文文字、图片上传、逐字节下载、ZIP、清空和断开。运行用户 uid/gid 1000，/data 和 /tmp 使用 tmpfs。MAX_SESSIONS=10 与当前 Compose 默认值一致。断开手机仍保留接收箱；现在可另行点击“结束会话”真正释放名额。

2026-10-25 生命周期修复版验证：`npm test` 44/44 通过，包含 mock clock 精确宽限边界、非空保护、并发容量、busy 409、慢请求撤销及 EPERM 删除失败恢复。原生 WSLC 构建并重建为 1.0.1，局域网 health/config 正常，容器 healthy。浏览器验证结束警告、成功清空页面及 sessionStorage、旧令牌 401；当时上限为 2，API 连续创建状态为 201/201/429；之后改为 10 并验证前 10 次 201、第 11 次 429，429 提供 Retry-After，页面显示手动重试倒计时；显式结束测试会话后重新生成二维码成功。测试会话已清理。用户后续确认真机完整传输验收通过；新版会话管理真实使用（含关页满 120 秒）与断外网验收已按要求跳过；用户决定按需手动启动，不配置自动启动／周期自动恢复。

2026-10-25 用户确认手机已成功配对，手机局域网入站与配对已完成实际验证；不再属于“仅电脑本机测试”。随后只读复查：容器 healthy，`http://192.168.1.3:9100/health` 返回 `{"ok":true}`，portproxy 列表为空，最近日志仅有 `LAN Drop listening on port 9100; HTTP trusted LAN only`，无报错或异常堆栈。应用不逐条记录配对、发送或传输正文，因此不会出现“手机配对成功”日志。

最新验收处置：用户确认 iPhone 完整传输流程通过；会话管理真实使用及断外网运行跳过；资源与安全边界后续评估忽略（并不表示安全保证已满足）。启动与故障恢复采用用户按需手动管理，不再作为自动化配置待办，见 [待办与操作建议](TODO.md) 和 [测试与验收记录](TESTING.md)。

Windows 局域网 IP 变化后仍需更新 PUBLIC_URL 并重建容器、生成新二维码；操作前先保存重要内容。本次消除的是 Ubuntu 内部 IP 变化所导致的手工转发依赖，不是电脑地址变化问题。

## 日常管理（Windows PowerShell）

```powershell
wslc list
wslc logs ptc
wslc stop ptc
wslc start ptc
# 启动后打开接收页
Start-Process 'http://localhost:9100'
```

### IP 变动或一键自适应启动

当电脑切换网络或路由器 DHCP 重新分配 IP 时，直接在项目目录双击运行 `start.cmd` 或在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

该脚本会自动检测当前活动的 Wi-Fi 局域网 IPv4 地址，并以最新的 `PUBLIC_URL` 重启 `ptc` 容器，无需手动排查与修改 IP。

本次未设置登录自动启动或故障自动重启。当前 WSLC run 帮助没有 Docker 的 --restart 选项，不承诺 unless-stopped 等价行为。用户已明确需要时手动启动，不配置任务计划程序或周期自动拉起；异常时手动查看状态与日志。

## 重建容器

以下操作会清空临时内容。PowerShell 不会像某些 Bash 环境那样改写 Linux 路径参数。

```powershell
wslc stop ptc
wslc rm ptc
wslc run -d --name ptc -p 0.0.0.0:9100:9100 -e PORT=9100 -e PUBLIC_URL=http://192.168.1.2:9100 -e DATA_DIR=/data -e MAX_SESSIONS=10 -e RECEIVER_GRACE_MS=120000 --tmpfs /data:size=512m,uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev --tmpfs /tmp:size=16m,mode=1777,noexec,nosuid,nodev -m 768m ptc:1.1.0
```

## 与原 Docker 部署的差异

保留非 root、临时内存存储、容量限制、768 MiB 内存限制和镜像健康检查。当前 WSLC CLI 未提供原 Compose 中 read_only、cap_drop、no-new-privileges、pids_limit、日志轮转以及 restart 策略对应选项，这些未等价迁移；因此不是安全加固配置完全一致的替换。仅适用于可信局域网，不要向公网暴露。

引擎启动提示：`Your kernel does not support swap limit capabilities or the cgroup is not mounted. Memory limited without swap.` 容器已正常启动，但不应将内存设置理解成 swap 也受限。

导入镜像归档 lan-drop-wslc-image.tar 仍在项目目录，未在此次引擎镜像清理中删除。Ubuntu Docker Engine 的旧 lan-drop 镜像及容器已删除。未卸载 Docker、未关闭其他 WSL 服务；清理后当前 WSLC 服务健康接口仍返回 {"ok":true}。
