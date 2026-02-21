# ListenTogether 前端攻防测试场景（完整版）

> 版本：v0.8.0 | 生成日期：2026-02-21  
> 基于源码审计：player.js, sync.js, app.js, auth.js, cache.js, worklet-processor.js, index.html  
> 已知缺陷：P2 WS重连拦截器失效、P5 soft correction虚假修正

---

## A. 音频引擎（Audio Engine）

### A-01 AudioContext 未初始化时调用 playAtPosition
- **分类**：A音频引擎 | **严重程度**：🔴
- **攻击向量**：在 `init()` 未被调用前，通过 WS 消息直接触发 `doPlay()`，此时 `this.ctx` 为 null
- **测试步骤**：
  1. 拦截 WS 消息，在 `setupAudio()` 完成前注入 `play` 消息
  2. 观察 `playAtPosition()` 中 `this.ctx.currentTime` 是否抛出 TypeError
- **预期结果**：应有防御性检查，优雅降级或排队等待初始化
- **实际风险评估**：`playAtPosition` 内部调用了 `this.init()`，但 `getCurrentTime()` 在 `this.ctx` 为 null 时仅返回 fallback 值，风险中等
- **应对策略**：在所有依赖 `ctx` 的方法入口添加 null guard

### A-02 AudioContext suspended 状态下的静默播放
- **分类**：A音频引擎 | **严重程度**：🟡
- **攻击向量**：浏览器自动播放策略阻止 AudioContext resume，用户未交互时收到 play 指令
- **测试步骤**：
  1. 打开页面后不进行任何点击交互
  2. 通过另一客户端发送 play 指令
  3. 检查 `ctx.state` 是否仍为 `suspended`
- **预期结果**：应提示用户点击以激活音频，或在用户交互后自动恢复
- **实际风险评估**：`init()` 调用了 `ctx.resume()` 但未 await 其 Promise，可能在 resume 完成前就开始调度 segment
- **应对策略**：`await this.ctx.resume()` 并在 UI 层显示交互提示

### A-03 segment 解码失败导致播放链断裂
- **分类**：A音频引擎 | **严重程度**：🔴
- **攻击向量**：服务端返回损坏的音频数据或 HTTP 409 被拦截器替换为空 ArrayBuffer
- **测试步骤**：
  1. 拦截 `/api/library/segments/` 请求，返回随机二进制数据
  2. 观察 `decodeAudioData` 是否抛出异常
  3. 检查 `_scheduleAhead` 是否因 `buffer` 为 undefined 而中断整个 lookahead 链
- **预期结果**：单个 segment 解码失败应跳过该 segment 并继续播放
- **实际风险评估**：`loadSegment` 中 `decodeAudioData` 异常会向上冒泡，`_scheduleAhead` 的 `break` 会终止后续所有 segment 调度——**高危**
- **应对策略**：在 `loadSegment` 中 catch `decodeAudioData` 异常，返回静音 buffer 或跳过

### A-04 Fetch 拦截器将 409 替换为空 Response 的副作用
- **分类**：A音频引擎 | **严重程度**：🟡
- **攻击向量**：index.html 中的 fetch 拦截器将 `/segments/` 的 409 响应替换为空 `ArrayBuffer(0)`
- **测试步骤**：
  1. 模拟服务端对 segment 请求返回 409
  2. 观察 `decodeAudioData(new ArrayBuffer(0))` 的行为
- **预期结果**：空 ArrayBuffer 解码应失败，但不应导致整个播放崩溃
- **实际风险评估**：`ArrayBuffer(0)` 解码必定失败，触发 A-03 的连锁问题
- **应对策略**：拦截器应返回有效的静音音频数据，或在 player 层处理空 buffer

### A-05 quality 升级期间的竞态条件
- **分类**：A音频引擎 | **严重程度**：🟡
- **攻击向量**：在 `_upgradeQuality` 异步下载过程中，用户切换曲目或触发 `stop()`
- **测试步骤**：
  1. 开始播放并触发 quality 升级（如 medium → lossless）
  2. 在升级下载过程中快速切换下一首
  3. 检查 `_upgrading` 标志和 buffer 状态一致性
- **预期结果**：切换曲目应取消正在进行的升级，不应出现新旧 segment 混合
- **实际风险评估**：`_upgradeQuality` 通过 `this._upgrading` 标志检查，但 `stop()` 设置 `_upgrading = false` 后，异步循环中的 `if (!this._upgrading) return` 可能在 await 点之间遗漏
- **应对策略**：引入 AbortController 或 generation counter 来取消进行中的升级

### A-06 lookahead 调度器内存泄漏（sources 数组无限增长）
- **分类**：A音频引擎 | **严重程度**：🟡
- **攻击向量**：长时间播放场景下，`source.onended` 回调被浏览器 GC 延迟或未触发
- **测试步骤**：
  1. 连续播放 2 小时以上
  2. 监控 `window.audioPlayer.sources.length` 的变化趋势
  3. 检查内存占用是否持续增长
- **预期结果**：已播放完毕的 source 应被及时清理，sources 数组长度应保持稳定
- **实际风险评估**：`onended` 依赖浏览器回调，在后台标签页中可能被节流，导致 sources 累积
- **应对策略**：在 `_scheduleAhead` 中主动清理 `ctx.currentTime` 之前的 source

### A-07 segmentTime 与实际 buffer duration 不匹配
- **分类**：A音频引擎 | **严重程度**：🟡
- **攻击向量**：FLAC 编码的 segment 因块对齐填充导致实际 duration > segmentTime
- **测试步骤**：
  1. 使用 lossless 品质播放
  2. 检查每个 segment 的 `buffer.duration` 与 `segmentTime` 的差值
  3. 观察 trimming 逻辑是否正确裁剪非末尾 segment
- **预期结果**：非末尾 segment 应被精确裁剪到 segmentTime 长度
- **实际风险评估**：`loadSegment` 中有 trimming 逻辑，但仅对 `buffer.length > expectedSamples` 生效；若 `buffer.length < expectedSamples`（短于预期），不做处理，可能导致 gap
- **应对策略**：对短于预期的 segment 也进行填充处理

### A-08 crossfade 参数在极短 segment 上的异常
- **分类**：A音频引擎 | **严重程度**：🟢
- **攻击向量**：最后一个 segment 的 duration 可能极短（<10ms），crossfade 的 3ms fade 时间可能超过 segment 本身
- **测试步骤**：
  1. 上传一首总时长不是 segmentTime 整数倍的音频
  2. 播放到最后一个 segment
  3. 检查 `fadeOutStart = t + effectiveDur - fadeTime` 是否为负值
- **预期结果**：极短 segment 应跳过 crossfade 或使用更短的 fade 时间
- **实际风险评估**：若 `effectiveDur < fadeTime`，`fadeOutStart` 会早于 `t`，导致 gain 调度异常
- **应对策略**：添加 `if (effectiveDur > fadeTime * 2)` 条件守卫

### A-09 playbackRate 修正期间的 getCurrentTime 计算偏差
- **分类**：A音频引擎 | **严重程度**：🟡
- **攻击向量**：Tier 2 playbackRate 修正期间，`getCurrentTime()` 的补偿计算依赖 `_rateStartTime`，但 `_rateStartTime` 可能在 `stop()` 后被重置为 0
- **测试步骤**：
  1. 触发 50-200ms 的漂移使 playbackRate 修正激活
  2. 在修正期间暂停再恢复播放
  3. 检查 `getCurrentTime()` 返回值是否跳变
- **预期结果**：暂停/恢复不应导致位置跳变
- **实际风险评估**：`stop()` 将 `_rateStartTime` 重置为 0，但 `getCurrentTime()` 中 `this._rateStartTime` 为 0 时条件不成立，安全；但 `startOffset` 未包含已完成的 rate 补偿量——**中危**
- **应对策略**：在 `stop()` 中将 rate 补偿量累加到 `lastPosition`

### A-10 gainNode fade-out 与 source.stop() 的时序竞争
- **分类**：A音频引擎 | **严重程度**：🟢
- **攻击向量**：`stop()` 中 5ms fade-out 后 10ms 延迟 stop sources，但 `setTimeout` 精度不保证
- **测试步骤**：
  1. 快速连续调用 play/stop/play
  2. 监听是否有 click/pop 音频伪影
  3. 检查 `gainNode.gain.value` 在新播放开始时是否已恢复为 1.0
- **预期结果**：快速切换不应产生音频伪影
- **实际风险评估**：`setTimeout(10ms)` 内 stop 旧 sources，但新 `playAtPosition` 可能在此之前已开始调度新 sources 到同一 gainNode
- **应对策略**：为每次播放创建独立的 gainNode，或使用 generation counter 隔离

### A-11 worklet ring buffer 溢出时的数据丢失
- **分类**：A音频引擎 | **严重程度**：🟡
- **攻击向量**：PCM 数据写入速度超过消费速度时，worklet 丢弃最旧数据
- **测试步骤**：
  1. 模拟高延迟网络环境，使 PCM 数据突发到达
  2. 监控 worklet 的 `overflow` 消息
  3. 检查丢弃的帧数是否导致可感知的音频跳跃
- **预期结果**：溢出处理应平滑，不应产生明显的音频断裂
- **实际风险评估**：worklet 的溢出处理直接移动 `_readPos` 跳过旧数据，无 crossfade，会产生 click
- **应对策略**：在溢出时对跳跃边界做短 crossfade

---

## B. 同步算法（Sync Algorithm）

### B-01 ClockSync 初始 burst 在高延迟网络下的样本污染
- **分类**：B同步算法 | **严重程度**：🟡
- **攻击向量**：初始 16 个 ping 在高延迟（>500ms）网络下，RTT 过滤阈值 `rtt > 1000` 可能放过低质量样本
- **测试步骤**：
  1. 使用网络节流模拟 600ms RTT
  2. 观察初始 sync 的 offset 收敛速度和精度
  3. 检查 `rtt > this.rtt * 2.5` 过滤器在初始阶段（`this.rtt = Infinity`）是否失效
- **预期结果**：初始阶段应有更严格的 RTT 过滤
- **实际风险评估**：当 `this.rtt = Infinity` 时，`rtt > this.rtt * 2.5` 永远为 false，所有 RTT < 1000ms 的样本都会被接受——**初始同步精度低**
- **应对策略**：初始阶段使用绝对 RTT 阈值而非相对阈值

### B-02 网络类型切换导致的同步状态重置风暴
- **分类**：B同步算法 | **严重程度**：🟡
- **攻击向量**：移动设备在 WiFi/4G 间频繁切换，每次触发 `samples = []` 和 `synced = false`
- **测试步骤**：
  1. 在移动设备上模拟 WiFi↔4G 快速切换（每 5 秒一次）
  2. 观察 `clockSync.synced` 状态和 offset 稳定性
  3. 检查是否触发连锁的 hard resync
- **预期结果**：频繁网络切换不应导致持续的同步失败
- **实际风险评估**：每次网络变化清空所有样本，需要重新收集 ≥3 个样本才能恢复 synced 状态，期间所有 drift correction 失效
- **应对策略**：保留部分低 RTT 历史样本，仅清除高 RTT 样本

### B-03 [P5-已知Bug] soft correction 虚假修正——pendingDriftCorrection 重复累加
- **分类**：B同步算法 | **严重程度**：🔴
- **攻击向量**：`correctDrift` 在 `_pendingDriftCorrection` 尚未被 `_scheduleAhead` 消费前被多次调用，导致 `_nextSegTime` 被反复调整
- **测试步骤**：
  1. 制造 5-50ms 的稳定漂移
  2. 在 200ms drift check 间隔内观察 `_pendingDriftCorrection` 的变化
  3. 检查同方向的 pending correction 是否被跳过（`Math.sign` 检查）
- **预期结果**：同方向的 pending correction 应被合并而非累加
- **实际风险评估**：**已知 P5 bug**。虽然有 `Math.sign` 方向检查，但 `_pendingDriftCorrection` 在 `_scheduleAhead` 中被清零后，下一次 `correctDrift` 又会重新添加，导致 `_nextSegTime` 被过度调整，产生反向漂移→振荡
- **应对策略**：soft correction 应基于「上次修正后的实际漂移」而非「当前绝对漂移」；引入修正后的冷却期

### B-04 drift correction 三层阈值的边界振荡
- **分类**：B同步算法 | **严重程度**：🟡
- **攻击向量**：漂移在 Tier 1/Tier 2 边界（~50ms）附近波动，导致交替触发 soft correction 和 playbackRate correction
- **测试步骤**：
  1. 制造 45-55ms 范围内波动的漂移
  2. 观察修正策略是否在两种模式间频繁切换
  3. 检查 playbackRate 是否被反复设置和重置
- **预期结果**：应有滞后区间（hysteresis）防止边界振荡
- **实际风险评估**：Tier 1 上界 50ms 与 Tier 2 下界 50ms 完全重合（`absDrift > 0.005 && absDrift <= 0.05` vs `absDrift > 0.05`），无滞后——**会振荡**
- **应对策略**：引入 5-10ms 的滞后区间，如 Tier 1 上界 55ms、Tier 2 下界 50ms

### B-05 hard resync 的指数退避导致长时间不同步
- **分类**：B同步算法 | **严重程度**：🟡
- **攻击向量**：连续触发 hard resync 后，`_resyncBackoff` 指数增长到 5000ms，期间漂移持续扩大
- **测试步骤**：
  1. 制造持续 >200ms 的漂移（如网络抖动）
  2. 观察 `_resyncBackoff` 的增长曲线
  3. 检查 watchdog（3s 间隔）是否能有效重置过大的 backoff
- **预期结果**：backoff 应在网络恢复后快速降低
- **实际风险评估**：watchdog 将 backoff 上限从 2000 提高到 5000，但 `_resyncBackoff` 增长因子为 1.5x，从 500 到 5000 需要 ~7 次失败，期间最长等待 5 秒
- **应对策略**：在 syncTick 收到新 anchor 时主动重置 backoff

### B-06 _driftOffset 累积超过 ±500ms 时的硬重置路径
- **分类**：B同步算法 | **严重程度**：🔴
- **攻击向量**：长时间运行中 soft correction 持续单方向累积，触发 `Math.abs(this._driftOffset + drift) > 0.5` 的硬重置
- **测试步骤**：
  1. 模拟持续的单方向微小漂移（如服务器时钟漂移 1ms/s）
  2. 运行 500 秒后检查 `_driftOffset` 是否接近 500ms
  3. 观察硬重置触发时的音频中断
- **预期结果**：应在累积到危险值之前采取渐进式修正
- **实际风险评估**：硬重置会导致可感知的音频中断（stop + restart），且重置后 `_driftOffset = 0`，漂移会重新累积——**周期性中断**
- **应对策略**：在 `_driftOffset` 达到 200ms 时切换到 playbackRate 修正模式

### B-07 playbackRate 修正结束时的 offset 补偿精度
- **分类**：B同步算法 | **严重程度**：🟡
- **攻击向量**：Tier 2 修正结束时，`startOffset += extraPlayed` 的计算依赖 `ctx.currentTime` 精度
- **测试步骤**：
  1. 触发 Tier 2 修正（50-200ms 漂移）
  2. 在修正结束瞬间检查 `getCurrentTime()` 的跳变量
  3. 对比修正前后的 drift 值
- **预期结果**：修正结束后 drift 应接近 0
- **实际风险评估**：`_scheduleAhead` 和 `correctDrift` 都有恢复逻辑，但存在竞态——两处都可能执行恢复，导致 `startOffset` 被双重补偿
- **应对策略**：使用 flag 确保恢复逻辑只执行一次

### B-08 scheduledAt 未来时间调度的时钟域混合
- **分类**：B同步算法 | **严重程度**：🟡
- **攻击向量**：`playAtPosition` 中将 `scheduledAt`（服务器时间）转换为本地 `ctx` 时间时，涉及 `clockSync.offset`、`Date.now()`、`performance.now()` 三个时钟域
- **测试步骤**：
  1. 在 clockSync offset 较大（>100ms）的环境下触发 scheduledAt 播放
  2. 检查 `waitMs` 计算是否准确
  3. 对比实际播放开始时间与预期时间的偏差
- **预期结果**：跨时钟域转换应精确到 <5ms
- **实际风险评估**：代码已通过同时捕获 `perfSnap` 和 `dateSnap` 来避免时钟域混合，设计合理；但 `clockSync.offset` 本身的精度限制了最终精度
- **应对策略**：在 debug panel 中显示 scheduledAt 的实际偏差

### B-09 outputLatency 补偿在不同设备上的差异
- **分类**：B同步算法 | **严重程度**：🟢
- **攻击向量**：`ctx.outputLatency` 在不同浏览器/设备上返回值差异大（0ms ~ 50ms），部分浏览器不支持
- **测试步骤**：
  1. 在 Chrome（支持 outputLatency）和 Firefox（不支持）上同时播放
  2. 对比两端的实际音频输出时间差
  3. 检查 fallback 到 `baseLatency` 的行为
- **预期结果**：不同设备间的同步误差应 <30ms
- **实际风险评估**：当 `outputLatency` 和 `baseLatency` 都为 0 时，latency 补偿完全失效，设备间可能有 20-50ms 的固有偏差
- **应对策略**：允许用户手动设置 latency 补偿值

### B-10 visibilitychange 后的 burst re-sync 有效性
- **分类**：B同步算法 | **严重程度**：🟡
- **攻击向量**：页面从后台恢复时，浏览器可能节流 `setTimeout`/`setInterval`，导致 burst ping 被延迟
- **测试步骤**：
  1. 将页面切到后台 30 秒以上
  2. 切回前台，观察 burst 8 个 ping 的实际发送间隔
  3. 检查 `_scheduleAhead` 被立即调用时，`ctx.currentTime` 是否已跳跃
- **预期结果**：恢复后应在 500ms 内完成重新同步
- **实际风险评估**：`_scheduleAhead` 被立即调用，但此时 clockSync 可能尚未完成 burst 重新同步，导致基于旧 offset 的错误调度
- **应对策略**：在 burst 完成后（延迟 500ms）再触发 `_scheduleAhead`，而非立即调用

### B-11 EMA 平滑在 offset 跳变时的响应延迟
- **分类**：B同步算法 | **严重程度**：🟢
- **攻击向量**：ClockSync 的 EMA（0.7/0.3 混合）在 offset 小幅跳变（<10ms）时响应缓慢
- **测试步骤**：
  1. 模拟服务器时钟突然跳变 8ms
  2. 观察 `clockSync.offset` 收敛到新值需要多少个样本
  3. 计算收敛期间的同步误差
- **预期结果**：8ms 跳变应在 5 个样本内收敛到 <1ms 误差
- **实际风险评估**：0.7/0.3 EMA 意味着每个样本只吸收 30% 的变化，8ms 跳变需要 ~7 个样本才能收敛到 <1ms，在 2000ms 稳定间隔下需要 ~14 秒
- **应对策略**：检测到 offset 跳变 >5ms 时临时切换到更激进的 EMA 系数（如 0.3/0.7）

---

## C. WebSocket 客户端（WebSocket Client）

### C-01 [P2-已知Bug] WS 重连拦截器失效——新连接未被 patch
- **分类**：C WebSocket客户端 | **严重程度**：🔴
- **攻击向量**：index.html 中的 WebSocket 拦截器（监听 `roomClosed`/`error` 清除 `lt_active_room`）仅在构造时 patch，但 `connect()` 创建的新 WS 实例绕过了拦截器
- **测试步骤**：
  1. 进入房间，确认 `lt_active_room` 已写入 localStorage
  2. 断开网络触发 WS 重连
  3. 在重连后由服务端发送 `roomClosed` 消息
  4. 检查 `lt_active_room` 是否被清除
- **预期结果**：重连后的 WS 实例也应被拦截器 patch
- **实际风险评估**：**已知 P2 bug**。拦截器通过覆盖 `window.WebSocket` 构造函数实现，理论上所有 `new WebSocket()` 都会经过。但 `connect()` 中 `ws = new WebSocket(...)` 返回的是原始 WS 实例（拦截器内部用 `new origWS()`），`addEventListener('message')` 确实被添加了。**实际问题可能在于：重连后 `ws.onmessage` 被 app.js 覆盖，而 index.html 的 statusReport 拦截器用 `setInterval(500ms)` 重新 patch `ws.onmessage`，可能覆盖了拦截器的 listener**
- **应对策略**：将 roomClosed 处理逻辑移入 app.js 的 `handleMessage` 中，而非依赖外部拦截器

### C-02 reconnect 指数退避上限过高导致长时间断连
- **分类**：C WebSocket客户端 | **严重程度**：🟡
- **攻击向量**：`reconnectDelay` 从 3000ms 指数增长到 `MAX_RECONNECT_DELAY = 60000ms`，10 次尝试后放弃
- **测试步骤**：
  1. 模拟网络中断 30 秒后恢复
  2. 观察重连尝试的时间间隔
  3. 计算从网络恢复到 WS 重连成功的最大等待时间
- **预期结果**：网络恢复后应在 5 秒内重连
- **实际风险评估**：第 5 次重连延迟已达 48s（3000 * 2^4），若网络在此期间恢复，用户需等待最长 48 秒
- **应对策略**：监听 `navigator.onLine` 事件，网络恢复时立即尝试重连

### C-03 WS onmessage 被多层拦截器覆盖的优先级混乱
- **分类**：C WebSocket客户端 | **严重程度**：🔴
- **攻击向量**：index.html 中 statusReport 的 `setInterval(500ms)` 持续覆盖 `ws.onmessage`，与 app.js 的 `ws.onmessage` 和 WebSocket 构造函数拦截器形成三层拦截
- **测试步骤**：
  1. 在 WS 连接建立后，每 500ms 检查 `ws.onmessage` 的引用是否变化
  2. 发送 `forceResync` 消息，检查是否被正确处理
  3. 发送普通消息，检查 `origOnMsg` 链是否完整
- **预期结果**：所有消息类型都应被正确路由到对应处理器
- **实际风险评估**：500ms 轮询覆盖 `ws.onmessage` 时捕获 `origOnMsg`，但如果 app.js 的 `handleMessage` 在覆盖之后又被其他代码修改，`origOnMsg` 指向的是旧引用——**消息丢失风险**
- **应对策略**：统一使用 `addEventListener('message')` 而非覆盖 `onmessage`

### C-04 JSON.parse 异常导致消息处理中断
- **分类**：C WebSocket客户端 | **严重程度**：🟡
- **攻击向量**：服务端发送非 JSON 格式的 WS 消息（如二进制帧或格式错误的文本）
- **测试步骤**：
  1. 通过 WS 代理注入非 JSON 文本消息
  2. 检查 `handleMessage(JSON.parse(e.data))` 是否抛出未捕获异常
  3. 观察后续消息是否仍能正常处理
- **预期结果**：解析失败应被 catch，不影响后续消息
- **实际风险评估**：`ws.onmessage = e => handleMessage(JSON.parse(e.data))` 无 try-catch，异常会冒泡到全局——**后续消息处理不受影响（每次调用独立），但会产生控制台错误**
- **应对策略**：在 `onmessage` 中添加 try-catch

### C-05 deviceKick 与 sessionExpired 的竞态
- **分类**：C WebSocket客户端 | **严重程度**：🟡
- **攻击向量**：同时收到 `deviceKick` WS 消息和 HTTP 401 响应，两者都会触发页面重载
- **测试步骤**：
  1. 在另一设备登录同一账号
  2. 同时触发 WS deviceKick 和 HTTP 401
  3. 检查是否出现双重 `alert()` 或双重 `location.reload()`
- **预期结果**：应只显示一次提示并重载一次
- **实际风险评估**：`deviceKicked = true` 标志阻止了 WS 重连，但 `sessionExpired()` 也设置 `deviceKicked = true` 并调用 `location.reload()`——两个路径可能先后执行，产生两次 alert
- **应对策略**：在 `sessionExpired` 和 `deviceKick` 处理中检查 `deviceKicked` 标志

### C-06 WS 连接在 auth 初始化前建立
- **分类**：C WebSocket客户端 | **严重程度**：🟡
- **攻击向量**：`window.addEventListener('load')` 中通过 `setInterval(200ms)` 等待 `Auth.user`，但 `Auth.init()` 是异步的
- **测试步骤**：
  1. 模拟 `/api/auth/me` 响应延迟 3 秒
  2. 检查 WS 是否在 auth 完成前尝试连接
  3. 观察 5 秒超时后 `clearInterval` 是否导致永远不连接
- **预期结果**：WS 连接应在 auth 成功后建立
- **实际风险评估**：`setTimeout(() => clearInterval(checkAuth), 5000)` 在 auth 超过 5 秒时会放弃连接尝试，用户需手动刷新
- **应对策略**：使用 Promise/callback 替代轮询，auth 完成后直接触发连接

### C-07 statusReport 在非播放状态下的无效发送
- **分类**：C WebSocket客户端 | **严重程度**：🟢
- **攻击向量**：`setInterval(2000ms)` 的 statusReport 在 `!ap.isPlaying` 时跳过，但 `getCurrentTime()` 可能在 `isPlaying` 刚变为 false 时仍返回旧值
- **测试步骤**：
  1. 暂停播放后立即检查 statusReport 是否还发送了一次
  2. 检查发送的 position 值是否准确
- **预期结果**：暂停后不应再发送 statusReport
- **实际风险评估**：低风险，最多多发一次无害的 report
- **应对策略**：可忽略，或在 pause 时主动发送最终 position

### C-08 hash 路由与 WS 房间状态不同步
- **分类**：C WebSocket客户端 | **严重程度**：🟡
- **攻击向量**：用户手动修改 URL hash 为无效房间码，或在 WS 断连期间通过 hash 尝试加入房间
- **测试步骤**：
  1. 手动将 URL hash 改为 `#INVALID1`
  2. 刷新页面，观察是否尝试加入不存在的房间
  3. 检查错误处理和 UI 状态
- **预期结果**：无效房间码应显示错误提示并回到首页
- **实际风险评估**：`handleMessage` 中 `error` 类型只调用 `alert(msg.error)`，不会自动回到首页，用户停留在空白 room 界面
- **应对策略**：在 error 处理中检查是否为 room 相关错误，自动回到首页

---

## D. UI 状态机（UI State Machine）

### D-01 screen 切换时的残留状态
- **分类**：D UI状态机 | **严重程度**：🟡
- **攻击向量**：从 room 切回 home 时，底部播放栏、debug panel、audience panel 等可能未被正确隐藏
- **测试步骤**：
  1. 进入房间并展开所有面板（audience、playlist、debug）
  2. 点击离开房间
  3. 检查所有面板的 visibility 状态
- **预期结果**：离开房间后所有房间相关 UI 应被隐藏
- **实际风险评估**：`leaveBtn.onclick` 手动隐藏了 `audiencePanel`，但 `playlistModal`、`debugPanel`、`libraryModal` 未被清理
- **应对策略**：在 `showScreen` 中统一清理所有 overlay/modal

### D-02 isHost 状态与 UI 控件的不一致
- **分类**：D UI状态机 | **严重程度**：🟡
- **攻击向量**：非 host 用户通过 DOM 操作移除按钮的 `disabled` 属性，绕过前端权限检查
- **测试步骤**：
  1. 以普通用户加入房间
  2. 在 DevTools 中移除 `playPauseBtn` 的 disabled 属性
  3. 点击播放按钮，检查是否发送了 WS 消息
- **预期结果**：服务端应拒绝非 host 的控制指令
- **实际风险评估**：`playPauseBtn.onclick` 中有 `if (!isHost || !audioInfo) return` 检查，但 `isHost` 是 JS 变量，可通过控制台修改——**前端权限检查可被绕过，依赖服务端验证**
- **应对策略**：确保服务端对所有控制指令验证 host 身份（前端检查仅为 UX 优化）

### D-03 hostTransfer 后的 UI 权限刷新不完整
- **分类**：D UI状态机 | **严重程度**：🟡
- **攻击向量**：收到 `hostTransfer` 消息后，`isHost = true` 但 prev/next 按钮的 disabled 状态未更新
- **测试步骤**：
  1. 原 host 离开房间，触发 hostTransfer
  2. 检查新 host 的 prev/next 按钮是否可用
  3. 检查播放列表项的点击事件是否响应
- **预期结果**：新 host 应立即获得所有控制权限
- **实际风险评估**：`hostTransfer` 处理中未调用 `updatePrevNextButtons()` 和 `renderPlaylist()`——**按钮保持 disabled**
- **应对策略**：在 hostTransfer 处理中调用 `updatePrevNextButtons()` 和 `renderPlaylist()`

### D-04 roleChanged 降级为 user 后的 UI 残留
- **分类**：D UI状态机 | **严重程度**：🟡
- **攻击向量**：owner 将 admin 降级为 user 时，`Auth.updateUIForRole('user')` 隐藏了创建按钮，但如果该用户正在房间内作为 host，房间不会立即关闭
- **测试步骤**：
  1. admin 用户创建房间并正在播放
  2. owner 将其降级为 user
  3. 检查房间状态和 UI 变化
- **预期结果**：降级后房间应被关闭或 host 权限被撤销
- **实际风险评估**：代码注释说"the room will be closed server-side"，但前端未主动处理——如果服务端未发送 roomClosed，用户仍保持 host 状态
- **应对策略**：前端收到 roleChanged 且新角色为 user 时，主动检查并退出房间

### D-05 MutationObserver 链的性能问题
- **分类**：D UI状态机 | **严重程度**：🟢
- **攻击向量**：index.html 中有 >10 个 MutationObserver 和 >8 个 setInterval，在低端设备上可能导致 UI 卡顿
- **测试步骤**：
  1. 在低端 Android 设备上打开页面
  2. 使用 Performance 面板记录 30 秒的运行时性能
  3. 检查 MutationObserver 回调和 setInterval 的 CPU 占用
- **预期结果**：总 CPU 占用应 <10%（空闲状态）
- **实际风险评估**：多个 300ms setInterval（歌词同步、封面状态、移动端同步）+ MutationObserver 链式触发，在低端设备上可能导致 >20% CPU 占用
- **应对策略**：合并同频率的 setInterval，使用 requestAnimationFrame 替代高频轮询

### D-06 播放列表渲染中的 innerHTML XSS 风险
- **分类**：D UI状态机 | **严重程度**：🟡
- **攻击向量**：`renderPlaylist` 中使用 `escapeHtml()` 处理标题和艺术家，但 `coverUrl` 直接拼接到 `img src` 中
- **测试步骤**：
  1. 上传一个 `audio_uuid` 包含特殊字符的音频文件
  2. 将其添加到播放列表
  3. 检查 `coverUrl` 是否被正确转义
- **预期结果**：所有动态内容应被转义
- **实际风险评估**：`audio_uuid` 来自服务端，通常为安全的 UUID 格式；但 `owner_id` 和 `filename` 也参与 URL 拼接，若被篡改可注入 `" onerror="alert(1)"`——**需要服务端保证数据安全**
- **应对策略**：对 URL 拼接中的所有变量进行 encodeURIComponent

### D-07 trackChangeGen 竞态保护的覆盖范围不足
- **分类**：D UI状态机 | **严重程度**：🟡
- **攻击向量**：`handleTrackChange` 中 `trackChangeGen` 在 async/await 点检查 stale，但 `setupAudio` 内部的异步操作未检查
- **测试步骤**：
  1. 快速连续切换 3 首歌曲
  2. 检查最终加载的是否为第 3 首
  3. 观察是否有中间状态的 UI 闪烁
- **预期结果**：应只加载最后一首，中间的应被取消
- **实际风险评估**：`setupAudio` 调用 `audioPlayer.loadAudio` 后未检查 gen，如果第 2 首的 `loadAudio` 在第 3 首的 `handleTrackChange` 之后完成，会覆盖第 3 首的状态
- **应对策略**：在 `setupAudio` 返回后也检查 `trackChangeGen`

### D-08 lt_active_room 持久化导致的幽灵重连
- **分类**：D UI状态机 | **严重程度**：🟡
- **攻击向量**：用户关闭浏览器标签页（非点击离开），`lt_active_room` 未被清除，下次打开时自动尝试加入已不存在的房间
- **测试步骤**：
  1. 进入房间后直接关闭标签页
  2. 等待房间因无人而被服务端销毁
  3. 重新打开页面，观察自动重连行为
- **预期结果**：应优雅处理房间不存在的情况
- **实际风险评估**：自动重连代码 `tryJoin` 最多尝试 20 次（每 500ms），若房间不存在，服务端返回 error，但 `handleMessage` 中 error 只 alert 不清理状态——**用户看到 20 次错误弹窗**
- **应对策略**：在 error 处理中检查 "Room not found" 并清除 `lt_active_room`；限制自动重连只尝试 1 次

---

## E. 网络资源（Network Resources）

### E-01 segment 预加载策略在弱网下的带宽浪费
- **分类**：E网络资源 | **严重程度**：🟡
- **攻击向量**：`preloadSegments` 在播放开始时加载 1+4 个 segment，lossless 品质下每个 segment 可达数 MB，弱网下可能耗尽带宽
- **测试步骤**：
  1. 使用 2G 网络节流（50KB/s）播放 lossless 音频
  2. 观察预加载是否阻塞当前 segment 的播放
  3. 检查 `onBuffering` 回调的触发频率
- **预期结果**：弱网下应减少预加载数量，优先保证当前 segment
- **实际风险评估**：`Promise.all` 并行加载所有预加载 segment，与当前 segment 竞争带宽
- **应对策略**：根据 `navigator.connection.effectiveType` 动态调整预加载数量

### E-02 Cache API 存储空间耗尽
- **分类**：E网络资源 | **严重程度**：🟡
- **攻击向量**：`audioCache` 只有 `put` 和 `clear`，无 LRU 淘汰策略，长期使用后 Cache Storage 可能达到浏览器配额限制
- **测试步骤**：
  1. 连续播放 50 首不同歌曲（lossless 品质）
  2. 检查 Cache Storage 的总大小
  3. 观察 `cache.put` 是否开始失败
- **预期结果**：应有自动淘汰机制，防止存储溢出
- **实际风险评估**：`cache.put` 失败被 catch 但仅 `console.warn`，不影响播放；但缓存命中率会降为 0
- **应对策略**：实现 LRU 淘汰或基于总大小的自动清理

### E-03 segment 加载 3 次重试的总延迟
- **分类**：E网络资源 | **严重程度**：🟡
- **攻击向量**：`loadSegment` 中 3 次重试间隔固定 300ms，总延迟可达 900ms+，可能导致播放中断
- **测试步骤**：
  1. 模拟 segment 请求间歇性失败（第 1-2 次失败，第 3 次成功）
  2. 测量从请求到 buffer 可用的总延迟
  3. 检查 lookahead 调度器是否因等待而产生 gap
- **预期结果**：重试延迟不应导致可感知的播放中断
- **实际风险评估**：lookahead 窗口为 1.5s（普通）或 3.0s（lossless），3 次重试 900ms 在窗口内，但加上解码时间可能超出
- **应对策略**：使用指数退避（100/200/400ms）并在重试期间显示 buffering 状态

### E-04 quality 升级全量下载阻塞主线程
- **分类**：E网络资源 | **严重程度**：🟡
- **攻击向量**：`_upgradeQuality` 串行下载并解码所有 segment，长曲目可能有 100+ 个 segment
- **测试步骤**：
  1. 播放一首 10 分钟的歌曲，触发 medium → lossless 升级
  2. 监控升级期间的内存占用和 UI 响应性
  3. 检查 `decodeAudioData` 是否阻塞音频线程
- **预期结果**：升级应在后台进行，不影响当前播放
- **实际风险评估**：串行 `await fetch` + `await decodeAudioData` 不阻塞主线程，但 `decodeAudioData` 会占用音频线程资源，可能导致当前播放的 segment 调度延迟
- **应对策略**：限制并发解码数量，或使用 `OfflineAudioContext` 隔离解码

### E-05 cover 图片跨域提取颜色失败
- **分类**：E网络资源 | **严重程度**：🟢
- **攻击向量**：动态背景的 `extractColors` 使用 canvas `getImageData`，若 cover 图片无 CORS 头，会触发 tainted canvas 异常
- **测试步骤**：
  1. 上传一张来自外部 CDN 的 cover 图片
  2. 检查 `tempImg.crossOrigin = 'anonymous'` 是否生效
  3. 观察 `getImageData` 是否抛出 SecurityError
- **预期结果**：跨域图片应优雅降级为默认背景色
- **实际风险评估**：代码已设置 `crossOrigin = 'anonymous'`，但服务端需返回 `Access-Control-Allow-Origin` 头；若未返回，`try-catch` 会捕获异常
- **应对策略**：确保 `/api/library/cover/` 返回 CORS 头

### E-06 analyser 节点连接导致的音频路由副作用
- **分类**：E网络资源 | **严重程度**：🟢
- **攻击向量**：动态背景的 `setupAnalyser` 将 `gainNode` 连接到 `analyser`，但 `analyser` 未连接到 `destination`，可能影响音频路由
- **测试步骤**：
  1. 检查 `gainNode.connect(analyser)` 是否创建了额外的音频路径
  2. 对比有无 analyser 时的音频输出波形
- **预期结果**：analyser 不应影响音频输出
- **实际风险评估**：Web Audio API 中 `connect` 是追加而非替换，`gainNode` 同时连接 `destination` 和 `analyser` 是安全的；但 `analyser` 增加了 CPU 开销
- **应对策略**：在非播放状态下断开 analyser

### E-07 localStorage 配额溢出风险
- **分类**：E网络资源 | **严重程度**：🟢
- **攻击向量**：多个 localStorage key（`lt_quality`、`lt_layout_config`、`lt_player_style`、`lt_active_room`、`lt_lyrics_height`）持续写入
- **测试步骤**：
  1. 填充 localStorage 到接近 5MB 配额
  2. 触发 `saveLayout` 写入
  3. 检查是否有 QuotaExceededError 处理
- **预期结果**：写入失败应被捕获，不影响核心功能
- **实际风险评估**：所有 `localStorage.setItem` 调用均无 try-catch，配额溢出会抛出未捕获异常
- **应对策略**：封装 localStorage 操作，添加 try-catch

### E-08 fetch credentials:'include' 的 cookie 泄露风险
- **分类**：E网络资源 | **严重程度**：🟡
- **攻击向量**：所有 API 请求使用 `credentials: 'include'`，若页面被嵌入恶意 iframe，cookie 可能被跨站请求利用
- **测试步骤**：
  1. 在恶意页面中嵌入 `<iframe src="listen-together-url">`
  2. 检查 iframe 内的 API 请求是否携带 cookie
  3. 验证服务端是否有 CSRF 防护
- **预期结果**：应有 X-Frame-Options 或 CSP frame-ancestors 防护
- **实际风险评估**：index.html 无 `X-Frame-Options` 头，可被嵌入 iframe；但 HttpOnly cookie + 同源 WS 限制了攻击面
- **应对策略**：添加 `X-Frame-Options: DENY` 响应头

---

## F. 安全 XSS（Security & XSS）

### F-01 escapeHtml 绕过——innerHTML 中的属性注入
- **分类**：F安全XSS | **严重程度**：🔴
- **攻击向量**：`renderPlaylist` 中 `coverUrl` 直接拼接到 `<img src="...">` 中，若 `owner_id` 或 `audio_uuid` 包含 `"` 可闭合属性
- **测试步骤**：
  1. 构造 `audio_uuid = 'x" onerror="alert(document.cookie)'`
  2. 将其添加到播放列表
  3. 检查 img 标签是否执行 onerror
- **预期结果**：所有动态值应被转义或使用 DOM API 构建
- **实际风险评估**：`audio_uuid` 由服务端生成（通常为 UUID 格式），但 `original_name` 和 `filename` 可能包含用户输入——虽然经过 `escapeHtml`，但 `coverUrl` 未经转义
- **应对策略**：对 URL 中的所有变量使用 `encodeURIComponent`

### F-02 renderAudiencePanel 中的 innerHTML XSS
- **分类**：F安全XSS | **严重程度**：🟡
- **攻击向量**：`renderAudiencePanel` 使用 `escapeHtml(u.username)` 和 `escapeHtml(u.clientID)`，但 `data-cid` 属性值未转义
- **测试步骤**：
  1. 注册用户名为正常值，但通过 WS 篡改 `clientID` 为 `"><img src=x onerror=alert(1)>`
  2. 检查 audience panel 的 DOM
- **预期结果**：`data-cid` 应被转义
- **实际风险评估**：`escapeHtml(u.clientID)` 已对 `data-cid` 值进行了 HTML 转义，`"` 会被转为 `&quot;`——**安全**，但依赖 `escapeHtml` 的正确性
- **应对策略**：使用 `setAttribute` 替代字符串拼接

### F-03 copyInviteLink 中的 XSS via roomCode
- **分类**：F安全XSS | **严重程度**：🟡
- **攻击向量**：`copyInviteLink` 将 `roomCode` 拼接到 URL 中写入剪贴板，若 roomCode 被篡改可注入恶意 URL
- **测试步骤**：
  1. 通过 WS 消息将 `roomCode` 设置为 `javascript:alert(1)//`
  2. 复制邀请链接并粘贴到浏览器
- **预期结果**：roomCode 应被验证为合法格式
- **实际风险评估**：`location.origin + '/#' + roomCode` 格式下，`javascript:` 协议不会生效（因为有 origin 前缀）；但 roomCode 可能包含特殊字符影响 URL 解析
- **应对策略**：在客户端验证 roomCode 格式（仅允许 `[A-Z0-9]{8}`）

### F-04 LRC 歌词解析中的 XSS
- **分类**：F安全XSS | **严重程度**：🔴
- **攻击向量**：`renderLyrics` 使用 `escapeH(l.text)` 转义歌词文本，但 plain text 歌词路径中 `l.text` 也经过 `escapeH`——需验证 `escapeH` 的完整性
- **测试步骤**：
  1. 上传包含 `<script>alert(1)</script>` 的 LRC 文件
  2. 播放该歌曲，检查歌词区域的 DOM
  3. 验证 `escapeH` 是否正确转义了 `<`, `>`, `&`, `"`, `'`
- **预期结果**：所有 HTML 特殊字符应被转义
- **实际风险评估**：`escapeH` 使用 `document.createElement('div').textContent = s; return div.innerHTML`，这是标准的转义方法，能正确处理 `<`, `>`, `&`；但不转义 `"` 和 `'`——在属性上下文中可能不安全（但歌词在 `<p>` 标签内容中，安全）
- **应对策略**：当前实现在内容上下文中安全；若未来歌词用于属性值，需增强转义

### F-05 settings 面板中的用户信息 XSS
- **分类**：F安全XSS | **严重程度**：🟡
- **攻击向量**：settings 面板使用 `textContent` 设置用户名、UID 等，安全；但 `roleMap` 中的 emoji 通过 `textContent` 设置也安全
- **测试步骤**：
  1. 通过 API 篡改用户名为 `<img src=x onerror=alert(1)>`
  2. 打开 settings 面板
  3. 检查用户名是否被当作 HTML 执行
- **预期结果**：`textContent` 应自动转义
- **实际风险评估**：所有 settings 面板的数据展示都使用 `textContent`——**安全**
- **应对策略**：保持使用 `textContent`，不要改为 `innerHTML`

### F-06 library 文件列表中的 innerHTML 注入
- **分类**：F安全XSS | **严重程度**：🟡
- **攻击向量**：`addFromLibBtn.onclick` 中 `escapeHtml(f.title)` 和 `escapeHtml(f.artist)` 已转义，但 `f.owner_name` 也经过 `escapeHtml`
- **测试步骤**：
  1. 管理员上传标题为 `<svg onload=alert(1)>` 的音频
  2. 打开音频库模态框
  3. 检查 DOM 是否执行了 SVG
- **预期结果**：`escapeHtml` 应阻止 SVG 注入
- **实际风险评估**：`escapeHtml` 使用 `textContent/innerHTML` 模式，能正确转义 `<svg>`——**安全**
- **应对策略**：维持现有转义；考虑使用 CSP 作为纵深防御

### F-07 WebSocket 消息伪造——客户端信任服务端数据
- **分类**：F安全XSS | **严重程度**：🟡
- **攻击向量**：`handleMessage` 直接信任 WS 消息中的所有字段（`msg.audio`、`msg.users`、`msg.position` 等），若 WS 被中间人攻击可注入恶意数据
- **测试步骤**：
  1. 使用 WS 代理拦截并修改服务端消息
  2. 注入 `msg.audio.filename = '<script>alert(1)</script>'`
  3. 检查 `setupAudio` 中 `$('trackName').textContent = audioInfo.filename` 是否安全
- **预期结果**：使用 `textContent` 的赋值应安全
- **实际风险评估**：大部分数据展示使用 `textContent`（安全），但 `updateTrackMeta` 也使用 `textContent`——**安全**；真正的风险在于 `position`/`serverTime` 等数值被篡改导致播放异常
- **应对策略**：使用 WSS（TLS）防止中间人攻击；对数值字段做范围校验

### F-08 auth 表单无 CSRF token
- **分类**：F安全XSS | **严重程度**：🟡
- **攻击向量**：登录/注册/修改密码等 API 使用 JSON body + cookie 认证，无 CSRF token
- **测试步骤**：
  1. 构造恶意页面，使用 `fetch` 向 `/api/auth/password` 发送 PUT 请求
  2. 检查是否能在用户不知情的情况下修改密码
- **预期结果**：应有 CSRF 防护
- **实际风险评估**：`Content-Type: application/json` 的跨域请求会触发 CORS preflight，浏览器会阻止无 CORS 头的请求——**部分防护**；但同源页面（如 XSS）可绕过
- **应对策略**：添加 CSRF token 或 SameSite cookie 属性

### F-09 密码明文传输风险
- **分类**：F安全XSS | **严重程度**：🟢
- **攻击向量**：登录/注册时密码以 JSON 明文发送到服务端
- **测试步骤**：
  1. 在 HTTP（非 HTTPS）环境下登录
  2. 使用网络抓包工具检查密码是否可见
- **预期结果**：应强制使用 HTTPS
- **实际风险评估**：WS 连接使用 `location.protocol` 自动选择 `ws/wss`，但未强制 HTTPS 重定向
- **应对策略**：服务端强制 HTTPS 重定向；考虑客户端密码哈希

---

## G. 跨设备（Cross-Device）

### G-01 不同设备 outputLatency 差异导致的同步偏差
- **分类**：G跨设备 | **严重程度**：🟡
- **攻击向量**：设备 A（Chrome, outputLatency=25ms）与设备 B（Firefox, outputLatency=0）同时播放，B 的音频实际输出比 A 早 25ms
- **测试步骤**：
  1. 在 Chrome 桌面端和 Firefox 移动端同时加入同一房间
  2. 使用外部录音设备同时录制两端音频输出
  3. 对比波形的时间偏移量
- **预期结果**：两端音频输出偏差应 <30ms
- **实际风险评估**：`playAtPosition` 中 `scheduleTarget = ctxTarget - latency` 仅在支持 `outputLatency` 的浏览器上生效；Firefox 返回 0，导致调度偏早——**设备间固有偏差 20-50ms**
- **应对策略**：提供用户可调的 latency 补偿滑块；或服务端收集各客户端 latency 做全局补偿

### G-02 移动端后台标签页的 timer 节流
- **分类**：G跨设备 | **严重程度**：🔴
- **攻击向量**：移动浏览器将后台标签页的 `setInterval` 节流到 1 分钟/次，导致 lookahead 调度器停止喂 segment
- **测试步骤**：
  1. 在移动端加入房间并开始播放
  2. 切换到其他 App 30 秒
  3. 切回后检查播放状态（是否中断、漂移量）
- **预期结果**：切回后应在 1 秒内恢复同步播放
- **实际风险评估**：`_lookaheadTimer`（200ms interval）被节流后，segment 队列耗尽导致静音；`visibilitychange` 处理会触发 burst + `_scheduleAhead`，但已调度的 segment 可能已过期——**需要 hard resync**
- **应对策略**：在 `visibilitychange` 恢复时强制执行 `playAtPosition` 而非仅 `_scheduleAhead`

### G-03 PC 端与移动端 UI 状态同步延迟
- **分类**：G跨设备 | **严重程度**：🟢
- **攻击向量**：移动端 UI 通过 300ms `setInterval` 从 PC 端 DOM 元素同步状态，存在最大 300ms 的显示延迟
- **测试步骤**：
  1. 在移动端视图下操作播放/暂停
  2. 测量 mobile player 按钮状态更新的延迟
  3. 检查进度条是否出现跳跃
- **预期结果**：UI 响应延迟应 <100ms
- **实际风险评估**：300ms 轮询 + DOM 读取开销，实际延迟 300-600ms；快速操作时可能出现按钮状态闪烁
- **应对策略**：移动端按钮直接触发 `pcPlay.click()` 是即时的（已实现），仅显示同步有延迟——可接受

### G-04 单设备登录策略的竞态窗口
- **分类**：G跨设备 | **严重程度**：🟡
- **攻击向量**：两个设备几乎同时连接 WS，在 `deviceKick` 消息到达前都完成了 `join`，短暂出现双设备在同一房间
- **测试步骤**：
  1. 在设备 A 和设备 B 同时打开页面并登录同一账号
  2. 两端几乎同时加入同一房间
  3. 观察 deviceKick 的触发时序和最终状态
- **预期结果**：应只有一个设备保留在房间中
- **实际风险评估**：WS 连接建立到 deviceKick 处理之间有 100-500ms 窗口，期间两端都可能收到 `joined` 并开始播放
- **应对策略**：服务端在 WS 握手阶段即检查并踢出旧连接，而非在消息层面处理

---

## 风险汇总表

| 编号 | 名称 | 分类 | 严重程度 | 已知Bug | 核心风险 |
|------|------|------|----------|---------|----------|
| A-01 | AudioContext 未初始化调用 | A音频引擎 | 🔴 | — | TypeError 崩溃 |
| A-02 | AudioContext suspended 静默播放 | A音频引擎 | 🟡 | — | 用户无声音 |
| A-03 | segment 解码失败链断裂 | A音频引擎 | 🔴 | — | 播放完全中断 |
| A-04 | Fetch 拦截器空 Response | A音频引擎 | 🟡 | — | 触发 A-03 |
| A-05 | quality 升级竞态 | A音频引擎 | 🟡 | — | 新旧 segment 混合 |
| A-06 | sources 数组内存泄漏 | A音频引擎 | 🟡 | — | 长时间播放 OOM |
| A-07 | segmentTime 不匹配 | A音频引擎 | 🟡 | — | 播放 gap |
| A-08 | 极短 segment crossfade 异常 | A音频引擎 | 🟢 | — | gain 调度错误 |
| A-09 | playbackRate 期间位置偏差 | A音频引擎 | 🟡 | — | 暂停恢复跳变 |
| A-10 | fade-out 与 stop 时序竞争 | A音频引擎 | 🟢 | — | click/pop 伪影 |
| A-11 | worklet ring buffer 溢出 | A音频引擎 | 🟡 | — | 音频跳跃 |
| B-01 | 初始 burst 样本污染 | B同步算法 | 🟡 | — | 初始同步精度低 |
| B-02 | 网络切换同步重置风暴 | B同步算法 | 🟡 | — | 持续不同步 |
| B-03 | soft correction 虚假修正 | B同步算法 | 🔴 | ✅ P5 | 振荡漂移 |
| B-04 | 三层阈值边界振荡 | B同步算法 | 🟡 | — | 修正策略抖动 |
| B-05 | hard resync 退避过长 | B同步算法 | 🟡 | — | 长时间不同步 |
| B-06 | driftOffset 累积硬重置 | B同步算法 | 🔴 | — | 周期性中断 |
| B-07 | playbackRate 补偿精度 | B同步算法 | 🟡 | — | 双重补偿 |
| B-08 | scheduledAt 时钟域混合 | B同步算法 | 🟡 | — | 调度偏差 |
| B-09 | outputLatency 设备差异 | B同步算法 | 🟢 | — | 跨设备偏差 |
| B-10 | visibility burst 有效性 | B同步算法 | 🟡 | — | 恢复后错误调度 |
| B-11 | EMA 响应延迟 | B同步算法 | 🟢 | — | 收敛慢 |
| C-01 | WS 重连拦截器失效 | C WebSocket | 🔴 | ✅ P2 | 房间状态残留 |
| C-02 | reconnect 退避上限过高 | C WebSocket | 🟡 | — | 长时间断连 |
| C-03 | onmessage 多层覆盖 | C WebSocket | 🔴 | — | 消息丢失 |
| C-04 | JSON.parse 异常 | C WebSocket | 🟡 | — | 控制台错误 |
| C-05 | deviceKick/sessionExpired 竞态 | C WebSocket | 🟡 | — | 双重 alert |
| C-06 | WS 在 auth 前建立 | C WebSocket | 🟡 | — | 连接失败 |
| C-07 | statusReport 无效发送 | C WebSocket | 🟢 | — | 低风险 |
| C-08 | hash 路由状态不同步 | C WebSocket | 🟡 | — | 空白 room |
| D-01 | screen 切换残留状态 | D UI状态机 | 🟡 | — | UI 残留 |
| D-02 | isHost 前端绕过 | D UI状态机 | 🟡 | — | 依赖服务端 |
| D-03 | hostTransfer UI 刷新不完整 | D UI状态机 | 🟡 | — | 按钮 disabled |
| D-04 | roleChanged 降级残留 | D UI状态机 | 🟡 | — | 权限不一致 |
| D-05 | MutationObserver 性能 | D UI状态机 | 🟢 | — | 低端设备卡顿 |
| D-06 | 播放列表 coverUrl 注入 | D UI状态机 | 🟡 | — | 属性注入风险 |
| D-07 | trackChangeGen 覆盖不足 | D UI状态机 | 🟡 | — | 曲目状态错乱 |
| D-08 | 幽灵重连弹窗风暴 | D UI状态机 | 🟡 | — | 20 次错误弹窗 |
| E-01 | 弱网预加载带宽浪费 | E网络资源 | 🟡 | — | 播放卡顿 |
| E-02 | Cache 无淘汰策略 | E网络资源 | 🟡 | — | 存储溢出 |
| E-03 | segment 重试总延迟 | E网络资源 | 🟡 | — | 播放中断 |
| E-04 | quality 升级阻塞 | E网络资源 | 🟡 | — | 调度延迟 |
| E-05 | cover 跨域颜色提取 | E网络资源 | 🟢 | — | 背景降级 |
| E-06 | analyser 路由副作用 | E网络资源 | 🟢 | — | CPU 开销 |
| E-07 | localStorage 配额溢出 | E网络资源 | 🟢 | — | 未捕获异常 |
| E-08 | cookie iframe 泄露 | E网络资源 | 🟡 | — | CSRF 风险 |
| F-01 | coverUrl 属性注入 | F安全XSS | 🔴 | — | XSS |
| F-02 | audiencePanel innerHTML | F安全XSS | 🟡 | — | 已转义，低风险 |
| F-03 | roomCode URL 注入 | F安全XSS | 🟡 | — | URL 篡改 |
| F-04 | LRC 歌词 XSS | F安全XSS | 🔴 | — | 内容上下文安全 |
| F-05 | settings textContent | F安全XSS | 🟡 | — | 安全 |
| F-06 | library innerHTML | F安全XSS | 🟡 | — | 已转义 |
| F-07 | WS 消息伪造 | F安全XSS | 🟡 | — | 需 WSS |
| F-08 | auth 无 CSRF token | F安全XSS | 🟡 | — | CORS 部分防护 |
| F-09 | 密码明文传输 | F安全XSS | 🟢 | — | 需 HTTPS |
| G-01 | outputLatency 跨设备差异 | G跨设备 | 🟡 | — | 20-50ms 偏差 |
| G-02 | 移动端后台 timer 节流 | G跨设备 | 🔴 | — | 播放中断 |
| G-03 | PC/移动 UI 同步延迟 | G跨设备 | 🟢 | — | 300ms 延迟 |
| G-04 | 单设备登录竞态窗口 | G跨设备 | 🟡 | — | 短暂双设备 |

### 统计

| 严重程度 | 数量 | 占比 |
|----------|------|------|
| 🔴 严重 | 9 | 15.8% |
| 🟡 警告 | 35 | 61.4% |
| 🟢 提示 | 13 | 22.8% |
| **合计** | **57** | **100%** |

### 优先修复建议

1. **P0 立即修复**：A-03（segment 解码链断裂）、C-01（P2 WS 重连拦截器）、C-03（onmessage 覆盖）、G-02（移动端后台节流）
2. **P1 本迭代修复**：B-03（P5 soft correction 振荡）、B-06（driftOffset 累积硬重置）、F-01（coverUrl XSS）、D-08（幽灵重连弹窗）
3. **P2 下迭代修复**：B-04（阈值边界振荡）、D-03（hostTransfer UI）、E-02（Cache 淘汰）、E-08（iframe CSRF）
