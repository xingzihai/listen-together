# ListenTogether 同步算法重设计：服务器权威模式

> **分支**: `exp/server-authority-sync`
> **日期**: 2026-02-21
> **状态**: 实验性

## 实验概述

### 背景
当前同步架构采用客户端自治三层纠正（soft correction → playbackRate → hard reset），存在以下问题：
1. 三层纠正互相干扰，可能振荡
2. 累积状态（_driftOffset、_pendingDriftCorrection等）一旦被污染，纠正方向错误，越修越偏
3. 断线重连后旧anchor仍在，无法恢复同步
4. 系统鲁棒性极差——非正常状态下一旦不同步就永远不同步

### 核心思路
- **关键时刻精准同步**：play/seek/pause/切歌时，scheduledAt硬件预约起播
- **播放中信任设备时钟**：服务器每秒发权威位置，客户端只算偏差不纠正
- **连续偏差触发重置**：连续3次超150ms → playAtPosition强制重置
- **没有微调，没有playbackRate，没有累积状态**——只有"没事"和"重置"

### 核心哲学
> **只有"没事"和"重置"两个状态。没有微调，没有playbackRate，没有累积状态。**

### 验收标准
1. **正常播放**：两台设备同步偏差稳定在50ms以内
2. **操作同步**：play/pause/seek/切歌后1秒内所有客户端对齐
3. **断线恢复**：断开WiFi 10秒后重连，3秒内恢复同步
4. **后台恢复**：页面切到后台30秒后切回，1秒内恢复同步
5. **无振荡**：不出现反复重置（重置风暴）
6. **长时间稳定**：连续播放30分钟不出现累积偏差

### 回滚方案
如果实验失败，切回 `feature/mobile-ui` 分支即可恢复旧同步逻辑。

---

## 1. 消息协议

### 1.1 服务器 → 客户端

#### `play`
关键时刻同步：play/resume/切歌后自动播放。所有客户端在 `scheduledAt` 时刻同时起播。

```json
{
  "type": "play",
  "position": 42.5,           // 起播位置（秒），从此处开始播放
  "serverTime": 1740000000000, // 服务器当前时间（ms），用于 elapsed 回退计算
  "scheduledAt": 1740000000800, // 所有客户端必须在此服务器时间点起播（ms）
  "trackAudio": { ... },       // 可选，补发 trackAudio 给错过 trackChange 的客户端
  "trackIndex": 2              // 当前曲目索引
}
```

#### `pause`
```json
{
  "type": "pause",
  "position": 42.5,           // 暂停时的精确位置（秒）
  "serverTime": 1740000000000
}
```

#### `seek`
seek 期间如果正在播放，等同于 play（带 scheduledAt）；如果暂停中，仅更新位置。

```json
{
  "type": "seek",
  "position": 120.0,
  "serverTime": 1740000000000,
  "scheduledAt": 1740000000800  // 仅播放中才有
}
```

#### `syncTick`
服务器每秒广播一次权威位置。客户端用于偏差检测，不用于纠正。

```json
{
  "type": "syncTick",
  "position": 43.5,           // 服务器计算的当前播放位置（秒）
  "serverTime": 1740000001000  // 发送此 tick 时的服务器时间（ms）
}
```

#### `forceResync`
服务器主动要求客户端强制重置（statusReport 检测到大偏差时）。

```json
{
  "type": "forceResync",
  "position": 43.5,           // 服务器权威位置
  "serverTime": 1740000001000,
  "scheduledAt": 1740000001500 // 可选，给客户端预留加载时间
}
```

#### `trackChange`
切歌时广播，客户端加载新曲目。

```json
{
  "type": "trackChange",
  "trackIndex": 3,
  "trackAudio": {
    "audio_id": 42,
    "owner_id": 1,
    "audio_uuid": "abc-def",
    "filename": "song.flac",
    "title": "歌曲名",
    "artist": "艺术家",
    "original_name": "song.flac",
    "duration": 240.5,
    "qualities": ["low", "medium", "high", "lossless"]
  },
  "serverTime": 1740000000000
}
```

#### `forceTrack`
客户端在错误曲目上时，服务器强制纠正。

```json
{
  "type": "forceTrack",
  "trackIndex": 3,
  "trackAudio": { ... },
  "position": 43.5,
  "serverTime": 1740000001000
}
```

#### `pong`
时钟同步响应。

```json
{
  "type": "pong",
  "clientTime": 1740000000000,  // 回传客户端发送时间
  "serverTime": 1740000000005   // 服务器处理时间
}
```

### 1.2 客户端 → 服务器

#### `ping`
```json
{
  "type": "ping",
  "clientTime": 1740000000000  // Date.now()
}
```

#### `play` (Host only)
```json
{
  "type": "play",
  "position": 0.0  // 起播位置
}
```

#### `pause` (Host only)
```json
{ "type": "pause" }
```

#### `seek` (Host only)
```json
{
  "type": "seek",
  "position": 120.0
}
```

#### `statusReport`
客户端每 2 秒上报一次实际播放状态。

```json
{
  "type": "statusReport",
  "position": 43.2,    // 客户端实际播放位置（秒）
  "trackIndex": 2       // 当前曲目索引
}
```

#### `nextTrack` (Host only)
```json
{
  "type": "nextTrack",
  "trackIndex": 3
}
```

---

## 2. 服务器端算法

### 2.1 权威位置计算与维护

服务器维护每个房间的播放状态（已有，保持不变）：

```go
type Room struct {
    State      PlayState  // StateStopped / StatePlaying / StatePaused
    Position   float64    // 锚点位置（秒）
    StartTime  time.Time  // 锚点对应的墙钟时间
    // ...
}
```

**权威位置公式**（任意时刻）：
```
if State == StatePlaying:
    currentPos = Position + time.Since(StartTime).Seconds()
    currentPos = min(currentPos, duration)  // 不超过歌曲时长
else:
    currentPos = Position
```

**状态转换**：
- `Play(pos)`: State=Playing, Position=pos, StartTime=now
- `Pause()`: Position=Position+elapsed, State=Paused, 返回 Position
- `Seek(pos)`: Position=pos, if Playing then StartTime=now

这些与当前实现一致，无需修改。

### 2.2 syncTick 广播逻辑

**频率**：每 1 秒（当前已实现，保持不变）

**发送条件**：
- 房间状态为 `StatePlaying`
- 房间内客户端数 > 1（单人房间不需要同步）

**发送对象**：
- 所有非 Host 客户端（Host 是时间源，不需要 syncTick）
- **变更**：当前实现已跳过 Host，保持不变

**内容**：
```go
msg := map[string]interface{}{
    "type":       "syncTick",
    "position":   currentPos,    // 服务器权威位置
    "serverTime": sync.GetServerTime(),
}
```

**无变更**：当前 syncTick goroutine 逻辑完全正确，保持原样。

### 2.3 statusReport 处理逻辑

收到客户端 statusReport 后：

1. **曲目检查**（已有，保持）：
   - 如果 `msg.TrackIndex != serverTrackIdx`，发送 `forceTrack`

2. **位置偏差检查**（已有，微调阈值）：
   - 仅在 `StatePlaying` 时检查
   - 计算 `drift = |clientPos - expectedPos|`
   - **阈值从 400ms 改为 500ms**（因为客户端自己会在 150ms×3 时重置，服务器只做兜底）
   - 超阈值时发送 `forceResync`（不带 scheduledAt，客户端立即重置）

```go
if drift > 0.5 {
    log.Printf("[sync] client %s drift %.0fms — forcing resync", clientID, drift*1000)
    myClient.Send(map[string]interface{}{
        "type":       "forceResync",
        "position":   expectedPos,
        "serverTime": syncpkg.GetServerTime(),
    })
}
```

### 2.4 play/pause/seek/切歌同步流程

#### Play（Host 按下播放）
1. 服务器 `room.Play(position)`
2. 计算 `scheduledAt = now + 800ms`（给所有客户端预留网络传输+segment加载时间）
3. 广播 `play` 消息给所有客户端（包括 Host 自己）
4. 附带 `trackAudio` 和 `trackIndex`（补发给可能错过 trackChange 的客户端）

**无变更**：当前实现已正确，保持原样。

#### Pause（Host 按下暂停）
1. 服务器 `room.Pause()` 返回精确位置
2. 广播 `pause` 消息给所有客户端

**无变更**。

#### Seek（Host 拖动进度条）
1. 服务器 `room.Seek(position)`
2. 计算 `scheduledAt = now + 800ms`
3. 广播 `seek` 消息给所有客户端

**无变更**。

#### 切歌（nextTrack）
1. 服务器更新 `CurrentTrack`、`TrackAudio`、`State=Stopped`、`Position=0`
2. 广播 `trackChange`
3. Host 客户端加载完成后发送 `play position=0`
4. 服务器收到 play 后走正常 Play 流程（带 scheduledAt）

**无变更**。

### 2.5 客户端加入房间时的同步流程

当前实现（保持不变）：

1. 发送 `joined` 响应（含房间信息）
2. 发送 `playlistUpdate`
3. 广播 `userJoined`
4. 如果有当前曲目，发送 `trackChange`
5. 如果正在播放，发送 `play`（含当前位置，**不带 scheduledAt**）
   - 不带 scheduledAt 是正确的：新加入的客户端需要先加载 segment，scheduledAt 必然过期
   - 客户端使用 elapsed 回退计算实际位置

**无变更**。

---

## 3. 客户端算法

### 3.1 syncTick 处理：偏差检测

收到 `syncTick` 后的处理流程：

```javascript
// 新增状态变量（在 AudioPlayer 构造函数中）
this._driftCount = 0;           // 连续超阈值计数
this._lastResetTime = 0;        // 上次强制重置的时间戳（performance.now()）
this._DRIFT_THRESHOLD = 0.15;   // 150ms
this._DRIFT_COUNT_LIMIT = 3;    // 连续3次触发重置
this._RESET_COOLDOWN = 5000;    // 重置后5秒冷却期

// syncTick handler（在 app.js handleMessage 中）
case 'syncTick':
    if (!window.audioPlayer.isPlaying || msg.position == null) break;
    
    // 1. 更新服务器锚点（保留，用于 getCurrentTime 的 elapsed 计算参考）
    window.audioPlayer.serverPlayTime = msg.serverTime;
    window.audioPlayer.serverPlayPosition = msg.position;
    
    // 2. 计算偏差：用最原始的 AudioContext 时间
    const ap = window.audioPlayer;
    const ctxElapsed = ap.ctx.currentTime - ap.startTime;
    const actualPos = ap.startOffset + Math.max(0, ctxElapsed);
    
    // 服务器权威位置 = syncTick.position
    // （syncTick 发送时的位置，传输延迟通过 clockSync 补偿）
    const networkDelay = (window.clockSync.getServerTime() - msg.serverTime) / 1000;
    const serverPos = msg.position + networkDelay;
    
    const drift = actualPos - serverPos;
    const absDrift = Math.abs(drift);
    
    // 3. 更新 UI（调试面板）
    // ... 显示 drift 值 ...
    
    // 4. 偏差计数器逻辑
    if (absDrift > ap._DRIFT_THRESHOLD) {
        // 冷却期内不计数
        if (ap._lastResetTime && performance.now() - ap._lastResetTime < ap._RESET_COOLDOWN) {
            // 静默忽略，不增加计数
            console.log(`[sync] drift ${(drift*1000).toFixed(0)}ms ignored (cooldown)`);
        } else {
            ap._driftCount++;
            console.log(`[sync] drift ${(drift*1000).toFixed(0)}ms, count=${ap._driftCount}/${ap._DRIFT_COUNT_LIMIT}`);
            
            if (ap._driftCount >= ap._DRIFT_COUNT_LIMIT) {
                // 触发强制重置
                ap._driftCount = 0;
                ap._lastResetTime = performance.now();
                console.warn(`[sync] forcing reset: drift=${(drift*1000).toFixed(0)}ms`);
                ap.playAtPosition(serverPos, msg.serverTime);
            }
        }
    } else {
        // 偏差在阈值内，归零计数器
        ap._driftCount = 0;
    }
    break;
```

**偏差计算公式**（核心，必须用最原始的值）：
```
actualPos = startOffset + max(0, ctx.currentTime - startTime)
serverPos = syncTick.position + (clockSync.getServerTime() - syncTick.serverTime) / 1000
drift = actualPos - serverPos
```

- `actualPos`：纯 AudioContext 硬件时钟，不加任何 `_driftOffset` 补偿
- `serverPos`：syncTick 携带的位置 + 网络传输耗时补偿
- `drift > 0`：客户端超前；`drift < 0`：客户端落后

### 3.2 连续偏差计数器逻辑

| 事件 | 动作 |
|------|------|
| `absDrift > THRESHOLD` 且不在冷却期 | `_driftCount++` |
| `absDrift > THRESHOLD` 且在冷却期 | 忽略，不计数 |
| `absDrift <= THRESHOLD` | `_driftCount = 0` |
| `_driftCount >= COUNT_LIMIT` | 触发强制重置，`_driftCount = 0`，记录 `_lastResetTime` |
| play/seek/pause/trackChange | `_driftCount = 0` |

### 3.3 强制重置执行流程

强制重置 = 调用 `playAtPosition(position, serverTime, scheduledAt?)`

简化后的 `playAtPosition`：

```javascript
async playAtPosition(position, serverTime, scheduledAt) {
    this.init();
    this.stop();  // 停止所有当前播放的 source，清理 lookahead
    this.isPlaying = true;
    this._driftCount = 0;  // 重置偏差计数器

    // 等待 ClockSync（最多 800ms）
    if (!window.clockSync.synced) {
        const syncStart = performance.now();
        while (!window.clockSync.synced && performance.now() - syncStart < 800) {
            await new Promise(r => setTimeout(r, 50));
        }
    }

    this.serverPlayTime = scheduledAt || serverTime || window.clockSync.getServerTime();
    this.serverPlayPosition = position || 0;

    // 快照 ctx↔wall 时钟关系
    const ctxSnap = this.ctx.currentTime;
    const perfSnap = performance.now();
    const dateSnap = Date.now();
    const latency = this._outputLatency || 0;

    // 预加载 segment
    const segIdx = Math.floor(this.serverPlayPosition / this.segmentTime);
    if (!this.buffers.has(segIdx)) {
        if (this.onBuffering) this.onBuffering(true);
        await this.preloadSegments(segIdx, 2);
        if (this.onBuffering) this.onBuffering(false);
    }
    if (!this.isPlaying) return;

    const ctxNow = ctxSnap + (performance.now() - perfSnap) / 1000;

    // 尝试硬件级预约起播
    if (scheduledAt) {
        const localScheduled = scheduledAt - window.clockSync.offset;
        const waitMs = localScheduled - dateSnap - (performance.now() - perfSnap);
        if (waitMs > 2 && waitMs < 3000) {
            const ctxTarget = ctxNow + waitMs / 1000;
            const scheduleTarget = ctxTarget - latency;
            this.startOffset = this.serverPlayPosition;
            this.startTime = ctxTarget;
            this._startLookahead(this.serverPlayPosition, scheduleTarget);
            return;
        }
    }

    // 回退：计算已过去的时间
    const now = window.clockSync.getServerTime();
    const elapsed = Math.max(0, (now - this.serverPlayTime) / 1000);
    const actualPos = this.serverPlayPosition + elapsed;
    this.startOffset = actualPos;
    this.startTime = ctxNow;
    const schedFallback = Math.max(ctxNow - latency, this.ctx.currentTime);
    this._startLookahead(actualPos, schedFallback);
}
```

**与当前实现的关键区别**：
- 删除 `_driftOffset`、`_pendingDriftCorrection`、`_softCorrectionTotal` 相关逻辑
- 删除 `_resyncGen`、`_resyncing`、`_resyncBackoff` 相关逻辑
- 删除 playbackRate 相关逻辑
- 新增 `_driftCount = 0` 重置

### 3.4 断线重连后的恢复流程

```
WS断线 → reconnect → 发送 join → 服务器回复 joined + trackChange + play(无scheduledAt)
→ 客户端 handleTrackChange 加载音频 → doPlay → playAtPosition(position, serverTime, null)
→ 走 elapsed 回退路径 → 从正确位置开始播放
→ 后续 syncTick 检测偏差 → 如有问题，3秒后强制重置
```

**关键**：重连后不需要特殊处理。服务器发送的 `play` 不带 `scheduledAt`，客户端自动走 elapsed 回退路径。如果位置不准，syncTick 会在 3 秒内检测到并触发重置。

### 3.5 页面后台恢复

```javascript
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.audioPlayer.isPlaying) {
        // 1. 重新同步时钟
        window.clockSync.burst();
        
        // 2. 立即强制重置（后台期间 AudioContext 可能被暂停/节流）
        //    不等 syncTick，直接用服务器锚点计算位置并重置
        setTimeout(() => {
            if (!window.audioPlayer.isPlaying) return;
            const ap = window.audioPlayer;
            const now = window.clockSync.getServerTime();
            const expectedPos = ap.serverPlayPosition + (now - ap.serverPlayTime) / 1000;
            ap._driftCount = 0;
            ap._lastResetTime = performance.now();
            ap.playAtPosition(expectedPos, now);
            console.log('[sync] visibility restore: forced reset to', expectedPos.toFixed(2));
        }, 600);  // 等 clockSync burst 完成
    }
});
```

**与当前实现的区别**：
- 不再调用 `correctDrift()`，直接强制重置
- 后台恢复 = 无条件重置，简单可靠

### 3.6 play/pause/seek/切歌的响应流程

#### 收到 `play`
```javascript
case 'play':
    // 如果携带 trackAudio 且本地没有音频，先加载
    if (msg.trackAudio && !audioInfo) {
        await handleTrackChange(msg, true);
        if (!pendingPlay) await doPlay(msg.position, msg.serverTime, msg.scheduledAt);
    } else {
        await doPlay(msg.position, msg.serverTime, msg.scheduledAt);
    }
    break;
```

`doPlay` 调用 `playAtPosition`，后者：
- 如果有 `scheduledAt` 且未过期 → 硬件预约起播
- 否则 → elapsed 回退

#### 收到 `pause`
```javascript
case 'pause':
    window.audioPlayer._driftCount = 0;  // 重置计数器
    doPause();
    break;
```

#### 收到 `seek`
```javascript
case 'seek':
    window.audioPlayer._driftCount = 0;  // 重置计数器
    if (window.audioPlayer.isPlaying) {
        await doPlay(msg.position, msg.serverTime, msg.scheduledAt);
    } else {
        pausedPosition = msg.position;
        // 更新 UI
    }
    break;
```

#### 收到 `trackChange`
```javascript
// handleTrackChange 中：
window.audioPlayer.stop();  // stop() 内部会重置 _driftCount
// 加载新曲目...
// Host 加载完成后发送 play，服务器广播带 scheduledAt 的 play
```

#### 收到 `forceResync`
```javascript
case 'forceResync':
    const ap = window.audioPlayer;
    if (ap && ap.isPlaying) {
        ap._driftCount = 0;
        ap._lastResetTime = performance.now();
        ap.playAtPosition(msg.position, msg.serverTime, msg.scheduledAt);
    }
    break;
```

---

## 4. 需要删除的旧逻辑

### 4.1 player.js — AudioPlayer 类

#### 删除的实例变量（构造函数中）
| 变量 | 用途（旧） |
|------|-----------|
| `_driftOffset` | 累积软纠正偏移量 |
| `_pendingDriftCorrection` | 等待 segment 调度时生效的纠正量 |
| `_softCorrectionTotal` | UI 显示用的软纠正总量 |
| `_lastResync` | 硬重置时间戳（被 `_lastResetTime` 替代） |
| `_resyncGen` | 重置代数计数器 |
| `_rateCorrectingUntil` | playbackRate 纠正结束时间 |
| `_rateCorrectionTimer` | playbackRate 恢复定时器 |
| `_currentPlaybackRate` | 当前 playbackRate 值 |
| `_rateStartTime` | playbackRate 纠正开始时间 |

#### 删除的方法
| 方法 | 文件 | 说明 |
|------|------|------|
| `correctDrift()` | player.js | 整个三层纠正函数，完全删除 |

#### 需要修改的方法
| 方法 | 修改内容 |
|------|---------|
| `playAtPosition()` | 删除 `_driftOffset=0`, `_softCorrectionTotal=0`, `_pendingDriftCorrection=0`, `_resyncGen++`, `_rateStartTime=0`；新增 `_driftCount=0` |
| `stop()` | 删除 `_driftOffset=0`, `_softCorrectionTotal=0`, `_pendingDriftCorrection=0`, `_rateCorrectingUntil=0`, `_currentPlaybackRate=1.0`, `_rateStartTime=0`, `_rateCorrectionTimer` 清理；新增 `_driftCount=0` |
| `getCurrentTime()` | 删除 `_driftOffset` 减法、playbackRate 补偿逻辑。简化为 `startOffset + max(0, ctx.currentTime - startTime)` |
| `_scheduleAhead()` | 删除 playbackRate 检查/恢复逻辑、`_pendingDriftCorrection` 转移逻辑、`effectiveRate`/`effectiveDur` 计算（全部用 rate=1.0）、playbackRate 设置 |

### 4.2 app.js

| 位置 | 修改 |
|------|------|
| `handleMessage` → `syncTick` case | **重写**：删除 `serverPlayTime`/`serverPlayPosition` 更新 + `correctDrift(true)` 调用，替换为新的偏差检测逻辑 |
| `startUIUpdate()` | **删除** `driftInterval` 及所有 `correctDrift()` 定时调用（快速阶段+稳态阶段） |
| `stopUIUpdate()` | **删除** `driftInterval` 清理 |
| `visibilitychange` handler | **重写**：删除 `correctDrift()` 调用和 `_scheduleAhead()` 调用，改为无条件强制重置 |

### 4.3 index.html 内联脚本

| 代码块 | 操作 |
|--------|------|
| Sync Watchdog (`setInterval 3000ms`) | **整块删除**：重置 `_resyncing`、`_rateCorrectingUntil`、`_resyncBackoff` 的看门狗——这些变量全部不再存在 |
| statusReport 拦截器中的 `forceResync` handler | 删除 `_resyncing=false`、`_resyncBackoff=500`，改为 `_driftCount=0; _lastResetTime=performance.now()` |

### 4.4 服务器端 main.go

| 位置 | 修改 |
|------|------|
| `statusReport` handler | 将 drift 阈值从 `0.4` 改为 `0.5` |

**无需删除任何服务器端逻辑**——syncTick goroutine、play/pause/seek/statusReport 处理均保持不变。

---

## 5. 边界条件和异常处理

### 5.1 clockSync offset 突变

**场景**：网络切换（WiFi→4G）导致 offset 跳变 >10ms。

**处理**：ClockSync 已有网络变化检测（`navigator.connection`），会清空 samples 重新同步。offset 突变期间 syncTick 偏差计算可能不准，最坏情况是误触发一次强制重置（3秒后），重置后用新 offset 重新锚定，自然恢复。**不需要额外处理。**

### 5.2 syncTick 丢包

**场景**：某次 syncTick 未到达客户端。

**处理**：连续偏差计数器需要连续 N 次超阈值，丢包只是延迟检测。如果连续丢 3 个 syncTick（3秒无 tick），计数器不会增长，不会误触发重置。服务器 statusReport 兜底：每 2 秒客户端上报，服务器检测 >500ms 偏差时强制重置。**不需要额外处理。**

### 5.3 强制重置后立刻又超阈值（防重置风暴）

**防护机制**：`_RESET_COOLDOWN = 5000ms`

- 重置时记录 `_lastResetTime = performance.now()`
- 冷却期内（5秒），即使偏差超阈值也不增加 `_driftCount`
- 5 秒足够完成 segment 加载和 AudioContext 调度稳定
- 冷却期结束后恢复正常检测

**极端情况**：如果 5 秒后仍然超阈值，会再次触发重置（需要连续 3 次，即冷却结束后 3 秒）。这是正确行为——说明确实有持续性问题需要重置。

### 5.4 最后一个 segment 播放时的位置计算

服务器权威位置 clamp 到 `duration`（已实现），客户端 `getCurrentTime()` clamp 到 `duration`（已实现）。偏差计算中两边都 clamp 后比较，不会出现虚假偏差。**不需要额外处理。**

### 5.5 歌曲结束时的处理

客户端 `uiInterval` 检测 `getCurrentTime() >= duration` → `doPause()` + `onTrackEnd()`。Host 的 `onTrackEnd()` 根据播放模式发送 `nextTrack`。服务器 syncTick 中 `currentPos` clamp 到 `duration`，不会发送超出时长的位置。歌曲结束时偏差为 0（两边都 clamp），不会误触发重置。**不需要额外处理。**

---

## 6. 参数表

| 参数 | 值 | 位置 | 选择理由 |
|------|-----|------|---------|
| `DRIFT_THRESHOLD` | 150ms | 客户端 player.js | 人耳对音乐同步的感知阈值约 30-50ms，150ms 留足余量避免误触发。低于 100ms 会因网络抖动频繁重置 |
| `DRIFT_COUNT_LIMIT` | 3 | 客户端 player.js | 3 次 × 1 秒/次 = 3 秒确认窗口。足够区分瞬时抖动和持续偏差。2 次太敏感，5 次太迟钝 |
| `RESET_COOLDOWN` | 5000ms | 客户端 player.js | 重置后需要时间加载 segment + AudioContext 调度稳定。5 秒覆盖 1-2 个 segment 周期 |
| `scheduledAt buffer` | 800ms | 服务器 main.go | 给客户端预留网络传输 + segment 预加载时间。太短导致 scheduledAt 过期走 fallback，太长增加操作延迟感 |
| `syncTick interval` | 1000ms | 服务器 main.go | 配合 COUNT_LIMIT=3 实现 3 秒检测窗口。更频繁增加带宽，更稀疏延迟检测 |
| `statusReport interval` | 2000ms | 客户端 index.html | 服务器兜底检测频率。2 秒足够及时，不增加太多流量 |
| `server forceResync threshold` | 500ms | 服务器 main.go | 大于客户端 150ms 阈值，作为兜底。客户端 3 秒内自行处理 150-500ms 偏差，服务器只处理 >500ms 的严重偏差 |
| `clockSync burst count` | 8 | 客户端 sync.js | 页面恢复时快速重新同步时钟。8 ping × 50ms = 400ms 完成 |
| `visibility restore delay` | 600ms | 客户端 app.js | 等待 clockSync burst 完成后再重置。burst 400ms + 处理余量 200ms |
| `segmentTime` | 5s | 服务器配置 | 音频分段长度，影响预加载和重置恢复速度。当前值合理，不修改 |
| `outputLatency compensation` | 硬件值 | 客户端 player.js | `ctx.outputLatency \|\| ctx.baseLatency \|\| 0`，用于 scheduledAt 预约时提前调度，保持不变 |
