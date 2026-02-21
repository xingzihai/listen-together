# 同步算法最终审计报告

## 审计结论

当前实现在核心数学上是正确的，三重锚点校准、serverTimeToCtx映射、playAtPosition位置计算、偏差检测参考系均逻辑自洽。发现1个HIGH级问题（source.start()过去时间导致音频截断）、2个MEDIUM级问题和2个LOW级问题。

## 发现的问题（按严重程度排序）

### [HIGH] source.start()在过去时间时的音频截断问题

- 文件：player.js 第183-195行（`_scheduleAhead`方法）
- 现象：`playAtPosition`计算出的`ctxSegStart`通常在过去（因为我们从segment中间开始播放）。当`schedTime < ctx.currentTime`时，Web Audio API的行为是**立即开始播放**，但`offset`参数仍然从指定的`off`位置开始。这意味着：
  - 假设ctxSegStart在0.3秒前，offsetInSeg=1.2秒
  - source.start(ctxSegStart, 1.2) 会立即播放，从1.2秒处开始
  - 但实际上应该从1.5秒处开始（因为已经过了0.3秒）
  - 结果：播放位置比预期**落后0.3秒**，会听到已经"过去"的0.3秒音频
- 根因：Web Audio API的`source.start(when, offset)`中，当`when`在过去时，会立即播放但不会自动调整offset来补偿时间差。音频从offset处开始，而不是从offset+(now-when)处开始。
- **重要更正**：经过更仔细的分析，Web Audio API规范（W3C）指出：当`when`在过去时，`start(when, offset)`的行为等价于`start(0, offset)`，即立即从offset开始播放。**不会**自动跳过`(now-when)`的部分。但是，由于`_nextSegTime = t + dur`的计算，下一个segment的调度时间会基于这个过去的时间点，所以下一个segment的schedTime = ctxSegStart + (buffer.duration - firstSegOffset)，这个时间可能仍然在过去或刚好在未来。如果在未来，则下一个segment会正确调度。
- 实际影响分析：
  - 第一个segment：schedTime在过去，立即播放，从offsetInSeg开始。用户会听到从offsetInSeg开始的音频，而不是从actualPos开始。差异 = ctxNow - ctxSegStart（通常几十到几百毫秒）。
  - getCurrentTime()在ctxNow时刻返回 startOffset + (ctxNow - startTime) = serverPlayPosition + (ctxNow - ctxAtServerTime) = actualPos。这是正确的。
  - 所以**听到的音频**比getCurrentTime()报告的位置**落后**了(ctxNow - ctxSegStart)秒。
- 修复方案：在_scheduleAhead中，当schedTime在过去时，调整offset以补偿时间差：
```javascript
// 在 _scheduleAhead 中，source.start 之前：
const now = this.ctx.currentTime;
let actualOff = off;
let actualSchedTime = schedTime;
if (schedTime < now) {
    // Compensate: skip the audio that "should have already played"
    const skipTime = now - schedTime;
    actualOff = off + skipTime;
    actualSchedTime = now; // start immediately
    // If we've skipped past this entire segment, move to next
    if (actualOff >= buffer.duration) {
        this._nextSegTime = t + (buffer.duration - off);
        this._nextSegIdx = i + 1;
        this._isFirstSeg = false;
        continue;
    }
}
source.start(actualSchedTime, actualOff);
// Also update dur for _nextSegTime calculation:
// _nextSegTime should still be t + (buffer.duration - off), not affected by skip
```

### [MEDIUM] clockSync锚点更新可能导致短暂虚假偏差

- 文件：app.js 第155-160行（syncTick handler中更新serverPlayTime/Position）
- 现象：syncTick handler在非冷却期会更新`ap.serverPlayTime`和`ap.serverPlayPosition`。这些值本身不影响getCurrentTime()（getCurrentTime用的是startOffset和startTime）。但如果clockSync在两次syncTick之间重新校准，新的锚点会改变`getServerTime()`的返回值，从而改变networkDelay的计算。
- 根因：networkDelay = (clockSync.getServerTime() - msg.serverTime) / 1000。如果clockSync刚重新校准，getServerTime()可能跳变几毫秒。但由于syncTick每秒发送一次，msg.serverTime是服务器当时的时间，getServerTime()是客户端估算的当前服务器时间，两者之差就是网络延迟+处理延迟。clockSync跳变会导致networkDelay计算偏差，进而导致serverPos偏差。
- 影响：通常clockSync的EMA平滑限制了跳变幅度（delta<5ms时blend 70/30），所以虚假偏差通常<5ms，远低于200ms阈值。但在网络切换时（samples清空重建），可能出现较大跳变。
- 修复方案：这个问题在实践中影响很小，因为：(1) 连续3次超200ms才触发resync；(2) 网络切换时clockSync会burst重新校准。建议保持现状，但可以在网络切换时重置_driftCount：
```javascript
// 在 clockSync.handlePong() 的网络变化检测中，添加：
if (window.audioPlayer) window.audioPlayer._driftCount = 0;
```

### [MEDIUM] syncTick中serverPlayTime/Position更新与getCurrentTime()的潜在不一致

- 文件：app.js 第155-160行
- 现象：syncTick更新了`ap.serverPlayTime`和`ap.serverPlayPosition`，但这些值在当前架构中**不被getCurrentTime()使用**。getCurrentTime()只用startOffset和startTime（在playAtPosition中设置）。serverPlayTime/Position只在_upgradeQuality中被重新设置。
- 根因：这些字段是历史遗留，当前架构中它们的更新是无害的（不影响播放），但也是无用的。唯一的用途是在_upgradeQuality的恢复路径中，但那里也重新设置了它们。
- 修复方案：可以移除syncTick中对这两个字段的更新，减少混淆。或者添加注释说明这些字段的用途。

### [LOW] EMA平滑中ctx锚点的blend可能引入微小误差

- 文件：sync.js 第120-128行
- 现象：当delta<5ms时，对server和ctx分别做EMA blend。currentCtxEstimate的计算是：`this.anchorCtxTime + (newAnchorPerf - this.anchorPerfTime) / 1000`。这假设ctx时钟和perf时钟以相同速率前进，但实际上它们可能有微小的时钟漂移。
- 影响：极小。两次校准之间通常只有10秒（稳态），ctx和perf的漂移在10秒内通常<0.1ms。
- 修复方案：无需修复，当前实现已足够精确。

### [LOW] 冷却期内不更新serverPlayTime/Position的注释误导

- 文件：app.js 第155-160行
- 现象：注释暗示冷却期内不更新是为了避免干扰，但实际上这些字段不影响getCurrentTime()。
- 修复方案：添加注释说明这些字段在当前架构中不影响播放位置计算。

## 正确性验证

### sync.js 三重锚点

#### ping()采样顺序（第72-77行）

```javascript
this._pendingCtx = ctx ? ctx.currentTime : 0;  // ctx先
this._pending = performance.now();               // perf后
this._pendingWall = Date.now();                   // wall最后
```

顺序：ctx → perf → wall。注释说"ctx first (least volatile)"。ctx.currentTime是硬件时钟驱动的只读属性，读取开销极小（通常<1μs）。perf和wall紧随其后。三者采样间隔在微秒级，可忽略。✅ 正确。

#### handlePong()中ctxMidpoint（第87-95行）

```javascript
const ctxMidpoint = ctxAtSend + (ctxNow - ctxAtSend) / 2;
```

推导：
- ctxAtSend = ping发送时的ctx.currentTime
- ctxNow = pong接收时的ctx.currentTime
- 假设RTT对称（去程=回程），服务器处理pong的时刻在中间点
- ctx.currentTime是线性递增的（AudioContext以恒定采样率驱动），所以线性插值是精确的
- ctxMidpoint = ctxAtSend + (ctxNow - ctxAtSend) / 2 = (ctxAtSend + ctxNow) / 2 ✅ 正确

#### 三重锚点加权平均（第107-118行）

```javascript
ctxOffsetSum += (kept[i].serverTime - kept[i].ctxTime * 1000) * w;
```

- serverTime单位：ms
- ctxTime单位：s
- ctxTime * 1000 → ms
- ctxOffset = serverTime(ms) - ctxTime*1000(ms) → 单位ms ✅

```javascript
const bestCtxOffset = ctxOffsetSum / weightSum;  // 单位ms
```

#### newAnchorCtx计算（第122行）

```javascript
const newAnchorCtx = (newAnchorServer - bestCtxOffset) / 1000;
```

推导：
- bestCtxOffset ≈ serverTime - ctxTime*1000（对于最佳样本）
- 即 bestCtxOffset ≈ S - C*1000，其中S=serverTime(ms), C=ctxTime(s)
- newAnchorServer = best.perfTime + bestPerfOffset ≈ 某个serverTime值(ms)
- newAnchorCtx = (newAnchorServer - bestCtxOffset) / 1000
  = (newAnchorServer - (S - C*1000)) / 1000

让我们用具体值验证：
- 假设某样本：serverTime=1000000ms, ctxTime=50.000s, perfTime=500000ms
- bestCtxOffset = 1000000 - 50.000*1000 = 1000000 - 50000 = 950000ms
- bestPerfOffset = 1000000 - 500000 = 500000ms
- newAnchorServer = 500000 + 500000 = 1000000ms（等于该样本的serverTime）
- newAnchorCtx = (1000000 - 950000) / 1000 = 50000 / 1000 = 50.000s ✅

这正好等于该样本的ctxTime，验证通过。

但注意：当有多个样本时，bestPerfOffset和bestCtxOffset是加权平均值，而newAnchorPerf = best.perfTime（最低RTT样本的perfTime）。所以newAnchorServer不一定等于best.serverTime，newAnchorCtx也不一定等于best.ctxTime。这是正确的——我们用加权平均的offset来修正最佳样本的时间点。✅

#### EMA平滑（第125-133行）

```javascript
const currentEstimate = this.anchorServerTime + (newAnchorPerf - this.anchorPerfTime);
const blendedServer = 0.7 * currentEstimate + 0.3 * newAnchorServer;
const currentCtxEstimate = this.anchorCtxTime + (newAnchorPerf - this.anchorPerfTime) / 1000;
const blendedCtx = 0.7 * currentCtxEstimate + 0.3 * newAnchorCtx;
```

- currentEstimate：用旧锚点+perf时间差推算当前serverTime。单位ms。✅
- currentCtxEstimate：用旧ctx锚点+perf时间差(转秒)推算当前ctxTime。假设ctx和perf以相同速率前进。单位s。✅（微小漂移可忽略）
- blend比例一致（70/30），server和ctx锚点同步更新。✅

#### serverTimeToCtx()（第143-148行）

```javascript
return this.anchorCtxTime + (serverTimeMs - this.anchorServerTime) / 1000;
```

推导：
- anchorCtxTime(s) 对应 anchorServerTime(ms)
- 对于任意serverTimeMs，对应的ctxTime = anchorCtxTime + (serverTimeMs - anchorServerTime) / 1000
- 单位：s + ms/1000 = s + s = s ✅

#### getServerTime()（第137-141行）

```javascript
return this.anchorServerTime + (performance.now() - this.anchorPerfTime);
```

- anchorServerTime(ms) + (perfNow - anchorPerfTime)(ms) = 当前serverTime(ms) ✅

### player.js playAtPosition

#### ctxAtServerTime（第143行）

```javascript
const ctxAtServerTime = cs.serverTimeToCtx(this.serverPlayTime);
```

serverTimeToCtx返回serverPlayTime对应的ctx.currentTime值。✅

#### currentPos计算（第147行）

```javascript
const currentPos = this.serverPlayPosition + (ctxNow - ctxAtServerTime);
```

推导：
- 在ctxAtServerTime时刻，播放位置是serverPlayPosition
- ctx.currentTime以1秒/秒的速率前进（AudioContext的时间轴）
- 经过(ctxNow - ctxAtServerTime)秒后，播放位置前进了同样的秒数
- currentPos = serverPlayPosition + (ctxNow - ctxAtServerTime) ✅

#### segIdx2、segStart、offsetInSeg（第150-152行）

```javascript
const segIdx2 = Math.floor(actualPos / this.segmentTime);
const segStart = segIdx2 * this.segmentTime;
const offsetInSeg = actualPos - segStart;
```

标准的segment定位计算。✅

#### ctxSegStart（第155行）

```javascript
const ctxSegStart = ctxAtServerTime + (segStart - this.serverPlayPosition);
```

推导：
- 在ctxAtServerTime时刻，位置是serverPlayPosition
- segStart是当前segment的起始位置（秒）
- segStart - serverPlayPosition = 从serverPlayPosition到segStart的时间差（秒）
- ctxSegStart = ctxAtServerTime + (segStart - serverPlayPosition)
- 这是segment开始播放时对应的ctx.currentTime值 ✅

注意：如果segStart < serverPlayPosition（不可能，因为segStart = floor(actualPos/segTime)*segTime，而actualPos >= serverPlayPosition当ctxNow >= ctxAtServerTime时），所以ctxSegStart <= ctxAtServerTime，即在过去。✅

#### startOffset和startTime（第159-160行）

```javascript
this.startOffset = this.serverPlayPosition;
this.startTime = ctxAtServerTime;
```

验证getCurrentTime()：
- getCurrentTime() = startOffset + (ctx.currentTime - startTime)
- 在ctxAtServerTime时刻：= serverPlayPosition + (ctxAtServerTime - ctxAtServerTime) = serverPlayPosition ✅
- 在ctxNow时刻：= serverPlayPosition + (ctxNow - ctxAtServerTime) = actualPos ✅

#### _startLookaheadAnchored（第163行）

```javascript
this._startLookaheadAnchored(segIdx2, offsetInSeg, ctxSegStart);
```

设置：
- _nextSegIdx = segIdx2
- _nextSegTime = ctxSegStart
- _firstSegOffset = offsetInSeg

在_scheduleAhead中：
- 第一个segment：off = offsetInSeg, schedTime = ctxSegStart
- dur = buffer.duration - offsetInSeg
- _nextSegTime = ctxSegStart + dur = ctxSegStart + buffer.duration - offsetInSeg

对于后续segment：
- off = 0, schedTime = 上一个的_nextSegTime
- dur = buffer.duration
- _nextSegTime += buffer.duration

这确保了segment之间无缝衔接。✅

#### _startLookahead（非anchored版本，第170行）

```javascript
this._nextSegTime = ctxStartTime;
```

这个版本用于_upgradeQuality，ctxStartTime = this.ctx.currentTime。设置方式与anchored版本一致。✅

### 偏差检测一致性

#### syncTick handler（app.js第148-170行）

```javascript
const actualPos = ap.getCurrentTime();
const networkDelay = Math.max(0, (window.clockSync.getServerTime() - msg.serverTime) / 1000);
const serverPos = msg.position + networkDelay;
const drift = actualPos - serverPos;
```

分析参考系：
1. actualPos = getCurrentTime() = startOffset + (ctx.currentTime - startTime)
   = serverPlayPosition + (ctxNow - ctxAtServerTime)
   这是基于playAtPosition时建立的锚点，表示"当前应该播放到的位置"

2. serverPos = msg.position + networkDelay
   - msg.position = 服务器计算的当前位置 = room.Position + time.Since(room.StartTime).Seconds()
   - networkDelay = (clientEstimatedServerTime - msg.serverTime) / 1000
   - msg.serverTime = 服务器发送syncTick时的时间
   - networkDelay ≈ 消息传输延迟（秒）
   - serverPos ≈ 服务器位置 + 传输延迟 = 客户端收到消息时服务器的位置

3. 两者都表示"当前时刻应该播放到的位置"，参考系一致。✅

#### 冷却期内不更新serverPlayTime/Position

```javascript
if (!ap._lastResetTime || performance.now() - ap._lastResetTime > ap._RESET_COOLDOWN) {
    ap.serverPlayTime = msg.serverTime;
    ap.serverPlayPosition = msg.position;
}
```

这些字段在当前架构中不被getCurrentTime()使用，所以冷却期内不更新不会影响getCurrentTime()的返回值。✅

但注意：如果冷却期后更新了这些字段，它们也不会影响播放。这些字段目前只在_upgradeQuality中被使用。

#### forceResync handler（app.js第200-207行）

```javascript
ap.playAtPosition(msg.position, msg.serverTime);
```

正确调用playAtPosition，传入服务器的权威位置和时间。✅

### 服务器端验证

#### requestResync（main.go第340-365行）

```go
currentPos := currentRoom.Position + time.Since(currentRoom.StartTime).Seconds()
```

这是服务器的权威位置计算。Room.Play()设置Position和StartTime，之后elapsed = time.Since(StartTime)。✅

Room级别冷却期：5秒。✅

#### syncTick（main.go第120-150行）

```go
elapsed := time.Since(startT).Seconds()
currentPos := pos + elapsed
```

与requestResync使用相同的计算方式。✅

position有duration clamp。✅

## source.start()过去时间行为分析

根据W3C Web Audio API规范（AudioBufferSourceNode.start()）：

1. `source.start(when, offset)` — 当`when`在过去（`when < ctx.currentTime`）时：
   - 规范说：如果`when`在过去，播放立即开始
   - `offset`参数不受影响——音频从buffer的offset位置开始播放
   - **不会**自动跳过`(ctx.currentTime - when)`的时间

2. 对本项目的影响：
   - playAtPosition计算ctxSegStart通常在过去（因为从segment中间开始）
   - 例：ctxSegStart = 100.0, offsetInSeg = 2.3, ctxNow = 100.05
   - source.start(100.0, 2.3) → 立即从2.3秒处开始播放
   - 但实际上应该从2.35秒处开始（补偿0.05秒的延迟）
   - 结果：音频输出比预期落后0.05秒

3. 实际影响评估：
   - playAtPosition的执行时间（从计算ctxNow到source.start）通常在1-5ms
   - 加上_scheduleAhead的异步调度延迟，总延迟可能在5-20ms
   - 这个延迟在大多数情况下不可感知（人耳对音乐的同步感知阈值约30-50ms）
   - 但在极端情况下（segment需要加载、网络延迟大），延迟可能更大

4. 关于`_nextSegTime`的正确性：
   - _nextSegTime = ctxSegStart + (buffer.duration - offsetInSeg)
   - 这是下一个segment应该开始的ctx时间
   - 如果第一个segment的source.start在过去，音频立即播放
   - 下一个segment的schedTime = _nextSegTime，通常在未来
   - 所以后续segment的调度是正确的
   - 但第一个segment和第二个segment之间会有一个微小的间隙（= ctxNow - ctxSegStart）

## 建议

1. **修复HIGH问题**：在_scheduleAhead中补偿过去时间的offset。这是唯一需要代码修改的问题。

2. **保持现有架构**：三重锚点、直接serverTime→ctx映射、偏差检测机制都是正确的。

3. **考虑添加日志**：在playAtPosition中记录ctxNow - ctxSegStart的值，用于监控第一个segment的延迟。

4. **清理遗留字段**：serverPlayTime/serverPlayPosition在syncTick中的更新可以移除或添加注释说明其用途仅限于_upgradeQuality。

5. **网络切换时重置driftCount**：在clockSync检测到网络变化时，重置audioPlayer._driftCount，避免虚假resync。
