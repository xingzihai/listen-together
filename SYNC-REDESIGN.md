# ListenTogether 同步架构重设计：服务器权威模式

> 设计日期：2026-02-21
> 设计原则：服务器是唯一真相源，客户端只是执行者

---

## 一、当前架构的问题

1. **客户端自治**：每个客户端独立计算漂移、独立决定纠正策略，一旦本地状态脏了（offset错误、anchor过期），纠正逻辑反而加剧偏差
2. **三层纠正互相干扰**：soft correction调_nextSegTime、playbackRate调速率、hard reset重启播放——三者叠加可能振荡
3. **断线后无恢复机制**：重连后客户端尝试用旧的anchor继续播放，但服务器已经走了很远
4. **没有服务端校验**：statusReport上报位置后，服务端只在偏差>400ms时才发forceResync，且客户端可以忽略

## 二、新架构：服务器权威 + 双层纠正

### 核心原则

```
服务器说"现在播到1:23.456"→ 客户端必须在1:23.456 ± 容忍度内
超出容忍度 → 服务器主动下发纠正指令
客户端不做任何自主漂移纠正决策
```

### 服务器端职责

1. **维护权威播放位置**
   - 服务器持续追踪每个房间的精确播放位置：`position = startPosition + time.Since(startTime)`
   - 这是唯一真相源，所有客户端以此为准

2. **高频心跳广播（syncTick）**
   - 频率：每500ms一次（当前1s，改为500ms）
   - 内容：`{ type: "syncTick", position: 精确位置, serverTime: 服务器时间戳 }`
   - 只发给非host的客户端（host是时间源，不需要纠正）

3. **客户端状态校验**
   - 客户端每2秒上报一次statusReport：`{ position, trackIndex, isPlaying }`
   - 服务器收到后计算偏差：`drift = clientPosition - serverPosition`
   - 根据偏差大小下发不同指令（见下方双层策略）

4. **操作确认机制**
   - play/pause/seek/切歌：服务器处理后广播确认，客户端收到确认才执行
   - 当前已经是这样（服务器broadcast），但客户端需要更严格地只响应服务器指令

### 双层纠正策略（服务器决策，客户端执行）

#### 第一层：柔性纠正（drift ≤ 200ms）

- **触发条件**：服务器检测到客户端偏差在 50ms~200ms 之间
- **服务器动作**：在syncTick中附加 `correction` 字段
  ```json
  {
    "type": "syncTick",
    "position": 83.456,
    "serverTime": 1708512345678,
    "correction": {
      "type": "soft",
      "drift": 0.085,
      "rate": 0.98
    }
  }
  ```
- **客户端动作**：
  - 调整playbackRate为服务器指定的值（如0.98表示减速2%）
  - 持续到下一个syncTick重新评估
  - 不打断播放，用户无感知
- **退出条件**：drift回到50ms以内，服务器不再附加correction字段，客户端恢复rate=1.0

#### 第二层：强制重置（drift > 200ms）

- **触发条件**：服务器检测到客户端偏差超过200ms（通过statusReport或连续3个syncTick无改善）
- **服务器动作**：发送forceResync指令
  ```json
  {
    "type": "forceResync",
    "position": 83.456,
    "serverTime": 1708512345678,
    "reason": "drift_exceeded"
  }
  ```
- **客户端动作**：
  - 立即调用 `playAtPosition(position, serverTime)`
  - 停止当前播放 → 从新位置重新开始
  - 会有短暂中断（~100ms），但能立即恢复同步

#### 特殊场景处理

| 场景 | 服务器行为 | 客户端行为 |
|------|-----------|-----------|
| 客户端断线重连 | 在join响应中附带当前精确position+serverTime | 无条件playAtPosition |
| 页面后台恢复 | 客户端发statusReport，服务器检测大偏差→forceResync | 执行forceResync |
| 切歌 | 广播trackChange+新position | 停止旧歌→加载新歌→playAtPosition |
| host断线 | OwnerID转移（已修复），新host的播放状态成为参考 | 其他客户端等待syncTick |
| 网络延迟突变 | clockSync的offset变化会被syncTick覆盖 | 不依赖本地offset计算 |

### 客户端端职责（简化）

1. **去掉所有自主纠正逻辑**
   - 删除 correctDrift 中的三层纠正决策
   - 删除 _driftOffset 累积机制
   - 删除 _pendingDriftCorrection
   
2. **只响应服务器指令**
   - 收到syncTick → 如果有correction字段，调整playbackRate
   - 收到syncTick → 如果没有correction字段，确保rate=1.0
   - 收到forceResync → 无条件playAtPosition
   
3. **定期上报状态**
   - 每2秒发送statusReport（当前位置、trackIndex、isPlaying）
   - 这是服务器校验的数据来源

4. **断线重连**
   - 重连后等待服务器下发当前状态
   - 不尝试用本地缓存的位置恢复播放

## 三、需要修改的文件

### 服务器端（Go）
- `main.go`：
  - syncTick改为500ms，增加correction计算逻辑
  - statusReport处理增加双层纠正决策
  - 维护每个客户端的最近上报位置（用于漂移检测）

### 客户端（JS）
- `player.js`：
  - correctDrift 简化为只执行服务器指令
  - 新增 applySoftCorrection(rate) 和 applyForceResync(position, serverTime)
- `app.js`：
  - handleMessage 中处理新的syncTick.correction字段
  - statusReport上报逻辑调整
- `index.html`：
  - 移除statusReport的onmessage拦截器（统一到app.js）

### 不需要修改
- `sync.js`：时钟同步仍然需要，用于将serverTime转换为本地时间
- `cache.js`：不涉及
- `worklet-processor.js`：不涉及

## 四、阈值参数

| 参数 | 值 | 说明 |
|------|-----|------|
| syncTick频率 | 500ms | 服务器广播间隔 |
| statusReport频率 | 2000ms | 客户端上报间隔 |
| 柔性纠正阈值 | 50ms | 低于此值不纠正 |
| 柔性纠正上限 | 200ms | 超过此值转强制重置 |
| 强制重置阈值 | 200ms | 直接playAtPosition |
| playbackRate范围 | 0.95~1.05 | 柔性纠正的速率调整范围 |
| 柔性纠正超时 | 3次syncTick | 连续3次无改善则升级为强制重置 |

## 五、预期效果

- 正常情况：偏差始终<50ms，无任何纠正动作
- 轻微漂移：50-200ms，playbackRate微调，用户无感
- 严重失同步：>200ms，100ms内强制恢复，短暂中断但立即同步
- 断线重连：重连后1秒内恢复同步（等待第一个syncTick或join响应）
