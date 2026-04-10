# ListenTogether 项目继续文档

> 最后更新：2026-04-10 22:33 GMT+8
> 状态：开发调试阶段，核心同步已实现，存在播放跳变问题

---

## 项目概述

**ListenTogether（一起听）**：实时同步听歌平台，目标同步精度 <30ms

**技术栈**：
- 后端：Go + WebSocket + ffmpeg
- 前端：Web Audio API + AudioWorklet + SharedArrayBuffer
- 同步算法：NTP-like clock sync + Snapcast-style drift correction

**核心架构**：方案B - worklet Ring Buffer
- Phase 1-4 已完成
- SharedArrayBuffer 实现零延迟读取 consumed frames
- Soft/hard correction 分层纠正机制

---

## 测试服务器

| 项目 | 值 |
|------|-----|
| IP | `107.172.234.183` |
| HTTPS端口 | `8443` |
| HTTP端口 | `8080`（重定向到HTTPS） |
| 用户 | `root` |
| 密码 | `wlLz9bmS96NUR7M2p6` |

**SSH连接**：
```bash
ssh root@107.172.234.183
```

**部署命令**：
```bash
cd /root/listen-together
go build -o listen-together .
pkill -9 listen-together  # 停止旧进程
nohup ./listen-together > /tmp/listen-together.log 2>&1 &  # 启动
```

**查看日志**：
```bash
tail -50 /tmp/listen-together.log
```

**测试地址**：
- https://107.172.234.183:8443/
- 需要登录账号（使用已有账号或注册）

---

## 当前状态

### Git分支

```
Branch: snapcast-sync-refactor
Remote: https://github.com/xingzihai/listen-together
Latest commits:
  - 40fbfe9: docs: 记录手机端播放问题
  - f8c8c4e: fix: segment重复feed导致30秒/50秒跳跃问题
  - 49ab44f: docs: 添加修复文档
```

### 已完成

| 任务 | 状态 |
|------|------|
| COOP/COEP Headers（SharedArrayBuffer支持） | ✅ |
| AudioWorklet + Ring Buffer | ✅ |
| SharedArrayBuffer consumed读取 | ✅ |
| Clock sync (NTP-like) | ✅ |
| Soft/hard drift correction | ✅ |
| Segment重复feed修复 | ✅ |
| 30秒/50秒跳跃修复 | ✅ |

### 遗留问题（重要）

#### 问题1：桌面端仍有小跳跃（中等优先级）

**现象**：播放过程中偶尔有轻微跳跃，不影响整体听感

**可能原因**：
- drift纠正触发hard resync时重新feed segment
- worklet ring buffer overflow处理逻辑
- segment加载延迟导致短暂underrun
- `_feedLoop` 的buffer计算逻辑

**排查方法**：
- 观察控制台 `[feed]` 日志，看跳跃发生时feed了哪些segment
- 观察 `[sync] ABNORMAL DRIFT` 日志，看drift是否超过阈值
- 观察 `HARD_RESYNC` 日志，确认是否频繁触发硬重同步

#### 问题2：手机端完全无法播放（高优先级）

**现象**：手机端播放时一直在跳变，无法正常听音乐

**可能原因**：
1. **SharedArrayBuffer兼容性**：部分手机浏览器不支持或实现有问题
2. **AudioWorklet差异**：Safari Mobile / Chrome Mobile 实现不同
3. **CPU性能**：手机worklet处理延迟，导致buffer underrun
4. **网络延迟**：手机网络segment加载不及时
5. **页面visibility**：触屏交互导致频繁后台切换

**排查方法**：
- 检查控制台是否有 `[sync] SharedArrayBuffer initialized`
- 检查 `_sabSupported` 是否为 `false`（fallback模式）
- 如果是fallback，检查 postMessage stats 是否正常更新

**调试方案**：
手机端调试困难，建议：
1. 在PC浏览器模拟手机模式测试
2. 使用 `vConsole` 或类似方案在手机上显示控制台
3. 在服务器日志中查看 `[sync] client xxx drift xxx ms forcing resync`

---

## 关键代码位置

### 前端核心文件

| 文件 | 功能 | 关键函数 |
|------|------|---------|
| `web/static/js/player.js` | 播放器核心 | `_feedPCMSegments`, `_driftLoop`, `getCurrentTime` |
| `web/static/js/worklet-processor.js` | AudioWorklet处理器 | `process()`, `_onMessage()` |
| `web/static/js/sync.js` | 时钟同步 | `ClockSync`, `ping/pong`, `getServerTime()` |
| `web/static/js/app.js` | UI控制 | WebSocket消息处理，播放控制 |

### 后端核心文件

| 文件 | 功能 |
|------|------|
| `main.go` | WebSocket handler，syncTick广播 |
| `internal/room/room.go` | 房间管理 |
| `internal/sync/sync.go` | 服务器时间 |

### 关键状态变量（player.js）

```javascript
// Segment feed tracking（防止重复）
this._fedSegEnd = -1;  // 已feed的最远segment索引

// Anchor tracking（位置基准）
this._anchorPos = 0;   // 锚点位置
this._anchorServerTime = 0;  // 锚点服务器时间
this._anchorConsumedBase = 0;  // 锚点时刻的consumed基线

// SharedArrayBuffer（零延迟读取）
this._sharedView = null;  // BigInt64Array over SAB

// Drift correction
this._maxCorrectionRate = 0.0005;  // ±0.05%
```

---

## 核心算法说明

### 1. Segment Feed去重机制

**问题**：之前的bug是重复feed相同segment导致跳跃

**解决**：
```javascript
// 只feed _fedSegEnd + 1 之后的新segment
const actualStartSeg = Math.max(startSeg, this._fedSegEnd + 1);
for (let i = actualStartSeg; i < endSeg; i++) {
    // feed PCM
    this._fedSegEnd = Math.max(this._fedSegEnd, i);
}
```

### 2. getCurrentTime() 计算公式

```javascript
// Snapcast公式：position = anchorPos + (consumed - base) / sampleRate
const consumed = Number(Atomics.load(this._sharedView, 0));
const consumedDelta = consumed - this._anchorConsumedBase;
const pos = this._anchorPos + consumedDelta / this._nominalRate;
```

**关键**：用 `consumedDelta` 而非 `consumed`，因为anchor可能在播放中途重设

### 3. Drift检测与纠正

```javascript
// 漂移计算
const expectedPos = this._anchorPos + elapsedSec;
const actualPos = this.getCurrentTime();
const drift = actualPos - expectedPos;

// 分层纠正
if (absDrift > 0.5) {      // >500ms: hard resync
    // 重设anchor，重新feed segment
}
if (absDrift > 0.1) {      // 100-500ms: medium correction
    // 更强的soft correction（±0.2%）
}
if (absDrift > 0.001) {    // >1ms: soft correction
    // 每N帧drop/duplicate 1帧（±0.05%）
}
```

---

## 下一步待办

### 优先级排序

| 优先级 | 任务 | 预估工时 |
|--------|------|----------|
| 🔴 P0 | 手机端播放问题排查与修复 | 2-4h |
| 🟡 P1 | 桌面端小跳跃优化 | 1-2h |
| 🟢 P2 | 多设备同步测试 | 1h |
| 🟢 P2 | 长时间播放稳定性测试 | 2h |

### 手机端排查建议步骤

1. **确认SharedArrayBuffer支持**
   - 检查COOP/COEP headers是否正确返回
   - 检查 `_sabSupported` 变量
   - 如果不支持，确认fallback模式是否正常

2. **检查AudioWorklet**
   - 确认 worklet-processor.js 正常加载
   - 确认 `process()` 函数正常调用（看buffered stats）

3. **检查网络延迟**
   - 手机网络可能延迟更高
   - 增加preload segment数量或提前加载

4. **检查页面visibility**
   - 触屏可能导致频繁visibilitychange
   - 检查 `document.addEventListener('visibilitychange')` 处理

### 可能的修复方向

**方向A：优化fallback模式**
- 如果手机不支持SAB，需要更高效的postMessage
- 减少stats报告间隔（从100ms降到20ms）

**方向B：增加buffer size**
- 手机CPU慢，需要更大的ring buffer
- 当前10秒，可增加到15-20秒

**方向C：更保守的feed策略**
- 提前更多segment，减少underrun概率
- 增加preloadCount从5到8

**方向D：禁用hard resync**
- 手机端可能因为drift频繁触发hard resync
- 考虑只使用soft correction，或者增加cooldown时间

---

## 调试工具

### 快速测试脚本

项目目录下有多个调试脚本（已忽略到git）：

```bash
# Windows本机
python upload_fix.py  # 上传player.js到服务器并重启

# 服务器端
python check_drift.py  # 检查drift状态
python diagnose.py     # 诊断脚本
```

### 关键日志

**前端控制台**：
- `[sync]` — 同步相关日志
- `[feed]` — segment feed日志（修复后新增）
- `[sync] ABNORMAL DRIFT` — 漂移超过50ms警告
- `[sync] HARD_RESYNC` — 硬重同步触发

**服务器日志**：
- `[sync] client xxx drift xxx ms forcing resync` — 客户端漂移过大
- `[JWT]` — 认证相关

### API调试端点

```bash
# 自动播放测试（需先上传音频）
curl https://107.172.234.183:8443/api/debug/auto-play

# 查看状态
curl https://107.172.234.183:8443/api/debug/status

# 查看日志
curl https://107.172.234.183:8443/api/debug/log
```

---

## 相关文档

| 文档 | 位置 | 内容 |
|------|------|------|
| 同步架构设计 | `SYNC-DESIGN.md` | Snapcast架构详细设计 |
| 同步规则 | `SYNC_RULES.md` | 同步算法核心原则 |
| 修复记录 | `docs/fix-2026-04-10-segment-duplicate.md` | Segment重复feed修复 |
| Roadmap | `ROADMAP.md` | 项目路线图 |

---

## 工作区目录

```
D:\autoclaw_workspace\listen-together\
├── web/static/js/          # 前端代码
│   ├── player.js           # 播放器核心（主要修改点）
│   ├── worklet-processor.js # AudioWorklet
│   ├── sync.js             # 时钟同步
│   └── app.js              # UI控制
├── main.go                 # 后端入口
├── internal/               # 后端模块
├── docs/                   # 文档
├── upload_fix.py           # 上传脚本（本机）
└── CONTINUE.md             # 本文档
```

---

## 快速恢复指南

下次session开始时：

1. **读取本文档** — 了解项目状态
2. **读取 MEMORY.md** — 工作区全局记忆
3. **检查服务器状态**：
   ```bash
   ssh root@107.172.234.183 "pgrep -a listen-together"
   ```
4. **查看最新日志**：
   ```bash
   ssh root@107.172.234.183 "tail -30 /tmp/listen-together.log"
   ```
5. **确定下一步任务** — 根据优先级选择P0/P1/P2

---

## 注意事项

1. **不要在根目录创建文件** — 所有新文件放在项目子目录
2. **修改前端代码后记得部署** — 用 `upload_fix.py` 或手动scp
3. **手机端测试需要真机** — 模拟器可能无法复现问题
4. **SharedArrayBuffer需要HTTPS+COOP/COEP** — 本地测试需要配置
5. **服务器密码已明文记录** — 测试服务器，无需加密

---

**如有疑问，检查相关文档或询问用户。祝开发顺利！**