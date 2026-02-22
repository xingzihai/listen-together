# ListenTogether 同步代码审查报告

审查人：自动化测试工程师  
日期：2026-02-22  
目标精度：同局域网 ≤15ms，跨局域网 ≤30ms

---

## 🔴 致命问题

### 🔴-1 `Play()` 返回值被忽略，play handler 存在 TOCTOU 竞态

**文件**: `main.go` L689-695, `room.go` L444-450

`room.Play()` 在锁内设置 `StartTime = time.Now()` 并返回 `r.StartTime`，但 play handler 忽略了返回值，转而在锁外重新读取 `currentRoom.StartTime`：

```go
currentRoom.Play(msg.Position)       // 锁内设 StartTime
currentRoom.Mu.RLock()               // 重新加锁
playStartMs := currentRoom.StartTime // 可能已被另一个 goroutine 修改
```

在两次锁之间，另一个 goroutine（如 seek/pause）可能修改 `StartTime`，导致广播的 `serverTime` 与 room 实际锚点不一致。

**影响**: 所有客户端收到错误的时间锚点，同步完全失效。  
**修复**: 使用 `Play()` 的返回值：
```go
startTime := currentRoom.Play(msg.Position)
playStartMs := startTime.UnixNano() / int64(time.Millisecond)
```

### 🔴-2 Seek handler 同样存在 TOCTOU 竞态

**文件**: `main.go` L735-741

与 🔴-1 完全相同的模式：`Seek()` 返回 `StartTime` 但被忽略，handler 在锁外重新读取。

**修复**: 同上，使用 `Seek()` 返回值。

### 🔴-3 syncTick 的 elapsed 在锁外计算存在竞态

**文件**: `main.go` L170-175

```go
elapsed := time.Since(startT).Seconds()  // 在 RUnlock 之后
```

实际上代码注释说"Compute elapsed INSIDE lock"，但仔细看代码：`elapsed` 的计算确实在 `rm.Mu.RUnlock()` **之前**（L175 在 L185 RUnlock 之前）。

**更正**: 重新审查后，elapsed 确实在锁内计算。此条降级为 🟢-7（见下方建议）。

---

## 🟡 重要问题

### 🟡-1 outputLatency 补偿方向可能导致音频提前播放

**文件**: `player.js` L218-219

```js
const schedTime = t - this._outputLatency;
```

`outputLatency` 表示从 AudioContext 调度到扬声器实际出声的延迟。减去它意味着让 AudioContext 更早开始处理，使声音在 `t` 时刻到达扬声器。方向正确。

但问题在于：`outputLatency` 在不同设备上差异巨大（蓝牙耳机可达 150-300ms），而 drift correction 的 `scheduledPos` 计算（L195-200）使用的是 `_nextSegTime`（即 `t`，未减去 outputLatency），但实际音频在 `schedTime = t - outputLatency` 播放。

这意味着 drift correction 认为音频在 `t` 时刻播放，但实际在 `t - outputLatency` 时刻就开始处理了。drift 计算的 `scheduledPos` 与实际出声时间存在 `outputLatency` 的偏差。

**影响**: 蓝牙设备上 drift correction 会持续检测到一个固定偏移，导致不必要的微调。  
**修复**: drift correction 中的 `scheduledPos` 应基于 `schedTime` 而非 `_nextSegTime`，或在 drift 计算中补偿 outputLatency。

### 🟡-2 `_lastCorrectedSegIdx` guard 在 forceResync 后未重置

**文件**: `player.js` L170 (playAtPosition), `app.js` L350 (forceResync handler)

`playAtPosition` 中 `_lastCorrectedSegIdx = -1` 正确重置。但 `forceResync` handler 直接调用 `ap.playAtPosition()`，而 `playAtPosition` 内部会重置，所以这条实际上没问题。

**更正**: 此条撤回。`playAtPosition` 内部已处理。

### 🟡-3 clockSync 未就绪时 `serverTimeToCtx` fallback 精度不足

**文件**: `sync.js` L170-176

```js
serverTimeToCtx(serverTimeMs) {
    if (!this.synced || this.anchorCtxTime === 0) {
        // Fallback: use perf-based conversion (less precise)
        const perfTarget = this.anchorPerfTime + (serverTimeMs - this.anchorServerTime);
```

当 `synced=false` 时，`anchorPerfTime` 和 `anchorServerTime` 都是 0，导致：
```
perfTarget = 0 + (serverTimeMs - 0) = serverTimeMs  // 完全错误的 perf 时间
```

**影响**: 如果在 clockSync 完成前收到 play 命令，音频调度时间完全错误。  
**修复**: fallback 应使用 `Date.now()` 作为粗略估计：
```js
if (!this.synced || this.anchorCtxTime === 0) {
    const ctx = window.audioPlayer && window.audioPlayer.ctx;
    const ctxNow = ctx ? ctx.currentTime : 0;
    const serverNow = Date.now(); // 粗略估计
    return ctxNow + (serverTimeMs - serverNow) / 1000;
}
```

### 🟡-4 playAtPosition 中 clockSync 等待不足时无保护

**文件**: `player.js` L152-157

```js
if (!window.clockSync.synced) {
    const syncStart = performance.now();
    while (!window.clockSync.synced && performance.now() - syncStart < 800) {
        await new Promise(r => setTimeout(r, 50));
    }
}
```

等待 800ms 后如果仍未同步，代码继续执行，使用 `window.clockSync.getServerTime()` 获取时间。此时 `getServerTime()` 会走 `Date.now() + this.offset`（offset=0），即使用本地时钟。

**影响**: 跨局域网场景下本地时钟与服务器可能差数百毫秒，首次播放可能严重偏移。  
**修复**: 等待超时后应 burst 一轮 ping 并记录警告，或延长等待时间。

### 🟡-5 drift correction 每段最大 ±30ms 可能不足以收敛

**文件**: `player.js` L207-210

```js
const correction = Math.max(-0.030, Math.min(0.030, drift));
```

如果 drift 为 80ms，需要至少 3 个 segment boundary 才能完全纠正。在 5s segment 时间下，这意味着 15s 才能收敛。而 `_DRIFT_THRESHOLD` 是 100ms，超过后会触发 hard resync。

这意味着 30-100ms 的 drift 需要 5-15s 才能通过微调收敛，期间用户可感知不同步。

**影响**: 中等 drift 收敛慢，用户体验不佳。  
**修复**: 考虑将 cap 提高到 ±50ms，或根据 drift 大小动态调整 cap。

### 🟡-6 syncTick 中 anchor 刷新与 drift correction 的交互

**文件**: `app.js` L300-306

```js
if (!ap._lastResetTime || performance.now() - ap._lastResetTime > ap._RESET_COOLDOWN) {
    if (ap.ctx) {
        ap._anchorCtxTime = ap.ctx.currentTime;
        ap._anchorServerTime = window.clockSync.getServerTime();
    }
}
```

每次 syncTick（1s 间隔）都刷新 `_anchorCtxTime/_anchorServerTime`。这些 anchor 被 `_scheduleAhead` 的 drift correction 使用。

问题：如果 drift correction 刚对 `_nextSegTime` 做了调整，下一次 syncTick 刷新 anchor 后，drift correction 的参考基准变了，之前的调整效果被部分抵消。

**影响**: drift correction 可能出现振荡，无法稳定收敛。  
**修复**: anchor 刷新时应考虑已应用的 correction 累计量，或仅在 drift 较小时刷新 anchor。

### 🟡-7 `_upgradeQuality` 中重建 anchor 使用 `getServerTime()` 而非 play 锚点

**文件**: `player.js` L117-120

```js
this._anchorCtxTime = ctxNow;
this._anchorServerTime = serverNow;  // = clockSync.getServerTime()
this.serverPlayTime = serverNow;
this.serverPlayPosition = resumePos;
```

品质切换时重建了 `serverPlayTime/Position`，这改变了 elapsed 模型的基准。如果此时与服务器的 `room.StartTime + room.Position` 不一致，后续 syncTick 的 drift 检测会产生偏差。

**影响**: 品质切换后可能触发不必要的 resync。  
**修复**: 品质切换时应保留原始的 `serverPlayTime/Position`，仅重建 ctx anchor：
```js
this._anchorCtxTime = ctxNow;
this._anchorServerTime = window.clockSync.getServerTime();
// 不要修改 serverPlayTime/serverPlayPosition
```

---

## 🟢 建议

### 🟢-1 ping 时钟采样顺序可优化

**文件**: `sync.js` L78-82

注释说"ctx first (least volatile)"，但 `ctx.currentTime` 的读取精度取决于浏览器实现（Chrome 约 128 样本精度 ≈ 2.67ms@48kHz）。建议在 pong 处理时也记录这个精度限制。

### 🟢-2 syncTick 广播间隔 1s 偏长

**文件**: `main.go` L151

对于 ≤15ms 精度目标，1s 的 tick 间隔意味着 drift 检测延迟最高 1s。建议对多客户端房间降低到 500ms。

### 🟢-3 `getServerPosition()` 与 `getCurrentTime()` 语义重叠

**文件**: `player.js` L243-249, L251-256

两个方法都计算当前位置，但使用不同时钟域。建议统一命名并添加文档说明各自用途。

### 🟢-4 seek 到 position=0 时 `Math.floor(0 / segmentTime) = 0` 正确

验证通过，无问题。

### 🟢-5 segment 加载失败时 `_scheduleAhead` 静默退出

**文件**: `player.js` L225

```js
if (!buffer) break;
```

如果 `loadSegment` 成功但 `decodeAudioData` 返回异常 buffer，这里会静默停止调度。建议添加错误恢复逻辑（跳过坏段继续）。

### 🟢-6 crossfade 的 fadeTime=3ms 可能不足以消除 click

**文件**: `player.js` L230-237

3ms 在 48kHz 下仅 144 样本。对于某些音频内容可能产生可闻 click。建议提高到 5-10ms。

### 🟢-7 syncTick elapsed 计算虽在锁内，但 `time.Since(startT)` 包含锁等待时间

**文件**: `main.go` L175

`startT` 在锁内读取，`time.Since(startT)` 也在锁内计算，但如果获取读锁时等待了较长时间（写锁竞争），elapsed 会包含这段等待。在高竞争场景下可能引入几毫秒误差。

**建议**: 可忽略，正常情况下读锁等待 <1ms。

---

## 总结

| 级别 | 数量 | 说明 |
|------|------|------|
| 🔴 致命 | 2 | Play/Seek handler 的 TOCTOU 竞态（🔴-1, 🔴-2） |
| 🟡 重要 | 5 | outputLatency drift 偏差、clockSync fallback、drift 收敛速度、anchor 振荡、品质切换 anchor |
| 🟢 建议 | 7 | tick 间隔、命名、crossfade、错误恢复等 |

核心架构设计合理：三锚点时钟同步、segment-boundary drift correction、server-authority resync 三层防线覆盖了主要场景。

最紧急需修复的是 🔴-1 和 🔴-2 的 TOCTOU 竞态——直接使用 `Play()`/`Seek()` 的返回值即可，改动量极小。
