# ListenTogether 音频同步机制审查报告

**审查日期**: 2026-02-20
**审查范围**: player.js, sync.js, app.js, index.html (inline), main.go, room.go

---

## 一、发现的问题

### 🔴 P1: `let` 变量跨 `<script>` 块不可访问 — statusReport 静默失败

**严重程度**: 🔴 致命

**位置**: `index.html` inline script (statusReport IIFE) → 引用 `app.js` 中的 `ws` 和 `currentTrackIndex`

**问题**: `app.js` 中 `ws` 和 `currentTrackIndex` 用 `let` 声明：
```js
let ws, roomCode, isHost = false, ...
let currentTrackIndex = -1;
```
`let` 变量是块级作用域，**不会挂到 `window` 上**。但 `index.html` 的 inline script 直接引用 `ws` 和 `currentTrackIndex`：
```js
if (typeof ws === 'undefined' || !ws || ws.readyState !== 1) return;
var idx = typeof currentTrackIndex !== 'undefined' ? currentTrackIndex : 0;
```
**实际行为**: 在同一个全局 `<script>` 顶层，`let` 声明的变量虽然不在 `window` 上，但在同一 HTML 文档的不同 `<script>` 标签中**是可以访问的**（它们共享同一个全局词法环境）。所以这里**实际上能工作**。

**但**: `forceTrack` 拦截器中的 `ws.onmessage` 替换逻辑有竞态问题 — 如果 WS 重连（`connect()` 创建新 WebSocket），`origOnMsg` 指向旧 WS 的 handler，新 WS 的 `onmessage` 不会被拦截。

**修正评估**: 变量访问本身没问题，但 WS 重连后拦截器失效是真实 bug。

---

### 🔴 P2: WS 重连后 forceTrack/forceResync 拦截器失效

**严重程度**: 🔴 致命

**位置**: `index.html` inline script — `checkInterval` 只执行一次 `clearInterval(checkInterval)`

**问题**: 拦截器只在第一次发现 `ws` 时 patch 一次 `onmessage`，然后 `clearInterval`。当 WS 断线重连时，`connect()` 创建全新的 WebSocket 对象并设置新的 `onmessage`，拦截器不会重新 patch。

**后果**: 重连后服务端发送的 `forceTrack` 和 `forceResync` 消息将被忽略（不会被拦截处理），客户端可能永远停留在错误的 track 或错误的位置。

**修复建议**: 不要用 `clearInterval`，改为持续检查 `ws` 对象是否变化：
```js
var lastWs = null;
setInterval(function() {
    if (typeof ws === 'undefined' || !ws || ws === lastWs) return;
    lastWs = ws;
    var origOnMsg = ws.onmessage;
    ws.onmessage = function(e) { /* 拦截逻辑 */ };
}, 500);
```

---

### 🔴 P3: syncTick 广播包含发送者（host），导致 host 自身被纠偏

**严重程度**: 🟡 重要

**位置**: `main.go` syncTick goroutine — 广播给所有 clients，不排除 host

**问题**: syncTick 广播给房间内所有客户端，包括 host。host 是操作发起者，其本地状态应该是权威的，但 syncTick 会用服务端计算的 position 覆盖 host 的 `serverPlayTime` 和 `serverPlayPosition`，可能导致 host 端不必要的漂移纠正。

**影响**: 通常影响不大（host 和 server 时间差很小），但在网络波动时可能导致 host 端出现不必要的 hard resync。

**修复建议**: syncTick 广播时排除 host，或 host 端忽略 syncTick。

---

### 🟡 P4: playbackRate 纠正期间 getCurrentTime() 的位置计算与实际音频不一致

**严重程度**: 🟡 重要

**位置**: `player.js` — `getCurrentTime()` 和 `_scheduleAhead()` 中的 rate compensation

**问题**: `getCurrentTime()` 通过 `rateElapsed * (rate - 1.0)` 补偿 playbackRate 的额外播放量。但 `_scheduleAhead()` 中计算 `effectiveDur = dur / effectiveRate`，这改变了 `_nextSegTime` 的推进速度。两个补偿机制独立运行，在 rate correction 结束时的 offset 补偿（`startOffset += extraPlayed`）可能与实际调度的 segment 时间不完全匹配。

**后果**: rate correction 结束后可能出现 10-30ms 的位置跳变，触发新一轮 soft correction。不会导致严重问题，但会造成不必要的纠正循环。

**修复建议**: 统一 rate compensation 逻辑，在 rate correction 结束时直接用 server anchor 重新校准，而不是累加 extraPlayed。

---

### 🟡 P5: soft correction 的 _pendingDriftCorrection 可能累积过多未消费的修正

**严重程度**: 🟡 重要

**位置**: `player.js` — `correctDrift()` Tier 1 和 `_scheduleAhead()`

**问题**: `_pendingDriftCorrection` 在每次 soft correction 时累加，但只在 `_scheduleAhead()` 调度新 segment 时才转移到 `_driftOffset`。如果当前 segment 很长（比如最后一个 segment），或者 `_scheduleAhead()` 因为 LOOKAHEAD 窗口限制不调度新 segment，`_pendingDriftCorrection` 会持续累积。

同时 `getCurrentTime()` 包含 `_pendingDriftCorrection`，所以 drift 测量会"看到"修正已生效，但实际音频并未改变。这导致 correctDrift 认为漂移已修正而停止纠正，但实际音频仍在错误位置播放。

**后果**: 在 segment 边界之间，soft correction 是"虚假"的 — 报告的位置已修正，但听到的音频没变。

**修复建议**: soft correction 应该直接调整 `_nextSegTime`（已经在做），但 `getCurrentTime()` 不应该包含 `_pendingDriftCorrection`，只包含已消费的 `_driftOffset`。或者改用 playbackRate 微调来实现 soft correction。

---

### 🟡 P6: trackChange 期间 play 消息的竞态

**严重程度**: 🟡 重要

**位置**: `app.js` — `handleTrackChange()` 和 `doPlay()`

**问题**: 当 host 发起 `nextTrack` 时，服务端先广播 `trackChange`，然后 host 端 `handleTrackChange` 完成后发送 `play`。但非 host 客户端可能在 `trackChange` 还在加载 segments 时就收到 `play` 消息。

代码中有 `pendingPlay` 机制处理这种情况，但 `trackLoading` 标志在 `handleTrackChange` 的 `catch` 分支中也会被设为 `false`，如果 segments 加载失败，`pendingPlay` 永远不会被消费。

**修复建议**: 在 `catch` 中也检查并清理 `pendingPlay`。

---

### 🟡 P7: 服务端 Room.Pause() 的 position 计算可能有微小误差

**严重程度**: 🟢 建议

**位置**: `room.go` — `Pause()` 方法

**问题**: `elapsed := time.Since(r.StartTime).Seconds()` 使用 Go 的 monotonic clock，而客户端使用 `Date.now() + clockSync.offset`。两者的时间基准不同，可能有几毫秒差异。

**影响**: 通常 <10ms，可接受。

---

### 🟡 P8: watchdog 每 3 秒无条件重置 `_resyncing` 可能中断正在进行的 resync

**严重程度**: 🟡 重要

**位置**: `index.html` inline script — watchdog IIFE

**问题**: watchdog 每 3 秒将 `_resyncing` 强制设为 `false`。如果 `playAtPosition` 正在执行（等待 segment 加载），watchdog 会提前清除 `_resyncing`，导致 `correctDrift` 在 resync 完成前再次触发 hard resync，形成 resync 风暴。

**修复建议**: 增加时间判断，只在 `_resyncing` 持续超过一定时间（如 5 秒）才重置：
```js
if (ap._resyncing) {
    if (!ap._resyncingSince) ap._resyncingSince = Date.now();
    else if (Date.now() - ap._resyncingSince > 5000) {
        ap._resyncing = false;
        ap._resyncingSince = 0;
    }
} else { ap._resyncingSince = 0; }
```

---

### 🟢 P9: ClockSync 的 EMA 平滑可能延迟大跳变的收敛

**严重程度**: 🟢 建议

**位置**: `sync.js` — `handlePong()` EMA 逻辑

**问题**: 当 offset 变化 <10ms 时使用 0.7/0.3 EMA 平滑。这意味着一个 9ms 的真实 offset 变化需要多轮才能收敛，期间 `getServerTime()` 不准确。

**影响**: 在网络稳定时影响很小。在网络切换时，代码已有检测机制（清空 samples 重新同步）。

---

### 🟢 P10: 服务端 syncTick 不检查 track 是否已结束

**严重程度**: 🟢 建议

**位置**: `main.go` syncTick goroutine

**问题**: 虽然有 duration clamp，但服务端不会自动将 state 改为 Stopped/Paused。如果 host 端因为网络问题没有发送 pause/nextTrack，syncTick 会持续广播 `position = duration`，客户端会反复触发 `onTrackEnd`。

---

### 🟢 P11: segment URL 构建不包含 track 标识的竞态保护

**严重程度**: 🟢 建议

**位置**: `player.js` — `_getSegmentURL()` 和 `loadAudio()`

**问题**: `_getSegmentURL` 使用 `this._ownerID`、`this._audioUUID`、`this._actualQuality` 构建 URL。在 `handleTrackChange` 调用 `loadAudio` 时会更新这些字段。如果旧 track 的 segment 加载请求还在 flight 中，它们会使用新 track 的 URL 参数。

**实际风险**: `loadAudio` 调用 `stop()` 后 `buffers.clear()`，旧的 in-flight 请求的结果会写入新 track 的 buffers Map。但由于 `loadAudio` 是 async 且 `handleTrackChange` 有 `trackChangeGen` 保护，实际发生概率很低。

---

## 二、整体评估

**可靠性评分: 7/10**

同步机制的整体设计是合理的：NTP-like 时钟同步 + 三级漂移纠正 + 服务端 syncTick 锚点 + statusReport 双向校验。这是一个比较完整的方案。

**主要风险点**:
1. **WS 重连后拦截器失效 (P2)** — 这是最严重的问题，会导致重连后 forceTrack/forceResync 完全失效
2. **soft correction 的虚假修正 (P5)** — 会导致 segment 内的漂移无法真正修正
3. **watchdog 过于激进 (P8)** — 可能导致 resync 风暴

**改进方向**:
1. 将 forceTrack/forceResync 处理移入 `app.js` 的 `handleMessage`，而不是用 inline script 拦截
2. 重新设计 soft correction，使其直接影响音频输出而非仅修改报告位置
3. 给 watchdog 增加时间窗口判断，避免中断正常 resync 流程
4. syncTick 排除 host 客户端
