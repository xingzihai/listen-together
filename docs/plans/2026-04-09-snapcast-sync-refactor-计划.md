# 方案C 实施计划

> 复用 Snapcast 同步算法，实现 ≤10ms 同步精度

## 一、架构设计

### 最终架构（Snapcast 简化版）

```
┌─────────────────────────────────────────────────────┐
│  Server                                             │
│  ├── main.go — COOP/COEP headers（新增）            │
│  ├── syncTick（每 1s 广播）                         │
│  └── play 消息附带 serverTime + scheduledAt        │
└─────────────────────────────────────────────────────┘
         ↕ WebSocket
┌─────────────────────────────────────────────────────┐
│  Client                                             │
│  │                                                  │
│  ├── sync.js — ClockSync（已有，不修改）            │
│  │                                                  │
│  ├── worklet-processor.js（修改）                   │
│  │   ├── Ring Buffer（已有）                        │
│  │   ├── SharedArrayBuffer（新增）                  │
│  │   │   └── Atomics.store(consumed)               │
│  │   └── Soft Correction（已有）                    │
│  │                                                  │
│  └── player.js（重写）                              │
│  │   ├── Lookahead Scheduler（保留）                │
│  │   ├── SharedArrayBuffer 读取（新增）             │
│  │   ├── getCurrentTime()（重写）                   │
│  │   │   └── return anchorPos + consumed/sr        │
│  │   ├── _driftLoop()（重写）                       │
│  │   │   └── Snapcast Soft Correction ±0.05%       │
│  │   └── 移除 Tier 2/3 playbackRate                │
│  │                                                  │
│  └── Tier 3 硬重置（保留但阈值降低）                 │
└─────────────────────────────────────────────────────┘
```

---

## 二、分阶段实施计划

### Phase 1：COOP/COEP Headers（启用 SharedArrayBuffer）

**目标**：让浏览器允许使用 SharedArrayBuffer

**判断边界**：[低判断区可直接执行] — 标准 HTTP header 添加

**修改文件**：`main.go`

**具体操作**：

1. 创建 securityHeaders middleware 函数
2. 在 HTTP handler chain 中应用
3. 测试 headers 是否生效

**代码预览**：

```go
func securityHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
        w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
        next.ServeHTTP(w, r)
    })
}

// 应用到所有路由
http.ListenAndServe(":8080", securityHeaders(limitedMux))
```

**验收标准**：
- Chrome DevTools → Network → Response Headers 显示 COOP/COEP
- Console 无 SharedArrayBuffer 警告

---

### Phase 2：worklet SharedArrayBuffer 支持

**目标**：worklet 能原子更新 consumed frames

**判断边界**：[低判断区可直接执行] — 标准 Atomics API 使用

**修改文件**：`worklet-processor.js`

**具体操作**：

1. 添加 `_sharedView` 属性（BigInt64Array）
2. 添加 `init-shared` 消息处理
3. 在 `clear` 消息处理中重置 shared counter
4. 在 `process()` 末尾调用 `Atomics.store()`

**代码预览**：

```javascript
class ListenTogetherProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._sharedView = null; // 新增
        // ... 其他初始化 ...
    }

    _onMessage(msg) {
        // 新增：接收 SharedArrayBuffer
        if (msg.type === 'init-shared') {
            this._sharedView = new BigInt64Array(msg.buffer);
            return;
        }
        
        // 修改：clear 时重置 shared counter
        if (msg.type === 'clear') {
            // ... 现有 clear 逻辑 ...
            if (this._sharedView) {
                Atomics.store(this._sharedView, 0, 0n);
            }
        }
        
        // ... 其他消息处理 ...
    }

    process(inputs, outputs) {
        // ... 现有 process 逻辑 ...
        
        // 新增：原子更新 consumed
        if (this._sharedView) {
            Atomics.store(this._sharedView, 0, BigInt(this._totalConsumedFrames));
        }
        
        return true;
    }
}
```

**验收标准**：
- worklet 不报错
- 主线程能读取到 consumed frames

---

### Phase 3：player.js 重写

**目标**：Snapcast 简化版同步逻辑

**判断边界**：[高判断区需人确认] — 核心同步逻辑重写，需验证设计正确性

**修改文件**：`player.js`

**具体操作**：

#### 3.1 添加 SharedArrayBuffer 初始化

```javascript
constructor() {
    // 新增
    this._sharedBuffer = null;
    this._sharedView = null;
    this._sabSupported = typeof SharedArrayBuffer !== 'undefined';
    
    // 新增：Snapcast 锚点
    this._anchorPos = 0;
    this._anchorServerTime = 0;
    this._nominalRate = 48000;
    this._maxCorrectionRate = 0.0005; // ±0.05%
    
    // 删除
    // - _driftOffset
    // - _pendingDriftCorrection
    // - _softCorrectionTotal
    // - _rateCorrectingUntil
    // - _currentPlaybackRate
    // - _rateStartTime
}
```

#### 3.2 初始化 SharedArrayBuffer（在 _createWorkletNode 或 init 中）

```javascript
_initSharedBuffer() {
    if (this._sabSupported && !this._sharedBuffer) {
        try {
            this._sharedBuffer = new SharedArrayBuffer(8);
            this._sharedView = new BigInt64Array(this._sharedBuffer);
            if (this.workletNode) {
                this.workletNode.port.postMessage({
                    type: 'init-shared',
                    buffer: this._sharedBuffer
                });
            }
        } catch (e) {
            console.warn('[sync] SharedArrayBuffer init failed:', e);
            this._sabSupported = false;
        }
    }
}
```

#### 3.3 重写 getCurrentTime()

```javascript
getCurrentTime() {
    if (!this.isPlaying || !this.ctx) return this.lastPosition || 0;
    
    const sr = this._nominalRate;
    
    // 零延迟读取 consumed frames
    let consumed;
    if (this._sabSupported && this._sharedView) {
        consumed = Number(Atomics.load(this._sharedView, 0));
    } else {
        // Fallback：使用 postMessage stats（有延迟）
        consumed = this._workletConsumed || 0;
    }
    
    // Snapcast 公式
    const pos = this._anchorPos + consumed / sr;
    
    // Clamp to duration
    if (this.duration > 0 && pos > this.duration) pos = this.duration;
    
    return pos;
}
```

#### 3.4 重写 playAtPosition()

```javascript
async playAtPosition(position, serverTime, scheduledAt) {
    this.init();
    this.stop();
    this.isPlaying = true;
    
    // 初始化 SharedArrayBuffer
    this._initSharedBuffer();
    
    // 重置 shared counter
    if (this._sharedView) {
        Atomics.store(this._sharedView, 0, 0n);
    }
    
    // Snapcast 锚点设定
    this._anchorPos = position;
    this._anchorServerTime = serverTime || window.clockSync.getServerTime();
    
    // 清空 worklet
    if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'clear' });
        this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
    }
    
    // ... 保留现有的 Lookahead Scheduler 逻辑 ...
    
    // 启动 drift loop（每 250ms）
    this._driftTimer = setInterval(() => this._driftLoop(), 250);
}
```

#### 3.5 重写 _driftLoop()

```javascript
_driftLoop() {
    if (!this.isPlaying || !this._anchorServerTime) return;
    
    const serverNow = window.clockSync.getServerTime();
    const elapsedSec = (serverNow - this._anchorServerTime) / 1000;
    const expectedPos = this._anchorPos + elapsedSec;
    const actualPos = this.getCurrentTime();
    const driftSec = actualPos - expectedPos;
    const driftSamples = driftSec * this._nominalRate;
    
    // Debug 显示
    const driftEl = document.getElementById('driftStatus');
    if (driftEl) {
        driftEl.textContent = `Drift: ${(driftSec*1000).toFixed(1)}ms`;
    }
    
    const absDrift = Math.abs(driftSec);
    
    // Tier 3：硬重置（阈值降低到 100ms）
    if (absDrift > 0.1) {
        console.warn(`[sync] hard resync: drift=${(driftSec*1000).toFixed(0)}ms`);
        const gen = this._resyncGen;
        this.playAtPosition(expectedPos, serverNow)
            .finally(() => { if (this._resyncGen === gen) this._resyncing = false; });
        return;
    }
    
    // Soft Correction（最大 ±0.05%）
    if (absDrift > 0.001) { // > 1ms
        const correctionTimeSec = 5; // 5秒内修正
        const samplesPerSec = driftSamples / correctionTimeSec;
        
        // 安全限制
        const maxRate = this._nominalRate * this._maxCorrectionRate;
        const clampedRate = Math.max(-maxRate, Math.min(maxRate, samplesPerSec));
        
        if (Math.abs(clampedRate) < 0.5) {
            // drift 太小
            this.workletNode?.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
        } else {
            const corrX = Math.round(this._nominalRate / Math.abs(clampedRate));
            // drift > 0 → 超前 → 减速 → duplicate → negative
            // drift < 0 → 落后 → 加速 → drop → positive
            const sign = driftSec > 0 ? -1 : 1;
            this.workletNode?.port.postMessage({
                type: 'correction',
                correctAfterXFrames: sign * corrX
            });
        }
    } else {
        this.workletNode?.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
    }
}
```

#### 3.6 删除不需要的代码

**删除项**：
- `_driftOffset` 相关逻辑
- `_pendingDriftCorrection` 相关逻辑
- `_softCorrectionTotal` 相关逻辑
- `_rateCorrectingUntil` 相关逻辑
- `_currentPlaybackRate` 相关逻辑
- `_rateStartTime` 相关逻辑
- Tier 1 `_nextSegTime` 调整逻辑
- Tier 2 playbackRate ±2-3% 逻辑
- `correctDrift()` 中的三层判断

**验收标准**：
- getCurrentTime() 精度 ±2ms
- drift 收敛到 <10ms
- 无 playbackRate 变调

---

## 三、数据流设计

### 时间同步数据流

```
ClockSync.handlePong(msg)
    │
    ├── offset = serverTime - (clientTime + rtt/2)
    │
    └── this.offset = EMA(offset)
    
getServerTime()
    │
    └── return Date.now() + this.offset
```

### 播放位置数据流（Snapcast）

```
worklet.process()
    │
    ├── 消费 PCM frames
    │
    ├── this._totalConsumedFrames += consumed
    │
    └── Atomics.store(this._sharedView, 0, consumed)  ← 原子更新
    
player.getCurrentTime()
    │
    ├── consumed = Atomics.load(this._sharedView, 0)  ← 零延迟读取
    │
    └── return this._anchorPos + consumed / sampleRate
    
drift检测
    │
    ├── expectedPos = anchorPos + elapsedSec
    │
    ├── actualPos = getCurrentTime()
    │
    ├── drift = actualPos - expectedPos
    │
    └── Soft Correction → worklet
```

---

## 四、关键不变量

1. **唯一时钟源**：服务器墙钟（通过 ClockSync.getServerTime()）
2. **唯一位置源**：worklet consumed frames（通过 SharedArrayBuffer）
3. **锚点不变**：anchorPos 在 playAtPosition 时设定，之后不变
4. **修正限制**：最大 ±0.05%（无感知）
5. **硬重置阈值**：100ms（从 200ms 降低）

---

## 五、验收测试计划

### 测试 1：精度测试

**步骤**：
1. 两个浏览器窗口打开同一房间
2. 同时播放同一音频
3. 观察 drift 显示（应 <10ms）

**预期**：漂移稳定在 ±10ms 内

---

### 测试 2：underrun 测试

**步骤**：
1. 播放音频
2. 模拟网络卡顿（DevTools → Network → Slow 3G）
3. 观察 getCurrentTime() 是否正确

**预期**：
- underrun 时位置不虚高
- 恢复后位置正确追赶

---

### 测试 3：后台恢复测试

**步骤**：
1. 播放音频
2. 切换到其他标签页（后台）
3. 等待 30 秒
4. 切换回来

**预期**：同步自动恢复，drift <50ms

---

### 测试 4：长时间测试

**步骤**：
1. 播放 10 分钟音频
2. 观察 drift 是否收敛

**预期**：漂移收敛到 <1ms，不累积

---

### 测试 5：兼容性测试

**步骤**：
1. Chrome 测试
2. Firefox 测试
3. Safari 测试（SAB 可能不支持）

**预期**：
- Chrome/Firefox：SAB 正常工作
- Safari：fallback 到 postMessage

---

## 六、风险预案

| 风险 | 触发条件 | 预案 |
|------|----------|------|
| COOP/COEP 影响资源加载 | 静态资源加载失败 | 检查 CORS 配置，添加 `Cross-Origin-Resource-Policy` |
| SAB 浏览器不支持 | Safari 报错 | fallback 到 postMessage，提高频率到 20ms |
| 大漂移处理慢 | Tier 3 不触发 | 降低阈值到 50ms |
| Lookahead 冲突 | segment 调度异常 | 测试并调整 _scheduleAhead |