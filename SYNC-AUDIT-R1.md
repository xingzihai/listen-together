# 同步算法审计报告

## 发现的问题（按严重程度排序）

### [CRITICAL-1] index.html 中 WS onmessage 拦截器重复处理 forceResync，且吞掉了消息

- 文件：`web/static/index.html` 第 ~530-555 行（statusReport 拦截器的 `setInterval` 中 ws.onmessage 覆盖）
- 现象：forceResync 消息被拦截器处理后 `return`，不再传递给 app.js 的原始 handler。但 app.js 的 `handleMessage` 中也有 `forceResync` case，且包含 `_postResetVerify` 逻辑。拦截器中的处理缺少 `_postResetVerify` 设置，导致 post-reset 验证机制失效。
- 根因：index.html 第 540-549 行：
  ```javascript
  if (msg.type === 'forceResync') {
      console.warn('[forceResync] server drift correction, pos=' + msg.position);
      var ap = window.audioPlayer;
      if (ap && ap.isPlaying) {
          ap._driftCount = 0;
          ap._lastResetTime = performance.now();
          ap.playAtPosition(msg.position, msg.serverTime);
          // 注意：没有设置 _postResetVerify 和 _postResetTime！
      }
      return;  // ← 吞掉了消息，app.js 的 forceResync handler 永远不会执行
  }
  ```
  而 app.js 第 ~210-220 行的 forceResync handler 正确设置了 `_postResetVerify`：
  ```javascript
  case 'forceResync': {
      const ap = window.audioPlayer;
      if (ap && ap.isPlaying && typeof msg.position === 'number' && typeof msg.serverTime === 'number') {
          ap._driftCount = 0;
          ap._lastResetTime = performance.now();
          ap._postResetVerify = true;      // ← 这行在拦截器中缺失
          ap._postResetTime = performance.now(); // ← 这行也缺失
          ap.playAtPosition(msg.position, msg.serverTime, msg.scheduledAt);
      }
      break;
  }
  ```
  **后果**：服务器发送的 forceResync 不会触发 post-reset 验证。如果 forceResync 后仍有偏差，不会被二次检测到。同时拦截器调用 `playAtPosition` 时没传 `scheduledAt` 参数，丢失了精确调度能力。
- 修复方案：删除拦截器中的 forceResync 处理，让消息正常传递给 app.js：
  ```javascript
  ws.onmessage = function(e) {
      try {
          var msg = JSON.parse(e.data);
          // 只处理 forceTrack，forceResync 交给 app.js
          if (msg.type === 'forceTrack') {
              console.warn('[forceTrack] wrong track, switching to ' + msg.trackIndex);
              msg.type = 'trackChange';
              e = new MessageEvent('message', { data: JSON.stringify(msg) });
          }
      } catch(ex) {}
      if (origOnMsg) origOnMsg.call(ws, e);
  };
  ```

### [CRITICAL-2] segment 边界微调 (_lastDrift * 0.5) 修改了 schedTime 但没有更新 _nextSegTime，导致累积时间偏移

- 文件：`web/static/js/player.js` `_scheduleAhead()` 方法，约第 195-205 行
- 现象：播放时间越长，漂移越大，且方向不确定
- 根因：代码中 `schedTime = t - ld * 0.5` 修改了实际调度时间，但 `_nextSegTime = t + dur` 仍然基于原始的 `t` 计算。这意味着：
  - 如果 drift 为正（客户端超前），`schedTime` 被推迟（`t - positive * 0.5`），音频实际播放晚了
  - 但 `_nextSegTime` 没有相应调整，下一个 segment 仍按原始时间线调度
  - **结果**：每个 segment 的实际播放时间和逻辑时间线之间产生了 `ld * 0.5` 的偏差
  - 更严重的是：这个微调不会改变 `startOffset` 和 `startTime`，所以 `getCurrentTime()` 返回的位置不受影响，但实际音频输出位置已经偏移了
  - 这导致 `getCurrentTime()` 报告的位置和实际音频输出位置之间存在隐性偏差，且随 segment 数量累积

  具体代码：
  ```javascript
  let schedTime = t;
  if (!this._isFirstSeg && i > 0) {
      const ld = this._lastDrift;
      if (Math.abs(ld) > 0.03 && Math.abs(ld) < this._DRIFT_THRESHOLD) {
          schedTime = t - ld * 0.5; // 修改了调度时间
      }
  }
  // ... source.start(schedTime, off) 用修改后的时间
  this._nextSegTime = t + dur; // ← BUG: 用的是原始 t，不是 schedTime
  ```

  假设每个 segment 5秒，drift 持续为 +80ms：
  - 每个 segment 调度时间被推迟 40ms
  - 但 _nextSegTime 不变，所以下一个 segment 的 `t` 值不受影响
  - 实际效果：每个 segment 之间产生 40ms 的间隙（或重叠，取决于方向）
  - 10分钟 = 120 个 segments → 累积 120 * 40ms = 4.8秒的音频输出偏差！

- 修复方案：**完全移除 segment 边界微调**。在服务器权威模式下，偏差纠正应该只通过 syncTick 的 hard reset 来完成，不应该在 segment 调度层面做微调：
  ```javascript
  // 在 _scheduleAhead() 中，删除整个 D1 微调块：
  // 删除以下代码：
  // let schedTime = t;
  // if (!this._isFirstSeg && i > 0) {
  //     const ld = this._lastDrift;
  //     if (Math.abs(ld) > 0.03 && Math.abs(ld) < this._DRIFT_THRESHOLD) {
  //         schedTime = t - ld * 0.5;
  //     }
  // }
  
  // 替换为直接使用 t：
  const schedTime = t;
  ```
  同时删除 app.js syncTick handler 末尾的 `ap._lastDrift = drift;` 赋值（不再需要）。

### [CRITICAL-3] syncTick 不发送给 host，但 host 也可能漂移

- 文件：`main.go` syncTick goroutine，约第 165 行
- 现象：如果房间里只有 host 在播放（或 host 自己也需要同步），host 永远收不到 syncTick
- 根因：
  ```go
  for _, c := range clients {
      if c.ID == hostID {
          continue // host is the time source, skip syncTick
      }
      c.Send(raw)
  }
  ```
  注释说"host is the time source"，但实际上 host 并不是时间源——**服务器才是时间源**。Host 只是有控制权（play/pause/seek），但 host 的 AudioContext 同样可能漂移。
  
  在当前架构中，host 的播放位置完全依赖本地 AudioContext，没有任何校准机制。如果 host 的 AudioContext 时钟有偏差（这在浏览器中很常见，尤其是标签页后台时），host 的位置会逐渐偏离服务器位置。
  
  更严重的是：statusReport 每 2 秒发送一次，但 host 发送的 statusReport 中的 position 是基于 host 本地的 `getCurrentTime()`。如果 host 漂移了，服务器的 drift 检测会认为 host 是对的（因为 host 的 statusReport 和服务器计算的 expectedPos 之间的差异会触发 forceResync 发给 host），但 host 收到 forceResync 后会重置到服务器位置——这部分是正确的。
  
  **但问题是**：host 不接收 syncTick，所以 host 端的 `_driftCount` 机制完全不工作。Host 只能依赖服务器的 forceResync（500ms 阈值 + 5秒频率限制），这意味着 host 在 0-500ms 范围内的漂移完全不会被纠正。

- 修复方案：让 syncTick 也发送给 host：
  ```go
  for _, c := range clients {
      // 所有客户端都需要 syncTick，包括 host
      c.Send(raw)
  }
  ```

### [HIGH-1] _driftCount 计数器在冷却期结束后不会自动恢复计数

- 文件：`web/static/js/app.js` syncTick handler，约第 170-200 行
- 现象：偏差在 150ms 以上持续存在，但因为冷却期的存在，可能需要很长时间才能触发重置
- 根因：冷却期逻辑分析：
  ```javascript
  if (absDrift > ap._DRIFT_THRESHOLD) {  // > 150ms
      if (ap._lastResetTime && performance.now() - ap._lastResetTime < ap._RESET_COOLDOWN) {
          // 冷却期内：只做 post-reset verify（一次性）
          // 如果 verify 也失败了，会 re-reset，但 _lastResetTime 被更新
          // → 又进入新的 5 秒冷却期
      } else {
          // 冷却期外：_driftCount++
          // 需要连续 3 次才触发重置
      }
  } else {
      ap._driftCount = 0;  // 偏差 < 150ms 就归零
  }
  ```
  
  **盲区场景**：
  1. 偏差在 140-160ms 之间波动：一次 >150ms（count=1），下一次 <150ms（count=0），永远不到 3 次
  2. 重置后偏差仍然 >150ms：post-reset verify 触发 re-reset，_lastResetTime 更新，又进入 5 秒冷却期。如果根因未解决（比如 segment 微调持续引入偏差），会陷入"重置→冷却→重置→冷却"的循环，但每次冷却期内偏差持续存在
  
  这个问题本身不是最严重的 bug（CRITICAL-2 的 segment 微调才是根因），但阈值设计确实有改进空间。

- 修复方案：降低阈值和计数要求，让纠正更灵敏：
  ```javascript
  // 在 AudioPlayer constructor 中：
  this._DRIFT_THRESHOLD = 0.08;    // 80ms（从 150ms 降低）
  this._DRIFT_COUNT_LIMIT = 2;     // 连续 2 次就重置（从 3 次降低）
  this._RESET_COOLDOWN = 3000;     // 3 秒冷却（从 5 秒降低）
  ```

### [HIGH-2] post-reset verify 只检查一次，且时机不可靠

- 文件：`web/static/js/app.js` syncTick handler，约第 175-182 行
- 现象：重置后如果第一个 syncTick 恰好在 500ms 之前到达，verify 被跳过；如果在 500ms 之后到达但偏差已经恢复正常，verify 也被跳过（因为走了 else 分支 `_driftCount = 0`）
- 根因：
  ```javascript
  // C3: Post-reset verification
  if (ap._postResetVerify && performance.now() - ap._postResetTime > 500) {
      ap._postResetVerify = false;
      console.warn(`[sync] post-reset verify failed: drift=${(drift*1000).toFixed(0)}ms, re-resetting`);
      ap._driftCount = 0;
      ap._lastResetTime = performance.now();
      ap.playAtPosition(serverPos, msg.serverTime);
  }
  ```
  问题：
  1. 只有在 `absDrift > _DRIFT_THRESHOLD` 且在冷却期内时才会进入这个分支
  2. 如果 post-reset 后偏差恰好 < 150ms（但仍然有 100ms），走 else 分支，`_postResetVerify` 被设为 false（"reset succeeded"），但实际上 100ms 的偏差仍然不理想
  3. verify 只执行一次（`_postResetVerify = false`），如果 re-reset 后仍有偏差，不会再次 verify

- 修复方案：在修复 CRITICAL-2 后，这个问题的影响会大幅降低。但建议简化为：
  ```javascript
  // 删除整个 post-reset verify 机制，依赖正常的 driftCount 流程
  // 冷却期缩短到 3 秒后，正常流程足够快速响应
  ```

### [HIGH-3] visibilitychange handler 中 expectedPos 计算使用了可能过时的 serverPlayPosition/serverPlayTime

- 文件：`web/static/js/app.js` 最后的 visibilitychange handler，约第 310-325 行
- 现象：页面从后台恢复后，可能跳到错误的位置
- 根因：
  ```javascript
  setTimeout(() => {
      if (!window.audioPlayer.isPlaying) return;
      const ap = window.audioPlayer;
      const now = window.clockSync.getServerTime();
      const expectedPos = ap.serverPlayPosition + (now - ap.serverPlayTime) / 1000;
      ap._driftCount = 0;
      ap._lastResetTime = performance.now();
      ap.playAtPosition(expectedPos, now);
  }, 600);
  ```
  问题：
  1. `serverPlayPosition` 和 `serverPlayTime` 是在最后一次 syncTick 时更新的。如果页面在后台待了很久（浏览器会节流 timer），这些值可能是几分钟前的
  2. 600ms 的延迟是为了等 clockSync burst 完成，但 burst 发 8 个 ping 间隔 100ms，总共 800ms，所以 600ms 时 burst 还没完成，clockSync 可能还没重新校准
  3. 更重要的是：页面在后台时 AudioContext 可能被暂停（浏览器行为），`ctx.currentTime` 可能停止增长，导致 `getCurrentTime()` 返回的值远小于实际应该的位置

- 修复方案：等待 burst 完成后再重置，并使用最新的 syncTick 数据：
  ```javascript
  document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && window.clockSync && window.audioPlayer.isPlaying) {
          console.log('[sync] page visible, triggering burst re-sync');
          window.clockSync.burst();
          // Wait for burst to complete (8 pings * 100ms + processing)
          setTimeout(() => {
              if (!window.audioPlayer.isPlaying) return;
              const ap = window.audioPlayer;
              // Use clockSync to calculate current server position
              // serverPlayPosition/serverPlayTime are updated by syncTick
              const now = window.clockSync.getServerTime();
              const expectedPos = ap.serverPlayPosition + (now - ap.serverPlayTime) / 1000;
              ap._driftCount = 0;
              ap._lastResetTime = performance.now();
              ap._postResetVerify = true;
              ap._postResetTime = performance.now();
              ap.playAtPosition(expectedPos, now);
              console.log('[sync] visibility restore: forced reset to', expectedPos.toFixed(2));
          }, 1000); // 增加到 1000ms，确保 burst 完成
      }
  });
  ```

### [MEDIUM-1] statusReport 每 2 秒发送一次，但服务器端限制为每秒 1 次

- 文件：`web/static/index.html` 第 ~520 行（客户端 setInterval 2000ms）和 `main.go` 第 ~380 行（`lastStatusReport` 限制 1/sec）
- 现象：不是 bug，但 2 秒的报告间隔意味着服务器最快 2 秒才能发现 >500ms 的偏差，加上 5 秒的 forceResync 频率限制，最坏情况下需要 7 秒才能纠正一个大偏差
- 根因：设计选择，不是 bug。但与客户端的 syncTick（1秒间隔）相比，statusReport 的 2 秒间隔使得服务器端的偏差检测比客户端慢
- 修复方案：可以考虑将 statusReport 间隔缩短到 1 秒，与 syncTick 对齐：
  ```javascript
  // index.html 中：
  setInterval(function() {
      // ...
  }, 1000); // 从 2000 改为 1000
  ```

### [MEDIUM-2] ClockSync EMA 平滑可能延迟 offset 收敛

- 文件：`web/static/js/sync.js` `handlePong()` 方法，约第 85-90 行
- 现象：网络条件变化后，offset 需要多个样本才能收敛到新值
- 根因：
  ```javascript
  if (this.synced && Math.abs(newOffset - this.offset) < 10) {
      this.offset = 0.7 * this.offset + 0.3 * newOffset;
  } else {
      this.offset = newOffset;
  }
  ```
  当 offset 变化 < 10ms 时，使用 0.7/0.3 的 EMA。这意味着如果真实 offset 突然变化了 8ms，需要约 7 个样本才能收敛到 90%（0.7^7 ≈ 0.08）。在稳态 5 秒间隔下，这需要 35 秒。
  
  这不是漂移的根因，但会延迟偏差检测的准确性。

- 修复方案：这个设计是合理的（防止抖动），不需要修改。只是记录为已审查。

### [MEDIUM-3] 旧代码残留检查 — 未发现问题

- 审查结果：
  - `_driftOffset`：未在任何文件中找到
  - `playbackRate`：未在任何文件中找到（除了 Web Audio API 默认值）
  - 三层纠正代码：已完全清除
  - Sync Watchdog：未在 index.html 中找到残留
  - 结论：旧代码已清理干净，无残留冲突

## 服务器主动性评估

### syncTick 广播
- **频率**：每秒 1 次 ✓
- **位置计算**：`currentPos = pos + time.Since(startT).Seconds()` ✓ 正确
- **问题**：不发送给 host（见 CRITICAL-3）
- **条件阻断**：只在 `state == StatePlaying && clientCount > 1` 时发送。单人房间不发送 syncTick，这是合理的。但如果 host 不算在内（见 CRITICAL-3），实际上 2 人房间只有 1 个非 host 客户端收到 syncTick

### statusReport 处理
- **500ms 阈值**：作为服务器端的"最后防线"是合理的，客户端已经在 150ms 处做了纠正
- **drift 计算**：`drift = clientPos - expectedPos`，与客户端的 `drift = actualPos - serverPos` 方向一致 ✓
- **问题**：forceResync 的 5 秒频率限制在 CRITICAL-2 存在的情况下过于严格。修复 CRITICAL-2 后，5 秒限制是合理的

### forceResync
- **发送条件**：drift > 500ms 且距上次 > 5 秒
- **评估**：在修复 CRITICAL-2 后，这个设计是合理的。服务器作为最后防线，客户端的 syncTick handler 负责 80-500ms 范围的纠正

### 总体评估
服务器的主动性设计是合理的（syncTick 广播 + statusReport 检测 + forceResync 纠正），但有两个问题：
1. Host 被排除在 syncTick 之外（CRITICAL-3）
2. CRITICAL-2 的 segment 微调 bug 导致偏差持续增长，超出了纠正机制的能力

## 偏差检测盲区分析

### 盲区 1：segment 微调导致的隐性偏差（CRITICAL-2）
- `getCurrentTime()` 基于 `startOffset + ctx.currentTime - startTime` 计算，不受 segment 调度时间影响
- 但实际音频输出时间被 `schedTime = t - ld * 0.5` 修改了
- 结果：`getCurrentTime()` 报告的位置和实际音频输出位置之间存在隐性偏差
- syncTick 的 drift 检测基于 `getCurrentTime()`，所以检测到的 drift 不包含这个隐性偏差
- **这是最大的盲区**：偏差在音频输出层面持续增长，但同步检测层面看不到

### 盲区 2：150ms 阈值附近的振荡
- 如果偏差在 140-160ms 之间波动，`_driftCount` 会反复归零
- 修复方案：降低阈值到 80ms（见 HIGH-1）

### 盲区 3：冷却期内的偏差
- 5 秒冷却期内，除了一次 post-reset verify，所有偏差都被忽略
- 如果 verify 通过（偏差 < 150ms）但仍有 100ms 偏差，冷却期结束后需要再等 3 个 syncTick（3秒）才能触发重置
- 修复方案：缩短冷却期到 3 秒（见 HIGH-1）

### 盲区 4：host 完全没有偏差检测
- Host 不接收 syncTick，`_driftCount` 机制不工作
- 只能依赖 statusReport → forceResync 路径（500ms 阈值 + 5 秒限制）
- 修复方案：让 host 也接收 syncTick（见 CRITICAL-3）

## 结论

**根因排序**：

1. **CRITICAL-2（segment 边界微调）是最可能的漂移根因**。每个 5 秒 segment 引入 `drift * 0.5` 的调度偏差，但不更新 `_nextSegTime`，导致音频输出位置和逻辑位置之间的隐性偏差持续累积。10 分钟播放可累积数秒偏差。且由于 `getCurrentTime()` 不反映这个偏差，syncTick 的 drift 检测无法发现它。

2. **CRITICAL-1（forceResync 被拦截器吞掉）** 削弱了服务器端的纠正能力。即使服务器检测到大偏差并发送 forceResync，拦截器的处理缺少 `_postResetVerify` 和 `scheduledAt`，降低了纠正精度。

3. **CRITICAL-3（host 不接收 syncTick）** 使得 host 端完全没有客户端级别的偏差检测。

**建议修复优先级**：
1. 先修复 CRITICAL-2（删除 segment 微调），这应该能立即消除漂移的主要来源
2. 修复 CRITICAL-1（删除拦截器中的 forceResync 处理）
3. 修复 CRITICAL-3（syncTick 发送给 host）
4. 调整 HIGH-1 的阈值参数

修复 CRITICAL-2 后，如果仍有小幅漂移，再考虑调整阈值参数。segment 微调机制的设计初衷是好的（减少 hard reset 次数），但实现上的 bug 使其成为了漂移的主要来源。在服务器权威模式下，建议完全依赖 syncTick + hard reset 来纠正偏差，不在 segment 调度层面做微调。
