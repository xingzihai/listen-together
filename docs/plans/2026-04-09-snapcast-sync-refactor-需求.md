# 方案C 实施需求文档

> 目标：复用 Snapcast 同步算法，将 ListenTogether 同步精度从 ±200ms 提升到 ≤10ms

## 一、背景

### 当前问题

| 问题 | 严重程度 | 说明 |
|------|----------|------|
| getCurrentTime() 精度差 | **严重** | 使用 ctx.currentTime 推算，underrun 时位置虚高 |
| SharedArrayBuffer 未实现 | **严重** | 无法零延迟读取 worklet consumed frames |
| 三层纠正逻辑混乱 | 中等 | Tier 2 playbackRate ±2-3% 可能变调感知 |
| 文档 vs 代码不一致 | 中等 | SYNC-DESIGN.md 规划正确，但代码完全没按文档实现 |

### 目标指标

| 指标 | 当前 | 目标 |
|------|------|------|
| getCurrentTime 精度 | ±100ms | ±2ms |
| 跨设备同步精度 | ±200ms | ≤10ms |
| 漂移累积 | 无限增长 | 收敛到 <1ms |
| 感知风险 | playbackRate ±2-3% | ±0.05% 无感 |

---

## 二、需求详情

### 需求 1：启用 SharedArrayBuffer（最高优先级）

**描述**：添加 COOP/COEP 安全头，让浏览器允许使用 SharedArrayBuffer

**验收标准**：
- 浏览器 console 无 SharedArrayBuffer 警告
- `typeof SharedArrayBuffer !== 'undefined'` 返回 true
- 所有静态资源正常加载

**约束**：
- COOP/COEP 可能影响跨域资源加载，需测试

---

### 需求 2：worklet SharedArrayBuffer 支持

**描述**：让 worklet 能原子更新 consumed frames，主线程能零延迟读取

**验收标准**：
- worklet 能接收 SharedArrayBuffer 初始化消息
- 主线程能通过 `Atomics.load()` 读取 consumed frames
- underrun 时 consumed frames 不增长（位置自然停住）

**约束**：
- 保留 fallback：如果 SAB 不可用，使用 postMessage stats

---

### 需求 3：重写 getCurrentTime()

**描述**：用 Snapcast 公式计算播放位置

**公式**：
```
position = anchorPos + consumed / sampleRate
```

**验收标准**：
- 精度 ±2ms（从 ±100ms 提升）
- underrun 时位置不虚高
- 与服务器时间计算的位置误差 <5ms

---

### 需求 4：简化 drift 检测逻辑

**描述**：复用 Snapcast Soft Correction 算法，移除混乱的三层纠正

**算法**：
```javascript
// 1. 计算期望位置
expectedPos = anchorPos + (serverNow - anchorServerTime) / 1000

// 2. 获取真实位置
actualPos = getCurrentTime() // 基于 consumed

// 3. 计算 drift
driftSec = actualPos - expectedPos
driftSamples = driftSec * nominalRate

// 4. Soft Correction（最大 ±0.05%）
correctAfterXFrames = nominalRate / |driftSamples / correctionTime|
// 每 N 帧 drop 1 帧（加速）或 duplicate 1 帧（减速）
```

**验收标准**：
- 漂移收敛到 <10ms
- 无变调感知（修正率 ≤0.05%）
- 长时间播放不累积漂移

---

### 需求 5：移除不需要的逻辑

**描述**：删除混乱的 Tier 2/3 和 playbackRate 相关代码

**删除项**：
- `_driftOffset`, `_pendingDriftCorrection`, `_softCorrectionTotal`
- Tier 1 `_nextSegTime` 调整逻辑
- Tier 2 playbackRate ±2-3% 逻辑
- 相关的 setTimeout/setInterval timers

**保留项**：
- Lookahead Scheduler（正确的 segment 调度）
- ClockSync（正确的 NTP 式时钟同步）
- Tier 3 硬重置（但阈值降低到 100ms）

---

## 三、范围围栏

### 在范围内

- `main.go` — COOP/COEP headers
- `worklet-processor.js` — SharedArrayBuffer 支持
- `player.js` — 同步逻辑重写
- `sync.js` — 不需要修改（已正确）

### 在范围外

- 服务器 WebSocket 协议
- 房间管理、用户认证、播放列表
- 前端 UI（除 drift debug 显示）
- app.js、auth.js、cache.js

---

## 四、风险与缓解

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| COOP/COEP 影响资源加载 | 低 | 测试所有静态资源 |
| SharedArrayBuffer 浏览器兼容 | 低 | 保留 fallback 用 postMessage |
| 大漂移处理不够快 | 中 | Tier 3 阈值降低到 100ms |
| Lookahead Scheduler 冲突 | 低 | 测试 segment 调度 |

---

## 五、验收测试

1. **精度测试**：两个浏览器窗口同时播放，测量漂移
2. **underrun 测试**：模拟网络卡顿，检查位置是否正确
3. **后台恢复测试**：页面后台切换回来，检查同步恢复
4. **长时间测试**：播放 10 分钟，检查漂移收敛
5. **兼容性测试**：Chrome、Firefox、Safari

---

## 六、时间估算

| Phase | 预计时间 |
|-------|----------|
| Phase 1：COOP/COEP | 10 分钟 |
| Phase 2：worklet SAB | 20 分钟 |
| Phase 3：player.js 重写 | 40 分钟 |
| 测试验证 | 30 分钟 |

**总计**：约 100 分钟