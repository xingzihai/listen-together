# 方案B 实施任务清单（worklet Ring Buffer 架构）

> Bite-sized TDD 格式，每个任务独立可测试

## Phase 1：COOP/COEP Headers

### 任务 1.1：创建 securityHeaders middleware
- **文件**：`main.go`
- **操作**：添加 securityHeaders 函数
- **判断边界**：[低判断区]
- **验收**：函数定义正确，编译无错误
- **状态**：待执行

### 任务 1.2：应用 middleware 到 HTTP handler
- **文件**：`main.go`
- **操作**：在 `http.ListenAndServe` 中应用 securityHeaders
- **判断边界**：[低判断区]
- **验收**：编译无错误，服务启动正常
- **状态**：待执行

### 任务 1.3：测试 headers 是否生效
- **操作**：启动服务，Chrome DevTools 检查 Response Headers
- **验收**：显示 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`
- **状态**：待执行

---

## Phase 2：worklet SharedArrayBuffer 支持

### 任务 2.1：添加 _sharedView 属性
- **文件**：`worklet-processor.js`
- **操作**：constructor 中添加 `this._sharedView = null`
- **判断边界**：[低判断区]
- **验收**：worklet 不报错
- **状态**：待执行

### 任务 2.2：添加 init-shared 消息处理
- **文件**：`worklet-processor.js`
- **操作**：_onMessage 中添加 `msg.type === 'init-shared'` 处理
- **判断边界**：[低判断区]
- **验收**：能接收 SharedArrayBuffer 并赋值到 _sharedView
- **状态**：待执行

### 任务 2.3：clear 时重置 shared counter
- **文件**：`worklet-processor.js`
- **操作**：_onMessage `clear` 处理中添加 `Atomics.store(this._sharedView, 0, 0n)`
- **判断边界**：[低判断区]
- **验收**：clear 后 shared counter 为 0
- **状态**：待执行

### 任务 2.4：process 末尾原子更新 consumed
- **文件**：`worklet-processor.js`
- **操作**：process() 末尾添加 `Atomics.store(this._sharedView, 0, BigInt(this._totalConsumedFrames))`
- **判断边界**：[低判断区]
- **验收**：主线程能读取到更新后的 consumed
- **状态**：待执行

---

## Phase 3：player.js 重写（worklet Ring Buffer 架构）

### 任务 3.1：删除 Lookahead Scheduler
- **文件**：`player.js`
- **操作**：删除 `_startLookahead`, `_stopLookahead`, `_scheduleAhead` 方法和相关属性
- **判断边界**：[低判断区]
- **验收**：代码编译无错误
- **状态**：待执行

### 任务 3.2：删除 AudioBufferSourceNode 相关代码
- **文件**：`player.js`
- **操作**：删除 `this.sources` 数组和 AudioBufferSourceNode 创建逻辑
- **判断边界**：[低判断区]
- **验收**：代码编译无错误
- **状态**：待执行

### 任务 3.3：添加 SharedArrayBuffer 相关属性
- **文件**：`player.js`
- **操作**：constructor 中添加 `_sharedBuffer`, `_sharedView`, `_sabSupported`, `_anchorPos`, `_anchorServerTime`, `_nominalRate`, `_maxCorrectionRate`, `_workletConsumed`, `_workletBuffered`
- **判断边界**：[低判断区]
- **验收**：属性定义正确
- **状态**：待执行

### 任务 3.4：删除不需要的属性
- **文件**：`player.js`
- **操作**：删除 `_driftOffset`, `_pendingDriftCorrection`, `_softCorrectionTotal`, `_rateCorrectingUntil`, `_currentPlaybackRate`, `_rateStartTime`, `_nextSegIdx`, `_nextSegTime`, `_firstSegOffset`, `_isFirstSeg`
- **判断边界**：[低判断区]
- **验收**：代码编译无错误
- **状态**：待执行

### 任务 3.5：新增 _createWorkletNode 方法
- **文件**：`player.js`
- **操作**：添加 `_createWorkletNode()` 方法，创建 AudioWorkletNode 并监听 stats
- **判断边界**：[高判断区 — 核心架构]
- **验收**：worklet 节点创建成功，能接收 stats 消息
- **状态**：待执行

### 任务 3.6：新增 _initSharedBuffer 方法
- **文件**：`player.js`
- **操作**：添加 `_initSharedBuffer()` 方法
- **判断边界**：[低判断区]
- **验收**：能创建 SharedArrayBuffer 并发送给 worklet
- **状态**：待执行

### 任务 3.7：新增 _feedPCMSegments 方法
- **文件**：`player.js`
- **操作**：添加 `_feedPCMSegments(startPos)` 方法，解码 segment 并发送 PCM 到 worklet
- **判断边界**：[高判断区 — 核心逻辑]
- **验收**：PCM 数据正确发送到 worklet
- **状态**：待执行

### 任务 3.8：新增 _feedLoop 方法
- **文件**：`player.js`
- **操作**：添加 `_feedLoop()` 方法，定期检查并补充 buffer
- **判断边界**：[低判断区]
- **验收**：buffer 保持 3-5 秒
- **状态**：待执行

### 任务 3.9：重写 getCurrentTime()
- **文件**：`player.js`
- **操作**：用 Snapcast 公式重写，从 SharedArrayBuffer 读取 consumed
- **判断边界**：[高判断区 — 核心逻辑]
- **验收**：返回 `anchorPos + consumed/sr`，精度 ±2ms
- **状态**：待执行

### 任务 3.10：重写 playAtPosition()
- **文件**：`player.js`
- **操作**：
  - 调用 `_createWorkletNode()`
  - 调用 `_initSharedBuffer()`
  - 设定 `_anchorPos` 和 `_anchorServerTime`
  - 调用 `_feedPCMSegments()`
  - 启动 `_feedTimer` 和 `_driftTimer`
- **判断边界**：[高判断区 — 核心逻辑]
- **验收**：锚点设定正确，PCM 开始播放
- **状态**：待执行

### 任务 3.11：重写 _driftLoop()
- **文件**：`player.js`
- **操作**：
  - 计算期望位置（Snapcast 公式）
  - 获取真实位置（getCurrentTime）
  - 计算 drift
  - Soft Correction（最大 ±0.05%）
  - Tier 3 硬重置（阈值 100ms）
- **判断边界**：[高判断区 — 核心逻辑]
- **验收**：drift 计算正确，发送 correction 消息
- **状态**：待执行

### 任务 3.12：修改 stop() 方法
- **文件**：`player.js`
- **操作**：清理 `_feedTimer` 和 `_driftTimer`，清空 worklet
- **判断边界**：[低判断区]
- **验收**：stop() 不报错
- **状态**：待执行

---

## Phase 4：测试验证

### 任务 4.1：精度测试
- **操作**：两个浏览器窗口同时播放，测量漂移
- **验收**：漂移 <10ms
- **状态**：待执行

### 任务 4.2：underrun 测试
- **操作**：模拟网络卡顿，检查 getCurrentTime()
- **验收**：underrun 时位置不虚高
- **状态**：待执行

### 任务 4.3：后台恢复测试
- **操作**：切换标签页后台 30 秒，切换回来
- **验收**：同步恢复，drift <50ms
- **状态**：待执行

### 任务 4.4：长时间测试
- **操作**：播放 10 分钟，观察 drift
- **验收**：漂移收敛到 <1ms
- **状态**：待执行

---

## 执行进度

| Phase | 任务数 | 已完成 | 进度 |
|-------|--------|--------|------|
| Phase 1 | 3 | 0 | 0% |
| Phase 2 | 4 | 0 | 0% |
| Phase 3 | 12 | 0 | 0% |
| Phase 4 | 4 | 0 | 0% |
| **总计** | **23** | **0** | **0%** |

---

## 当前执行批次

**批次 1**：Phase 1（任务 1.1-1.3）
**批次 2**：Phase 2（任务 2.1-2.4）
**批次 3**：Phase 3 删除任务（任务 3.1-3.4）
**批次 4**：Phase 3 新增属性和方法（任务 3.5-3.8）
**批次 5**：Phase 3 重写核心逻辑（任务 3.9-3.12）
**批次 6**：Phase 4（任务 4.1-4.4）

---

## 更新记录

| 时间 | 完成任务 | 备注 |
|------|----------|------|
| 2026-04-09 | - | 初始化完成，切换到方案B（worklet Ring Buffer架构） |