# ListenTogether 工作计划

> 更新时间：2026-02-18

## 一、今日已完成

### 同步引擎重写 (v0.4.0 → v0.5.0 → v0.5.1)
- Lookahead scheduler 替代一次性排完所有segment（1.5s窗口，200ms刷新）
- 5ms crossfade消除segment拼接噪声
- Soft drift correction（10-100ms）：调整_nextSegTime，零glitch
- Hard resync（>100ms）：stop+replay，指数退避防抖（1.5s→10s）
- Soft correction累积上限±500ms，超过强制hard resync
- 服务端syncTick每1s广播权威播放位置
- 时钟同步激进调参：16-burst/40ms，300ms间隔，10s过期，top-3 min-RTT

### 并发安全修复
- Client.Send() + sync.Mutex 统一WebSocket写锁
- safeWrite/safePing：加入房间前用connMu，加入后走Client.mu（消除双锁问题）
- syncTick：先复制clients列表，释放锁后再发送（不在读锁内做I/O）
- cleanupLoop/CloseRoomsByOwnerID：两阶段模式（收集→释放锁→通知），消除死锁风险
- rateLimiter：每10分钟定期清理过期entries
- ClockSync ping：2秒超时自动清除_pending
- _scheduleAhead重入保护（_scheduling flag + try/finally）
- correctDrift在_resyncing期间跳过
- _resyncGen generation counter

### 代码审查
- 三轮opus agent审查（同步算法+并发安全），所有发现已修复
- 一轮opus agent API安全审查，结果已存档待修复
- code-review skill已创建（4种模式：general/security/concurrency/sync）

### 其他
- 僵尸进程reaper（C语言subreaper wrapper）
- Git commits: a26d975(v0.4.0), d39e31a(v0.4.1), 06e9c80(v0.4.2), 23d2cec(v0.5.0), ec62a7c(v0.5.1)

## 二、未完成/待修复

### API安全漏洞（按优先级）

#### 🔴 紧急
1. **路径遍历** — `ServeSegmentFile`的userID/quality参数未校验，可构造`../../../etc`读任意文件
   - 文件：`internal/library/handlers.go` L359
   - 改法：userID只允许数字，quality白名单，audioID只允许UUID
2. **登录无限流** — `/api/auth/login`无速率限制，可暴力破解
   - 文件：`internal/auth/handlers.go` L113
   - 改法：复用rateLimiter，5次/分钟/IP
3. **播放列表越权** — RemoveItem/Reorder/UpdateMode无权限校验
   - 文件：`internal/library/handlers.go` L553/L595/L640
   - 改法：校验操作者是playlist创建者或房间owner或admin

#### 🟡 重要
4. **Cookie Secure=false** — HTTPS下token明文泄露
   - 改法：环境变量`SECURE_COOKIE=true`控制
5. **WebSocket CheckOrigin全放行** — 跨站WebSocket劫持
   - 改法：Origin白名单校验
6. **X-Forwarded-For可伪造** — 绕过速率限制
   - 改法：只取最后一个IP或直接用RemoteAddr

#### 🟢 加固
7. 音频文件访问无权限校验
8. 播放列表创建无权限控制
9. 默认密码admin123无强制修改机制
10. logout应限制为POST方法

### 代码质量
11. **performance.now() vs Date.now()混用** — NTP跳变时offset计算可能出错
    - sync.js的offset计算应统一用performance.now()
12. **播放结束检测精度** — UI interval 250ms检测，最多250ms延迟
13. **syncTick频率** — 1s可能偏高，2-3s足够（可配置化）

### 功能待办
14. WebSocket握手时验证JWT
15. 安全的音质升级策略（segment边界切换）
16. README中英文 + 部署文档

## 三、当前部署状态

- **线上版本**：v0.5.0 (commit 23d2cec) — 同步效果完美，不要轻易替换
- **本地版本**：v0.5.1 (commit ec62a7c) — 包含第三轮审查修复，已编译未部署
- **运行地址**：frp-bar.com:45956
- **下次部署建议**：先在本地测试v0.5.1确认同步效果无退化，再替换线上版本
