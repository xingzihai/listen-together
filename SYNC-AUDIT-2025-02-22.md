# 同步播放全面审查报告 (2026-02-22)

目标精度：同局域网 ≤15ms，跨局域网 ≤30ms
实测 clockSync 精度：同局域网 ~5ms，跨局域网 ~15ms

---

## 🔴 P0 — 核心架构缺陷（直接导致持续偏差）

### 1. getCurrentTime() 与 syncTick 完全脱节

```js
getCurrentTime() {
    const elapsed = this.ctx.currentTime - this.startTime;
    return this.startOffset + elapsed;
}
```

只用本地 ctx 时钟，完全不读 `serverPlayTime` / `serverPlayPosition`。syncTick 每秒更新这两个值，但 getCurrentTime 无视它们。结果：
- 播放位置纯靠本地时钟自由漂移，clockSync 的精度被完全浪费
- ctx 时钟和系统时钟的速率差（1-10ppm）会随时间线性累积
- drift 检测发现偏差后，唯一手段是 forceResync（完全重置），没有渐进纠正

### 2. play 广播的 serverTime 与 room.StartTime 不是同一时刻

```go
// main.go:675-684
currentRoom.Play(msg.Position)     // StartTime = time.Now() ← 时刻A
nowMs := syncpkg.GetServerTime()   // ← 时刻B（中间有锁释放+重加锁+读TrackAudio）
broadcast(..., ServerTime: nowMs)
```

syncTick 用 `time.Since(room.StartTime)` 算 elapsed，客户端用 play 广播的 `serverTime` 算 elapsed。两个基准不同，天然有 2-5ms 偏差，且这个偏差是永久性的——每次 syncTick 都会体现。

### 3. syncTick 锚点更新是空操作

```js
// syncTick handler
ap.serverPlayTime = msg.serverTime;
ap.serverPlayPosition = msg.position;
```

更新了，但没有任何代码读这两个值来纠正播放。getCurrentTime 不读，_scheduleAhead 不读，_nextSegTime 不调整。这两行代码等于 no-op。

---

## 🟡 P1 — 显著影响精度

### 4. outputLatency 声明但未使用

```js
this._outputLatency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
console.log(`[sync] outputLatency: ${(this._outputLatency*1000).toFixed(1)}ms`);
```

只打了日志，从未用于调度补偿。不同设备的 outputLatency 差异可达 5-50ms（蓝牙耳机 vs 有线）。两个客户端如果一个用蓝牙一个用有线，即使时钟完美同步，听到声音的时刻也差几十毫秒。

应该在 `source.start(schedTime)` 时提前 `_outputLatency` 秒调度。

### 5. drift 检测阈值 200ms 太高，且无渐进纠正

```js
this._DRIFT_THRESHOLD = 0.20;   // 200ms
this._DRIFT_COUNT_LIMIT = 3;    // 需要连续3次才触发
```

目标精度 15-30ms，但 drift 阈值 200ms，还要连续 3 次（3秒）才触发重置。意味着 50-199ms 的漂移永远不会被纠正。应该：
- 降阈值到 30-50ms
- 加渐进纠正：小漂移（<50ms）通过调整 `_nextSegTime` 在下一个 segment 边界吸收

### 6. clockSync 稳态 ping 间隔 10 秒太长

```js
interval = 10000; // synced 后每10秒ping一次
```

10 秒间隔意味着时钟漂移最多 10 秒才能被发现和纠正。对于目标 15ms 精度，建议降到 3-5 秒。同时 sample expiry 60 秒也偏长，旧样本会拖慢对网络变化的响应。

### 7. syncTick 的 networkDelay 补偿不精确

```js
const networkDelay = Math.max(0, (window.clockSync.getServerTime() - msg.serverTime) / 1000);
const serverPos = msg.position + networkDelay;
```

`clockSync.getServerTime() - msg.serverTime` 包含了 WebSocket 传输延迟 + JS 事件循环排队延迟。如果 JS 主线程正忙（解码 segment、渲染），这个值可能偶发偏大 10-30ms，导致 drift 检测误判。

---

## 🟢 P2 — 边缘情况 / 小优化

### 8. _upgradeQuality 中的同步锚点重建不精确

```js
this.serverPlayTime = window.clockSync.getServerTime();
this.serverPlayPosition = resumePos;
```

用本地 clockSync 估算的 serverTime 重建锚点，而不是从服务器获取。如果 clockSync 有几 ms 偏差，切换音质后同步会跳变。

### 9. play 广播中 position 是请求时的值，不是实际开始播放时的值

```go
currentRoom.Play(msg.Position)  // 设置 Position = msg.Position, StartTime = now
broadcast(..., Position: msg.Position, ServerTime: nowMs)
```

`msg.Position` 是 host 发送 play 命令时的位置，`nowMs` 是服务端处理完后的时间。如果 host 的 WebSocket 消息到达服务端有延迟，`msg.Position` 已经过时了。应该广播 `Position: msg.Position, ServerTime: room.StartTime`（用同一个时刻），或者让服务端自己算 position。

### 10. forceResync 的 position 计算有微小时间差

```go
elapsed := time.Since(serverStart).Seconds()
expectedPos := serverPos + elapsed
// ...
nowResync := syncpkg.GetServerTime()
myClient.Send(map[string]interface{}{
    "position":    expectedPos,   // 基于 serverStart 算的
    "serverTime":  nowResync,     // 又取了一次时间
})
```

`expectedPos` 和 `nowResync` 不是同一时刻。虽然只有微秒级，但原则上应该原子化。

### 11. clockSync 的 EMA 平滑可能延迟收敛

```js
if (delta < 5) {
    const blendedServer = 0.7 * currentEstimate + 0.3 * newAnchorServer;
```

当 delta < 5ms 时用 0.7/0.3 混合。如果真实偏差是 4ms，需要多轮才能收敛。对于 15ms 目标，4ms 的收敛延迟是显著的。建议 delta < 2ms 时才平滑，2-5ms 直接跳转。

### 12. syncTick 服务端 elapsed 计算有锁外读取风险

```go
rm.Mu.RLock()
pos := rm.Position
startT := rm.StartTime
rm.Mu.RUnlock()
// ...
elapsed := time.Since(startT).Seconds()  // ← 在锁外计算
currentPos := pos + elapsed
```

从释放锁到计算 elapsed 之间，如果有 seek/pause 操作改变了 Position/StartTime，这里算出的 currentPos 就是错的。虽然概率低，但会导致偶发的 syncTick 位置跳变。

---

## 优先修复建议

效果最大的单一改动：**让 getCurrentTime() 基于 serverPlayTime + clockSync**，并在 _scheduleAhead 中用它来校正 _nextSegTime。这一个改动就能把 syncTick 从空操作变成持续纠正，直接利用 clockSync 的 5-15ms 精度。

### 误差预算（修复前 vs 修复后）

| 场景 | 修复前 | 修复后（预期） |
|------|--------|---------------|
| 同局域网 | ~14ms 常态，偶发 20-30ms | ~5-6ms |
| 跨局域网 | ~24ms 常态，偶发 30-40ms | ~15-16ms |
