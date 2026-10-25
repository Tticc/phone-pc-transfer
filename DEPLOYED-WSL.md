# 当前 WSL 部署记录

2026-10-25：默认端口已统一调整为 **9100**，已实际构建并部署。

- WSL 发行版：Ubuntu-24.04（WSL2，NAT）。
- Docker Engine：29.8.2；Docker Compose：5.6.0。
- 容器：`lan-drop-lan-drop-1`，镜像 `lan-drop:1.0.0`，已检查 healthy。
- 端口：WSL `0.0.0.0:9100` → 容器 `9100`。
- 非 root：容器进程 uid/gid 1000（node）。
- Windows 电脑入口：<http://localhost:9100>，已实际验证。
- 二维码配置入口：`http://192.168.1.3:9100`；**Windows 端口转发尚未配置，手机当前不能据此访问**。
- WSL 当前 eth0 IP：`172.25.16.61`；重启 WSL 后可能变化。

已通过容器实际接口完成配对、中文文字、图片上传、原字节下载、ZIP、清空、断开；24 项回归测试通过。测试会话内容已清空。Docker/WSL 本机验证补充并取代 [旧测试记录](TESTING.md) 中“Docker 不可用、容器未测”的历史限制；iPhone、实际局域网和断外网测试仍未完成。完整安全与网络说明见 [部署指南](docs/DEPLOYMENT.md)。

## 日常管理（WSL 中执行）

本机设置保存在 [本机 Compose 覆盖配置](compose.wsl.yaml)，无需读取或修改本地环境文件；显式覆盖避免旧 PORT/PUBLIC_URL 环境值影响此次部署。

```bash
cd /mnt/c/Users/18883/IdeaProjects/test/lan-drop
docker compose -p lan-drop -f compose.yaml -f compose.wsl.yaml up -d --build
docker compose -p lan-drop -f compose.yaml -f compose.wsl.yaml ps
docker compose -p lan-drop -f compose.yaml -f compose.wsl.yaml logs --tail=50
# 停止（临时内容会丢失）
docker compose -p lan-drop -f compose.yaml -f compose.wsl.yaml down
```

## 手机访问还需管理员操作

当前 Windows 进程未提升权限。实际尝试添加 portproxy 返回 `The requested operation requires elevation (Run as administrator).`，因此未添加转发，也未继续添加防火墙规则。未请求 UAC 提升、未关闭防火墙或修改全局网络模式。

在 **Windows 管理员 PowerShell** 人工执行（先核对 Wi-Fi 和 WSL IP 未变化）：

```powershell
netsh interface portproxy add v4tov4 listenaddress=192.168.1.3 listenport=9100 connectaddress=172.25.16.61 connectport=9100 protocol=tcp
New-NetFirewallRule -DisplayName 'LAN Drop TCP 9100' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.1.3 -LocalPort 9100 -Profile Private -RemoteAddress LocalSubnet
```

然后在同一可信 Wi-Fi 的 iPhone Safari 打开 <http://192.168.1.3:9100/health>，应看到 `{"ok":true}`，再扫描电脑接收页二维码。不能仅用 Windows 本机成功代替手机验证。WSL IP 变化后更新 portproxy；Windows Wi-Fi IP 变化后还需更新规则与本机 Compose 覆盖配置，并重新创建容器。勿暴露到公网。
