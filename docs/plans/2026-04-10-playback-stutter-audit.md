# 播放卡顿问题审查报告

> 时间：2026-04-10 13:00
> 问题：用户报告"卡爆了"，播放完全卡顿，无法正常听
> 方法：5个子agent并行审查（player.js、worklet-processor.js、服务端、网络请求、内存性能）

---

## 🔴 根本原因（P0 - 必须立即修复）

### 问题 1：broadcast() 同步阻塞

**位置**：`main.go` 行 772-777

```go
func broadcast(rm *room.Room, msg WSResponse, excludeID string) {
    for _, c := range rm.GetClients() {
        if c.ID != excludeID {
            c.Send(msg)  // ← 阻塞！一个慢客户端卡所有人
        }
    }
}
```

**影响**：🔴 **极严重** - 一个网络慢的客户端会阻塞所有客户端

**修复方案**：改为异步发送 `go c.Send(msg)`

---

### 问题 2：worklet-processor.js 高频 console.log

**位置**：`worklet-processor.js` 行 63

```javascript
console.log(`[worklet] PCM received: ${frames} frames, buffered=${this._buffered}`);
```

**影响**：🔴 **极严重** - AudioWorklet 音频线程中的同步阻塞输出

**修复方案**：完全移除

---

### 问题 3：player.js _driftLoop 高频 console.log

**位置**：`player.js` 行 422, 449

```javascript
console.log(`[sync] WAITING_ANCHOR: ...`);  // L422
console.log(debugMsg);  // L449，每秒输出详细drift信息
```

**影响**：🔴 **极严重** - 主线程阻塞

**修复方案**：移除或仅在异常时输出

---

### 问题 4：_feedPCMSegments 同步等待网络

**位置**：`player.js` 行 208-244

```javascript
async _feedPCMSegments(startPos) {
    for (let i = startSeg; i < ...; i++) {
        if (!this.buffers.has(i)) {
            await this.loadSegment(i);  // ← 阻塞播放！
        }
    }
}
```

**影响**：🔴 **严重** - 网络慢时播放卡顿

**修复方案**：分离预加载和feeding，feeding只处理已缓存数据

---

### 问题 5：_feedLoop 预加载逻辑错误

**位置**：`player.js` 行 307-311

```javascript
if (bufferedSec < 3 && this._workletBuffered < this._nominalRate * 10) {
    const currentSeg = Math.floor(currentPos / this.segmentTime);
    this._feedPCMSegments(currentSeg * this.segmentTime);  // ← 总是从当前片段开始，重复加载
}
```

**影响**：🔴 **严重** - 重复加载已有片段，条件逻辑混乱

**修复方案**：从缓冲结束位置开始预加载，修正条件

---

## 🟠 重要问题（P1 - 建议修复）

### 问题 6：decodeAudioData 主线程阻塞

**位置**：`player.js` 行 168

**影响**：🟠 中等 - FLAC解码阻塞UI

**修复方案**：使用 Web Worker 后台解码

---

### 问题 7：逐帧写入 buffer 低效

**位置**：`worklet-processor.js` 行 68-72, 78-82

**影响**：🟠 中等 - CPU占用高

**修复方案**：使用批量复制 `bufL.set(left, writePos)`

---

### 问题 8：预加载只加载2个segment

**位置**：`player.js` 行 62

**影响**：🟠 中等 - 缓冲耗尽快

**修复方案**：增加到4-6个

---

### 问题 9：worklet缓冲区只有5秒

**位置**：`worklet-processor.js` 行 4-5

**影响**：🟠 中等 - 网络波动时卡顿

**修复方案**：增加到10秒

---

### 问题 10：SyncTick Send 阻塞

**位置**：`main.go` 行 229-277

**影响**：🟠 中等 - 同步延迟

**修复方案**：改为异步发送

---

## 🟢 次要问题（P2 - 可选优化）

### 问题 11：Cache API 无大小限制

**位置**：`cache.js`

**影响**：🟡 低 - 长时间播放内存膨胀

---

### 问题 12：WebSocket debug 发送过多

**位置**：`player.js` 行 493-503

**影响**：🟡 低 - 网络开销

---

## 📊 修复优先级

| 优先级 | 问题 | 文件 | 预计工作量 |
|--------|------|------|-----------|
| P0-1 | broadcast 阻塞 | main.go | 5分钟 |
| P0-2 | worklet console.log | worklet-processor.js | 1分钟 |
| P0-3 | driftLoop console.log | player.js | 2分钟 |
| P0-4 | _feedPCMSegments 阻塞 | player.js | 15分钟 |
| P0-5 | _feedLoop 逻辑错误 | player.js | 10分钟 |
| P1-1 | decodeAudioData 阻塞 | player.js | 30分钟 |
| P1-2 | 逐帧写入优化 | worklet-processor.js | 10分钟 |
| P1-3 | 预加载数量 | player.js | 1分钟 |
| P1-4 | 缓冲区大小 | worklet-processor.js | 1分钟 |
| P1-5 | SyncTick 异步 | main.go | 5分钟 |

---

## 🔧 修复计划

### 阶段1：P0 修复（预计30分钟）

1. 移除高频 console.log（3处）
2. broadcast 改为异步
3. 修复 _feedLoop 预加载逻辑
4. 重构 _feedPCMSegments（分离预加载和feeding）

### 阶段2：P1 优化（预计45分钟）

5. 批量写入优化
6. 增加预加载数量和缓冲区
7. SyncTick 异步化
8. Web Worker 解码（可选）

### 阶段3：验证

- 修复完成后再次运行5个子agent审查
- 验证所有P0问题已修复

---

## 📝 修复记录

| 时间 | 问题 | 状态 |
|------|------|------|
| 13:05 | P0-1 broadcast 阻塞 | ✅ 已修复 - 改为异步发送 |
| 13:05 | P0-2 worklet console.log | ✅ 已修复 - 移除高频日志 |
| 13:05 | P0-3 driftLoop console.log | ✅ 已修复 - 只在 drift>50ms 时警告 |
| 13:06 | P0-4 _feedPCMSegments 阻塞 | ✅ 已修复 - 后台加载，非阻塞 |
| 13:06 | P0-5 _feedLoop 逻辑错误 | ✅ 已修复 - 从缓冲结束位置预加载 |
| 13:06 | P1-3 预加载数量 | ✅ 已修复 - 从2增加到4 |
| 13:06 | P1-4 缓冲区大小 | ✅ 已修复 - 从5秒增加到10秒 |
| 13:06 | P1-5 SyncTick 异步 | ✅ 已修复 - 改为异步发送 |