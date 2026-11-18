# 交接文档（HANDOFF）

更新时间：2026-11-08。面向接手的开发者／代理，读完本文即可继续工作，无需历史对话上下文。

## 一句话现状

项目已完成**电脑与手机双向互传迭代（v1.1.0）**，自动化测试 45 项全部通过，部署冒烟验收通过，正以 Windows 原生 WSLC 容器形式在本机 `9100` 端口稳定运行（健康检查通过）。

## 仓库与目录

- 代码目录：`C:/Users/18883/IdeaProjects/test/phone-pc-transfer`
- 远程仓库：<https://github.com/Tticc/phone-pc-transfer>，分支 `main`
- 许可证：MIT（`LICENSE`，`package.json` 已声明）
- 未纳入版本库：`node_modules/`、`artifacts/`、`lan-drop-wslc-image.tar`、`compose.wsl.yaml`（本机私有）、`.env*`（除 `.env.example`）

## 技术栈与文件职责

- `server.js`：唯一后端，Node.js ≥22 原生 `http`，无框架。支持电脑 ⇄ 手机双向鉴权发送与接收。API：`/health`、`/api/config`、`/api/sessions`、`/api/pair`、`/api/session`、`/api/text`、`/api/images`、`/api/files/:id`、`/api/archive`、`/api/items`、`/api/disconnect`、`/api/sender/disconnect`
- `public/index.html` + `public/receiver.js`：电脑传输页（二维码配对、发送文字/图片给手机、接收与轮询手机内容、图片预览与下载、ZIP、清空、结束会话）
- `public/send.html` + `public/sender.js`：手机传输页（扫码凭证、发送文字/图片、实时同步接收电脑发来的内容与一键复制、图片预览与下载）
- `public/style.css`：响应式样式，含设备来源标记（电脑发送/手机发送），离线可用
- `test/server.test.js`：唯一测试文件，45 项全部通过
- `Dockerfile`、`compose.yaml`、`.dockerignore`、`compose.wsl.yaml`（本机）
- 文档：`README.md`（概览）、`docs/DEPLOYMENT.md`、`DEPLOY.md`、`DEPLOYED-WSLC.md`（**当前部署事实来源**）、`TESTING.md`、`TODO.md`
- `deploy-smoke.mjs`：对运行中实例做端到端双向冒烟（配对→手机发图文→电脑下载→电脑发图文→手机接收下载→ZIP→清空→安全结束）

## 运行中的部署（WSLC）

- 容器 `ptc`，镜像 `ptc:1.1.0`（含 `ptc:latest`），状态 healthy，端口 `0.0.0.0:9100 -> 9100/tcp`
- 电脑入口 <http://localhost:9100>；手机配对地址 `http://192.168.1.2:9100`（`PUBLIC_URL` 决定二维码内容；若 IP 变化可运行 `start.cmd` 自动检测）
- 运行时参数：`PORT=9100`、`DATA_DIR=/data`、`MAX_SESSIONS=10`、`RECEIVER_GRACE_MS=120000`、`--tmpfs /data:size=512m,uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev`、`--tmpfs /tmp:size=16m,mode=1777,...`、`-m 768m`
- 无 portproxy、无新增防火墙规则；仅可信局域网使用，不可暴露公网
- WSLC 3.0.3.0 没有 `read_only`、`cap_drop`、`no-new-privileges`、`pids_limit`、日志轮转、`restart` 的等价选项，这些**未**从 Compose 等价迁移

```powershell
wslc list
wslc logs ptc
wslc start ptc   # 仅在停止时
wslc stop ptc
Invoke-RestMethod http://localhost:9100/health
```

重建会清空临时内容（见 `DEPLOYED-WSLC.md` 的 `wslc rm` + `wslc run` 完整命令）。**不配置开机自启或自动重启**——这是用户明确决定，异常时手动排查。

## 关键设计约束（改动前必须理解）

1. **两段凭证**：接收页持有 `receiverToken`（可读、可删、可结束），发送页持有 `senderToken`（只能写、只能断开自己）。令牌只存在于 URL fragment，前端立即从地址栏清除。
2. **一次性配对码**：`POST /api/pair` 用后即废，有效期 5 分钟；二维码里是配对地址 + fragment。
3. **会话容量与名额**：`MAX_SESSIONS=10`；满额返回 429 + `Retry-After`，页面显示手动重试倒计时。
4. **生命周期**：只有显式 `DELETE /api/session`（接收端鉴权）才立即释放名额；空会话在接收端失联 `RECEIVER_GRACE_MS=120000` 后回收；**有内容**的会话保留到原闲置期限（30 分钟）；轮询**不**延长业务 idle；不依赖 `unload`/`beforeunload` 删除。
5. **删除失败可恢复**：物理清理失败时保留 retired 记录、继续占用名额并定时重试，不做「删了但配额泄漏」的处理。
6. **配额**（十进制）：文字 100000 码点、单文件 50,000,000 字节、单批 20 个、单会话 200,000,000 字节。上传超额时逐块计数并在 drain 后回滚，不会挂起连接。
7. **存储**：全部在 tmpfs 内存盘；容器／进程重启即丢失，配对需重建。
8. **无持久化、无历史**：两端必须前台在线；不做离线收件箱。

## 测试

```bash
npm test                                         # node --test，45/45 全部通过（约 0.8 秒）
node deploy-smoke.mjs http://localhost:9100       # 端到端双向冒烟通过
```

注意：在本目录用 `node --test test/` 会因参数解析失败，请用 `npm test`。

## 已知遗留与优化建议

- 本地仍保留 `lan-drop-wslc-image.tar` 旧镜像归档（已 gitignore），可按需删除以释放磁盘
- `compose.wsl.yaml` 为本机私有覆盖文件，未入库
- LICENSE 版权署名是占位「2026 Phone PC Transfer contributors」

## 用户已决定跳过／忽略（不要重新当作待办）

- 新版会话管理的真实使用验收（关页等待 120 秒回收、后台节流、断网恢复）
- 断互联网（保留 Wi-Fi）端到端验收
- 资源压力与安全加固差异的后续评估（忽略 ≠ 已通过）
- 自动启动／周期自动恢复（改为按需手动管理）

## 接手第一步建议

1. `wslc list` + `Invoke-RestMethod http://localhost:9100/health` 确认服务在跑
2. `npm test` 确认 45/45
3. 读 `DEPLOYED-WSLC.md` 与 `TESTING.md` 了解当前事实与历史结论
4. 若要改代码：先改 `server.js` + `test/server.test.js`，再动 `public/`，最后按 `DEPLOYED-WSLC.md` 重建镜像并冒烟
