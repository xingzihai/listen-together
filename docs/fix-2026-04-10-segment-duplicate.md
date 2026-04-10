# Segment重复Feed修复 - 2026-04-10

## 问题现象

播放音乐时在30秒和50秒左右反复跳跃，无法正常听音乐，只有噪音。

## 根因分析

### 为什么是30秒和50秒？

- 每个segment时长 = 5秒
- 30秒 = segment 6 边界
- 50秒 = segment 10 边界
- `_feedPCMSegments` 的 preloadCount = 5

### 问题机制

```
播放到30秒附近
  → worklet buffer消耗到<5秒
  → _feedLoop检测到buffer不足
  → 调用 _feedPCMSegments(30)
  → 发送 segment 6-10 的PCM数据
  
但是！segment 6-10 可能已经在buffer中：
  → 之前播放到25秒时，已经feed过 segment 5-9
  → 现在30秒处又feed segment 6-10
  → segment 6-9 被重复追加到buffer末尾
  
结果：
  → worklet读完segment 6的正确数据后
  → 又遇到重复的segment 6数据
  → 播放位置跳跃回30秒附近
  → 形成30秒-50秒的跳跃循环
```

### 为什么没有去重？

原始代码：

```javascript
async _feedPCMSegments(startPos) {
    const startSeg = Math.floor(startPos / this.segmentTime);
    const preloadCount = 5;
    
    // 直接从startSeg开始feed，不检查是否已feed过
    for (let i = startSeg; i < Math.min(startSeg + preloadCount, this.segments.length); i++) {
        // ... 发送PCM数据
    }
}
```

- 没有记录哪些segment已经发送
- 每次调用都发送5个segment
- Worklet收到数据后直接追加到ring buffer末尾

## 修复方案

### 1. 添加状态变量

```javascript
this._fedSegEnd = -1; // Last segment index that was fed to worklet
```

### 2. _feedPCMSegments 去重

```javascript
async _feedPCMSegments(startPos) {
    const startSeg = Math.floor(startPos / this.segmentTime);
    const preloadCount = 5;
    
    // KEY FIX: Only feed segments after _fedSegEnd
    const actualStartSeg = Math.max(startSeg, this._fedSegEnd + 1);
    const endSeg = Math.min(actualStartSeg + preloadCount, this.segments.length);
    
    if (actualStartSeg >= endSeg) {
        // No new segments to feed
        return;
    }
    
    for (let i = actualStartSeg; i < endSeg; i++) {
        // ... 发送PCM数据
        this._fedSegEnd = Math.max(this._fedSegEnd, i);
    }
}
```

### 3. _feedLoop 改进

```javascript
_feedLoop() {
    // KEY FIX: Calculate buffered end based on fed segments
    const fedEndPos = (this._fedSegEnd + 1) * this.segmentTime;
    const remainingBufferSec = fedEndPos - this.getCurrentTime();
    
    if (remainingBufferSec < 5) {
        const nextSeg = this._fedSegEnd + 1;
        if (nextSeg < this.segments.length) {
            this._feedPCMSegments(nextSeg * this.segmentTime);
        }
    }
}
```

### 4. 关键位置重置

```javascript
// playAtPosition
const startSeg = Math.floor(this._anchorPos / this.segmentTime);
this._fedSegEnd = startSeg - 1;  // Will feed from startSeg

// stop
this._fedSegEnd = -1;

// correctDrift
const newStartSeg = Math.floor(serverExpected / this.segmentTime);
this._fedSegEnd = newStartSeg - 1;

// _driftLoop hard resync
const resyncSeg = Math.floor(expectedPos / this.segmentTime);
this._fedSegEnd = resyncSeg - 1;
```

## 测试结果

| 测试项 | 结果 |
|-------|------|
| 播放启动 | ✅ 正常 |
| 30秒跳跃 | ✅ 已修复 |
| 50秒跳跃 | ✅ 已修复 |
| 长时间播放 | ✅ 正常（有小跳跃，待观察） |
| 多设备同步 | ⏸️ 待测试 |
| **手机端播放** | ❌ **完全无法正常播放，一直在跳变** |

## 后续问题

### 问题1：还有一些奇怪的跳跃（桌面端）

可能原因：
1. drift纠正触发的hard resync导致buffer重新feed
2. worklet ring buffer的overflow处理
3. segment加载延迟导致的buffer underrun

### 问题2：手机端完全无法播放（严重）

**现象**：手机端播放时一直在跳变，无法正常听音乐

**可能原因**：
1. 手机浏览器对 SharedArrayBuffer 支持不同
2. 手机 AudioWorklet 实现差异（Safari/Chrome Mobile）
3. 手机CPU性能不足导致worklet处理延迟
4. 手机网络延迟更高，导致segment加载不及时
5. 触屏交互可能导致页面visibility变化频繁

**待排查**：
- 检查手机浏览器控制台日志（需调试方案）
- 测试 SharedArrayBuffer 是否正常初始化
- 测试 fallback 模式（无SAB时的postMessage stats）

## 文件变更

- `web/static/js/player.js`：添加 `_fedSegEnd` 和去重逻辑

## 部署记录

- 时间：2026-04-10 21:33 GMT+8
- 服务器：107.172.234.183:8443
- 版本：v0.7.2