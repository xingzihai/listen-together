# ListenTogether 音频同步架构设计 v3

> 目标：跨设备同步精度 ≤10ms，无变速/变调/爆音/卡顿

## 1. 问题根因分析

### 为什么之前5次尝试都失败了

核心矛盾：**主线程无法实时获取 worklet 的精确播放位置**。

| 尝试 | 方法 | 失败原因 |
|------|------|----------|
| 1 | consumed vs ctx.currentTime | consumed 通过 postMessage 异步传递，100ms stats 间隔导致 stale |
| 2 | 都用 ctx.currentTime | ctx.currentTime 是墙钟（AudioContext 创建后单调递增），不是播放位置 |
| 3 | getCurrentTime 用 ctx.currentTime | underrun 时 ctx.currentTime 照走，播放位置不走 |
| 4 | 插值 consumed | underrun 时假设持续消费，虚高 |
| 5 | 锚点 feed 后重设 | feed 时机不确定，和数据实际开始播放的时刻不一致 |

**根本解法：用 SharedArrayBuffer 让主线程零延迟读取 worklet 内部的 consumed 计数器。**

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  Main Thread                                             │
│                                                          │
│  ClockSync ──→ serverTime = Date.now() + offset          │
│       │                                                  │
│  getCurrentTime():                                       │
│       │  consumed = Atomics.load(sharedBuf, 0..1)  ◄─────┼── 零延迟读取
│       │  pos = anchorPos + consumed / sampleRate         │
│       │                                                  │
│  _driftLoop() (250ms):                                   │
│       │  expected = serverPlayPos + (serverNow - T0)/1000│
│       │  actual = getCurrentTime()                       │
│       │  drift = actual - expected                       │
│       │  → median buffers → hard sync / soft correction  │
│                                                          │
│  _feedSegments():                                        │
│       │  decode → crossfade → postMessage(transfer)      │
│       │  anchorPos 在首次 feed 时设定，之后不变           │
└───────┼──────────────────────────────────────────────────┘
        │ SharedArrayBuffer (8 bytes = 1 BigInt64)
        │ postMessage (PCM transfer)
┌───────┼──────────────────────────────────────────────────┐
│  AudioWorklet Thread                                     │
│                                                          │
│  process():                                              │
│       │  从 ring buffer 读取 → 输出                      │
│       │  totalConsumedFrames += consumed                 │
│       │  Atomics.store(sharedBuf, 0..1, totalConsumed)   │
│       │                                                  │
│  Soft Correction (correctAfterXFrames):                  │
│       │  每 N 帧 drop 1 帧（加速）或 duplicate 1 帧（减速）│
│       │  N = sampleRate / |drift_in_samples_per_sec|     │
│       │  最大修正率 ±0.05% (±24 samples/s @48kHz)        │
└──────────────────────────────────────────────────────────┘
```

## 3. 关键设计决策

### 3.1 时钟源统一

**唯一时钟源：服务器墙钟（通过 ClockSync.getServerTime()）**

- 服务器时间 = `Date.now() + clockSync.offset`
- offset 通过 NTP-like 协议计算，median 滤波
- 所有设备用同一个服务器时钟比较，消除本地时钟差异

**播放位置时钟：worklet consumed frames（通过 SharedArrayBuffer 实时读取）**

- `getCurrentTime() = anchorPos + atomicConsumed / sampleRate`
- anchorPos 在 playAtPosition 时设定，等于目标播放位置
- consumed 从 0 开始，由 worklet process() 原子递增
- underrun 时 consumed 不增长 → 位置自然停住 ✓
- 无插值、无估算、无 stale 问题 ✓

### 3.2 锚点设定时机

**关键洞察：锚点必须在 worklet clear 之后、首次 feed 之前设定。**

```
playAtPosition(targetPos):
  1. worklet.clear()           // consumed 归零
  2. anchorPos = targetPos     // 锚点 = 目标位置
  3. feed segments             // 数据从 targetPos 对应的 PCM 开始
  4. worklet 开始 process()    // consumed 从 0 递增
  → getCurrentTime() = targetPos + 0/sr = targetPos ✓
  → 播放 1 秒后 = targetPos + 48000/48000 = targetPos + 1 ✓
```

feed 延迟不影响，因为 consumed 在数据到达前为 0，位置不会虚高。

### 3.3 Soft Correction（参考 Snapcast）

Snapcast 的 `setRealSampleRate` 算法：

```javascript
// realRate = nominalRate * (1 + correction)
// correction > 0 → 播放太慢，需要加速（drop frames）
// correction < 0 → 播放太快，需要减速（duplicate frames）
//
// correctAfterXFrames = nominalRate / |nominalRate - realRate|
//                     = 1 / |1 - realRate/nominalRate|
//
// 正值 = 每 N 帧 drop 1 帧（加速）
// 负值 = 每 N 帧 duplicate 1 帧（减速）
```

**安全限制：**
- 最大修正率 ±0.05%（每秒最多 ±24 帧 @48kHz）
- `|correctAfterXFrames|` 最小值 = 2000（= 48000/24）
- 人耳对 ±0.05% 的采样率变化完全无感知
- 不使用 playbackRate（会变调），不使用 Web Audio 重采样

### 3.4 SharedArrayBuffer 方案

```javascript
// 初始化（主线程）
const sab = new SharedArrayBuffer(8); // 8 bytes for BigInt64
const sharedView = new BigInt64Array(sab);

// 传递给 worklet
workletNode.port.postMessage({ type: 'init-shared', buffer: sab });

// worklet 内部（每次 process）
Atomics.store(this._sharedView, 0, BigInt(this._totalConsumedFrames));

// 主线程读取（零延迟）
const consumed = Number(Atomics.load(sharedView, 0));
```

**Fallback：** 如果浏览器不支持 SharedArrayBuffer（需要 COOP/COEP headers），
退回 postMessage stats 模式，但增加 query 频率到 20ms（从 100ms 降低）。

## 4. 具体代码改动

### 4.1 worklet-processor.js

```javascript
// === 新增：SharedArrayBuffer 支持 ===

class ListenTogetherProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // ... 现有代码 ...
        this._sharedView = null; // BigInt64Array over SharedArrayBuffer
        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    _onMessage(msg) {
        if (msg.type === 'init-shared') {
            // 接收 SharedArrayBuffer
            this._sharedView = new BigInt64Array(msg.buffer);
            return;
        }
        // ... 现有 pcm/correction/clear/query 处理 ...
        if (msg.type === 'clear') {
            // ... 现有 clear 逻辑 ...
            // 重置 shared counter
            if (this._sharedView) {
                Atomics.store(this._sharedView, 0, 0n);
            }
        }
    }

    process(inputs, outputs) {
        // ... 现有 process 逻辑（不变）...

        // 在 process 末尾，更新 consumed 到 shared memory
        // （在现有的 this._totalConsumedFrames += consumed 之后）
        if (this._sharedView) {
            Atomics.store(this._sharedView, 0, BigInt(this._totalConsumedFrames));
        }

        return true;
    }
}
```

### 4.2 player.js — SharedArrayBuffer 初始化

```javascript
// === AudioPlayer 构造函数新增 ===
this._sharedBuffer = null;  // SharedArrayBuffer
this._sharedView = null;    // BigInt64Array
this._sabSupported = typeof SharedArrayBuffer !== 'undefined';

// === _createWorkletNode() 修改 ===
_createWorkletNode() {
    // ... 现有创建逻辑 ...

    // 初始化 SharedArrayBuffer
    if (this._sabSupported) {
        try {
            this._sharedBuffer = new SharedArrayBuffer(8);
            this._sharedView = new BigInt64Array(this._sharedBuffer);
            this.workletNode.port.postMessage({
                type: 'init-shared',
                buffer: this._sharedBuffer
            });
        } catch (e) {
            console.warn('[audio] SharedArrayBuffer not available:', e);
            this._sabSupported = false;
        }
    }
}
```

### 4.3 player.js — getCurrentTime() 重写

```javascript
getCurrentTime() {
    if (!this.isPlaying || !this.ctx) return this.lastPosition || 0;
    const sr = this._workletSampleRate || this.ctx.sampleRate || 48000;

    let consumed;
    if (this._sabSupported && this._sharedView) {
        // 零延迟：直接从 SharedArrayBuffer 读取
        consumed = Number(Atomics.load(this._sharedView, 0));
    } else {
        // Fallback：使用 postMessage stats（有延迟）
        consumed = this._workletConsumed;
    }

    const pos = this._feederStartPos + (consumed - (this._consumedBaseline || 0)) / sr;
    return this.duration > 0 ? Math.min(pos, this.duration) : pos;
}
```

### 4.4 player.js — _driftLoop() 启用 Soft Correction

```javascript
_driftLoop() {
    if (!this.isPlaying || !this.serverPlayTime || this._hardSyncing) return;
    if (performance.now() - this._playStartedAt < 3000) return; // 缩短到3s

    const serverNow = window.clockSync.getServerTime();
    const expectedPos = this.serverPlayPosition + (serverNow - this.serverPlayTime) / 1000;
    const actualPos = this.getCurrentTime();
    const ageMs = (actualPos - expectedPos) * 1000;
    const ageUs = ageMs * 1000;

    this._miniBuffer.add(ageUs);
    this._shortBuffer.add(ageUs);
    this._longBuffer.add(ageUs);

    const miniMedian = this._miniBuffer.median();
    const shortMedian = this._shortBuffer.median();
    const longMedian = this._longBuffer.median();

    this._updateDebugDisplay(ageMs, miniMedian, shortMedian, longMedian, actualPos);

    // === Hard Sync（不变，但阈值微调）===
    if ((this._longBuffer.full() && Math.abs(longMedian) > 2000 && Math.abs(ageMs) > 5) ||
        (this._shortBuffer.full() && Math.abs(shortMedian) > 5000 && Math.abs(ageMs) > 5) ||
        (this._miniBuffer.full() && Math.abs(miniMedian) > 50000 && Math.abs(ageMs) > 20) ||
        (Math.abs(ageMs) > 500)) {  // 从1000ms降到500ms
        if (performance.now() - this._lastHardSync < 3000) return;
        this._lastHardSync = performance.now();
        this._hardSyncing = true;
        const srvNow = window.clockSync.getServerTime();
        const srvPos = this.serverPlayPosition + (srvNow - this.serverPlayTime) / 1000;
        this.playAtPosition(srvPos, srvNow).finally(() => { this._hardSyncing = false; });
        return;
    }

    // === Soft Correction（新增）===
    // 使用 shortBuffer median 做 soft correction（需要足够样本）
    if (this._shortBuffer.size() >= 20) {
        const driftMs = shortMedian / 1000; // 微秒→毫秒
        const sr = this._workletSampleRate || this.ctx?.sampleRate || 48000;

        if (Math.abs(driftMs) > 0.5) {
            // 目标：在 5 秒内修正当前 drift
            // driftSamples = driftMs / 1000 * sr
            // samplesPerSec = driftSamples / 5
            // correctAfterXFrames = sr / samplesPerSec
            const driftSamples = (driftMs / 1000) * sr;
            const correctionTimeSec = 5;
            const samplesPerSec = driftSamples / correctionTimeSec;

            // 安全限制：最大 ±0.05% = ±24 samples/s @48kHz
            const maxRate = sr * 0.0005; // 24 @48kHz
            const clampedRate = Math.max(-maxRate, Math.min(maxRate, samplesPerSec));

            if (Math.abs(clampedRate) < 0.5) {
                // drift 太小，不修正
                this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
            } else {
                // correctAfterXFrames: 正值=drop(加速), 负值=duplicate(减速)
                // drift > 0 means we're ahead → need to slow down → duplicate → negative
                // drift < 0 means we're behind → need to speed up → drop → positive
                const corrX = Math.round(sr / Math.abs(clampedRate));
                const sign = driftMs > 0 ? -1 : 1; // ahead→slow down(neg), behind→speed up(pos)
                this.workletNode.port.postMessage({
                    type: 'correction',
                    correctAfterXFrames: sign * corrX
                });
                this._log('softCorr', { driftMs: +driftMs.toFixed(2), corrX: sign * corrX });
            }
        } else {
            // drift < 0.5ms，停止修正
            this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
        }
    }
}
```

### 4.5 player.js — playAtPosition() 修改

```javascript
async playAtPosition(position, serverTime, scheduledAt) {
    await this.init(this._sampleRate || undefined);
    this.stop();
    this.isPlaying = true;
    this._feederGen++;
    const gen = this._feederGen;

    // 重置 SharedArrayBuffer
    if (this._sabSupported && this._sharedView) {
        Atomics.store(this._sharedView, 0, 0n);
    }

    this.serverPlayTime = scheduledAt || serverTime || window.clockSync.getServerTime();
    this.serverPlayPosition = position || 0;
    this._playStartedAt = performance.now();
    this._miniBuffer.clear(); this._shortBuffer.clear(); this._longBuffer.clear();

    if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'clear' });
        this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
    }
    this._fedFrames = 0; this._fedSinceLastStats = 0;
    this._workletConsumed = 0; this._workletBuffered = 0; this._workletTotalPlayed = 0;
    this._consumedBaseline = 0;

    // ... preload 逻辑不变 ...

    // scheduledAt 等待逻辑不变 ...

    const elapsed = Math.max(0, (window.clockSync.getServerTime() - this.serverPlayTime) / 1000);
    let actualPos = this.serverPlayPosition + elapsed;

    // 锚点 = 数据起始位置，consumed 从 0 开始
    this._feederStartPos = actualPos;
    this._feederNextSeg = Math.floor(actualPos / this.segmentTime);
    this._feederSegOffset = actualPos - this._feederNextSeg * this.segmentTime;

    await this._feedSegments(gen, 2);
    if (!this.isPlaying || gen !== this._feederGen) return;

    this._playStartedAt = performance.now();
    this._feederTimer = setInterval(() => this._feedLoop(gen), 100);
    this._driftTimer = setInterval(() => this._driftLoop(), 250);
    this._logUploadTimer = setInterval(() => this.uploadLog(), 30000);
}
```

### 4.6 HTTP Headers（COOP/COEP for SharedArrayBuffer）

Go 后端需要添加以下 headers：

```go
// 在 HTTP handler 或 middleware 中添加
func securityHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
        w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
        next.ServeHTTP(w, r)
    })
}
```

## 5. 时钟路径走查

### 路径 A：设备 1 开始播放

```
1. Host 点击 play(pos=30s)
2. Server: scheduledAt = serverTime + 500ms (buffer)
3. Server → all clients: { type: 'play', position: 30, serverTime: T0, scheduledAt: T0+500 }
4. Client 收到消息，调用 playAtPosition(30, T0, T0+500)
5. Client 等待到 scheduledAt（本地时间 = scheduledAt - clockSync.offset）
6. worklet.clear() → consumed = 0, SharedArrayBuffer = 0
7. anchorPos = 30 + elapsed（elapsed ≈ 0，因为刚到 scheduledAt）
8. feed segment 6 (30s/5s) 从 offset 0 开始
9. worklet process() 开始消费 → consumed 递增
10. getCurrentTime() = 30 + consumed/48000
```

### 路径 B：drift 检测

```
1. _driftLoop() 每 250ms 执行
2. serverNow = Date.now() + clockSync.offset
3. expectedPos = 30 + (serverNow - T0) / 1000
4. actualPos = getCurrentTime() = 30 + atomicConsumed / 48000
5. drift = (actualPos - expectedPos) * 1000 (ms)
6. 如果 drift = +3ms（播放超前）→ shortMedian 积累
7. soft correction: 每 N 帧 duplicate 1 帧减速
8. 如果 drift = -300ms（严重落后）→ hard sync: playAtPosition(expectedPos)
```

### 路径 C：underrun 场景

```
1. 网络卡顿，worklet ring buffer 耗尽
2. worklet process() 输出静音，consumed 不增长
3. SharedArrayBuffer 值不变
4. getCurrentTime() 返回的位置停住
5. drift 检测发现 actualPos < expectedPos → drift 为负
6. 如果 drift > 500ms → hard sync
7. 如果 drift < 500ms → soft correction 加速追赶
```

**✓ 无矛盾：underrun 时位置不虚高，恢复后自然追赶。**

### 路径 D：syncTick（服务器周期性同步）

```
1. Server 每 5s 发送 syncTick: { serverTime: Tnow, position: Pnow }
2. Client 更新 serverPlayTime = Tnow, serverPlayPosition = Pnow
3. 清空 miniBuffer/shortBuffer（避免混合新旧锚点的样本）
4. _driftLoop 用新锚点继续计算
5. getCurrentTime() 不受影响（基于 anchorPos + consumed）
```

## 6. 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| SharedArrayBuffer 不可用（缺少 COOP/COEP） | 中 | 退回 stale consumed，精度降到 ±50ms | Fallback 模式 + 提高 stats 频率到 20ms |
| Safari 不支持 SharedArrayBuffer in AudioWorklet | 中 | 同上 | 检测并 fallback |
| Soft correction 导致可感知的音质变化 | 低 | 用户听到异常 | 限制最大修正率 ±0.05%，远低于感知阈值 |
| clockSync offset 跳变 | 低 | drift 突变触发不必要的 hard sync | median 滤波 + offset 跳变检测已有 |
| ring buffer overflow（feed 太快） | 低 | 丢弃旧数据 | 现有 overflow 处理 + feed 前检查 buffered |
| 多次 hard sync 循环（drift 始终无法收敛） | 低 | 反复重启播放 | 3s cooldown + soft correction 应能在 hard sync 后收敛 |
| BigInt64 性能 | 极低 | 每次 process() 一次 Atomics.store | 开销 <1μs，可忽略 |

## 7. 实施顺序

1. **Phase 1：SharedArrayBuffer**（最高优先级）
   - 添加 COOP/COEP headers
   - worklet-processor.js 添加 shared memory 支持
   - player.js 初始化 SAB + 重写 getCurrentTime()
   - 验证：drift 显示应该从 ±100ms 降到 ±5ms

2. **Phase 2：Soft Correction**
   - 在 _driftLoop 中启用 soft correction
   - 验证：长时间播放 drift 不累积

3. **Phase 3：Fallback + 兼容性**
   - Safari/Firefox 测试
   - 无 SAB 时的 fallback 路径
   - 提高 stats 频率作为 fallback

## 8. 预期效果

| 指标 | 当前 | Phase 1 后 | Phase 2 后 |
|------|------|-----------|-----------|
| getCurrentTime 精度 | ±100ms | ±2ms | ±2ms |
| 跨设备同步精度 | ±200ms | ±10ms | ±5ms |
| 长时间 drift 累积 | 无限增长 | 有限（无 soft corr） | 收敛到 <1ms |
| Hard sync 频率 | 频繁 | 偶尔 | 极少 |
