# 交接文档（HANDOFF）

更新时间：2026-11-08。面向接手的开发者／代理，读完本文即可继续工作，无需历史对话上下文。

## 一句话现状

项目已开发完成、真机验收通过、推送到 GitHub，并正以 Windows 原生 WSLC 容器形式在本机 `9100` 端口稳定运行（健康检查通过）。当前没有进行中的开发任务，只有若干已知遗留项。

## 仓库与目录

- 代码目录：`C:/Users/18883/IdeaProjects/test/phone-pc-transfer`（由 `lan-drop` 改名而来）
- 远程仓库：<https://github.com/Tticc/phone-pc-transfer>，分支 `main`，首个提交 `f0a442e`
- 许可证：MIT（`LICENSE`，`package.json` 已声明）
- 未纳入版本库：`node_modules/`、`artifacts/`、`lan-drop-wslc-image.tar`、`compose.wsl.yaml`（本机私有）、`.env*`（除 `.env.example`）

## 技术栈与文件职责

- `server.js`：唯一后端，Node.js ≥22 原生 `http`，无框架。API：`/health`、`/api/config`、`/api/sessions`、`/api/pair`、`/api/session`、`/api/text`、`/api/images`、`/api/files/:id`、`/api/archive`、`/api/items`、`/api/disconnect`、`/api/sender/disconnect`
- `public/index.html` + `public/receiver.js`：手机接收页（二维码配对、轮询、文字安全展示、图片预览／下载、ZIP、清空、结束会话）
- `public/send.html` + `public/sender.js`：电脑发送页（fragment 凭证、文字、图片上传进度与重试、断开手机）
- `public/style.css`：响应式样式，无外部资源（离线可用）
- `test/server.test.js`：唯一测试文件，44 项
- `Dockerfile`、`compose.yaml`、`.dockerignore`、`compose.wsl.yaml`（本机）
- 文档：`README.md`（概览）、`docs/DEPLOYMENT.md`（通用部署与环境变量）、`DEPLOY.md`、`DEPLOYED-WSLC.md`（**当前部署事实来源**）、`DEPLOYED-WSL.md`（历史）、`TESTING.md`（测试与验收记录）、`TODO.md`（待办与操作建议）
- `deploy-smoke.mjs`：对运行中实例做端到端冒烟（配对→文字→图片→下载→ZIP→清空→断开）

## 运行中的部署（WSLC）

- 容器 `phone-pc-transfer`，镜像 `phone-pc-transfer:1.0.1`，状态 healthy，端口 `0.0.0.0:9100 -> 9100/tcp`
- 电脑入口 <http://localhost:9100>；手机配对地址 `http://192.168.1.3:9100`（`PUBLIC_URL` 决定二维码内容）
- 运行时参数：`PORT=9100`、`DATA_DIR=/data`、`MAX_SESSIONS=10`、`RECEIVER_GRACE_MS=120000`、`--tmpfs /data:size=512m,uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev`、`--tmpfs /tmp:size=16m,mode=1777,...`、`-m 768m`
- 无 portproxy、无新增防火墙规则；仅可信局域网使用，不可暴露公网
- WSLC 3.0.3.0 没有 `read_only`、`cap_drop`、`no-new-privileges`、`pids_limit`、日志轮转、`restart` 的等价选项，这些**未**从 Compose 等价迁移

```powershell
wslc list
wslc logs phone-pc-transfer
wslc start phone-pc-transfer   # 仅在停止时
wslc stop phone-pc-transfer
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
npm test        # node --test，44/44 通过（约 1 秒）
node deploy-smoke.mjs http://localhost:9100   # 需先替换脚本内的 publicUrl 断言
```

注意：在本目录用 `node --test test/` 会因参数解析失败，请用 `npm test`。

## 已知遗留（可做但不紧急）

- 页面品牌仍是「LAN Drop」，`sessionStorage` 键仍是 `lan-drop-receiver`，未随项目改名统一（已在 `DEPLOYED-WSLC.md` 注明）
- `package.json` 版本仍是 `1.0.0`，而镜像 tag 为 `1.0.1`，未对齐
- `deploy-smoke.mjs` 把 `publicUrl` 硬编码为 `http://192.168.1.3:9100`，换网络后需同步
- 本地仍保留 `lan-drop-wslc-image.tar` 旧镜像归档（已 gitignore），可删
- `compose.wsl.yaml` 为本机私有覆盖文件，未入库
- LICENSE 版权署名是占位「2026 Phone PC Transfer contributors」

## 用户已决定跳过／忽略（不要重新当作待办）

- 新版会话管理的真实使用验收（关页等待 120 秒回收、后台节流、断网恢复）
- 断互联网（保留 Wi-Fi）端到端验收
- 资源压力与安全加固差异的后续评估（忽略 ≠ 已通过）
- 自动启动／周期自动恢复（改为按需手动管理）

## 接手第一步建议

1. `wslc list` + `Invoke-RestMethod http://localhost:9100/health` 确认服务在跑
2. `npm test` 确认 44/44
3. 读 `DEPLOYED-WSLC.md` 与 `TESTING.md` 了解当前事实与历史结论
4. 若要改代码：先改 `server.js` + `test/server.test.js`，再动 `public/`，最后按 `DEPLOYED-WSLC.md` 重建镜像并冒烟
