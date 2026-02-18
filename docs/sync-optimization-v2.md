# 同步优化设计 v2

## 当前问题分析

### 问题1：预约起播用setTimeout（误差4-15ms）
```
服务端: scheduledAt = serverTime + 500ms
客户端: setTimeout等待 → 醒来后算elapsed → source.start(ctx.currentTime)
```
setTimeout的回调时间不精确，实际起播时刻在不同设备上有4-15ms随机偏差。

### 问题2：一次排完所有segment，漂移矫正无效
`_scheduleFrom`用for循环把整首歌的所有segment一次性`source.start(t)`排进音频队列。
改playbackRate只对"当前正在播放的source"有效，已排队到未来时间点的source不受影响。
结果：correctDrift的playbackRate策略几乎无效。

### 问题3：sources数组无限增长
播完的source不清理，correctDrift遍历全部（可能几十个已死节点）。

## 优化方案

### 改动1：Lookahead调度器（替代一次排完）
**核心思想**：不一次排完所有segment，只预排未来2个segment。用setInterval每200ms检查，按需补排。

```
旧: playAtPosition → _scheduleFrom → for循环排完所有segment
新: playAtPosition → 排当前+下一个segment → _lookahead定时器每200ms补排
```

好处：
- correctDrift可以在下一个segment边界自然修正位置
- stop/seek时不需要cancel几十个source，只cancel 1-2个
- 内存友好，sources数组始终很短

### 改动2：硬件级预约起播
**核心思想**：收到scheduledAt后，不用setTimeout等待，直接算出对应的ctx时间，用source.start(ctxTarget)。

```
旧: setTimeout(waitMs) → source.start(ctx.currentTime)
新: ctxTarget = ctx.currentTime + (scheduledAt - getServerTime())/1000
    source.start(ctxTarget, offset)
```

关键：getCurrentTime()必须兼容"startTime在未来"的情况，返回max(0, 计算值)。

### 改动3：segment边界漂移矫正
**核心思想**：不改playbackRate，在下一个segment排入时调整位置。

```
旧: correctDrift → 改playbackRate（对已排队无效）
新: _lookahead补排时 → 检查漂移 → 调整下一个segment的起始位置
```

漂移<50ms：在下一个segment的offset里补偿（跳过或重叠几十ms，听感无感知）
漂移>200ms：hard resync（stop + playAtPosition）

## 改动范围
- sync.js: 不改（当前够用）
- player.js: 重写playAtPosition、_scheduleFrom、correctDrift，新增_lookahead
- app.js: 不改（driftInterval保留，correctDrift接口不变）

## 风险控制
- getCurrentTime()必须处理startTime在未来的情况
- _lookahead定时器必须在stop()时清除
- _upgradeQuality里的_scheduleFrom调用需要适配
