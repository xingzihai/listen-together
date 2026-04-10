# 同步调试日志

> 时间：2026-04-10 00:56
> 目标：实现自动化播放调试 API，远程控制播放，避免人工手动测试
> 方法：WebSocket 调试命令 + 服务端日志

---

## 紧急需求

**问题**：手动测试太痛苦，声音卡顿导致神经衰弱
**方案**：添加远程调试 API，我通过 SSH 执行命令控制播放

---

## 自动化调试 API 设计

### HTTP 调试 API（已实现）

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/debug/status` | GET | 获取当前播放状态 |
| `/api/debug/log` | GET | 获取最近 100 行日志 |

### 返回格式

**`/api/debug/status`**:
```json
{
  "lastUpdate": "16:55:00",
  "clientId": "abc123",
  "serverTrackIdx": 0,
  "serverState": "playing",
  "serverPos": 10.5,
  "clientPos": 10.3,
  "expectedPos": 10.5,
  "driftMs": 200,
  "duration": 180
}
```

**`/api/debug/log`**: 纯文本日志

### 使用方式

```bash
# 获取状态
curl -k https://107.172.234.183:8443/api/debug/status

# 获取日志
curl -k https://107.172.234.183:8443/api/debug/log
```

---

## 实施计划

| 步骤 | 任务 | 状态 |
|------|------|------|
| 1 | 更新文档 | ✅ 完成 |
| 2 | 添加 HTTP 调试 API 到 main.go | ✅ 完成 |
| 3 | 编译并部署 | 进行中 |
| 4 | 测试 API 可用性 | 待实施 |
| 5 | 自动化调试循环 | 待实施 |

---

## 调试策略

### 我的能力边界
- ✅ 可通过 SSH 读取服务端日志
- ✅ 可通过 SSH 执行 curl 命令
- ❌ 无法直接观察浏览器渲染

### 信息收集渠道
1. **服务端日志**：`tail /tmp/listen-together.log`
2. **HTTP API 返回**：curl 命令输出
3. **前端状态上报**：通过 API 返回

---

## 发现的问题

### 问题 1：drift 狂跳 14-25 秒（已修复）

**根因**：
- `_nominalRate` 硬编码 48000，但实际可能是 44100
- anchor 在 PCM 还没播放时就设置，elapsedSec 开始累加但 consumed=0

**修复**：
- 从 AudioContext 获取实际采样率
- 在 worklet 开始消费帧时才设置 anchor
- 添加 `_anchorSet` 检查

**提交**：player.js 修改，已上传到服务器

---

## 待实施

### Phase 1：增强 Console.log（✅ 完成）

关键位置添加格式化输出：
- `_driftLoop()`: drift 计算过程 ✅
- `_feedLoop()`: buffer 状态（可选）
- `getCurrentTime()`: consumed 值（在 driftLoop 中输出）
- worklet stats: buffered/consumed ✅

### Phase 2：服务端日志推送（✅ 完成）

通过 WebSocket 发送 debug 消息，服务端写入日志。✅

---

---

## 关键发现（2026-04-10 01:01）

### 问题定位

通过调试 API 获取的数据：
```
serverPos=0.00 clientPos=20.86 expected=1.74 drift=19116ms
```

**核心问题**：`clientPos` 远大于 `expectedPos`！

| 变量 | 值 | 含义 |
|------|-----|------|
| serverPos | 0.00 | 服务器记录的起始位置 |
| clientPos | 20.86 | 客户端 `getCurrentTime()` 返回值 |
| expectedPos | 1.74 | 期望位置 = serverPos + elapsed |
| drift | 19116ms | 偏差 = clientPos - expectedPos |

### 根因分析

`getCurrentTime()` 返回 `anchorPos + consumed / sampleRate`

**核心问题**：`consumed` 值异常累积

### 调用链分析

```
playAtPosition() 
  → stop()           // 此时 workletNode 可能存在（旧的）
    → 发送 clear 到旧 workletNode
  → _createWorkletNode()  // 有 `if (this.workletNode) return;` 跳过创建！
  → 复用旧 workletNode
  → 旧的 _totalConsumedFrames 没有被重置
```

### Bug 确认

1. `_createWorkletNode()` 有 `if (this.workletNode) return;`，跳过创建新节点
2. `stop()` 只发送 clear 消息，但没有销毁 workletNode
3. 页面多次播放后，consumed 累积且未重置

---

## 修复方案

### 修改内容

| 文件 | 修改 |
|------|------|
| `stop()` | 断开并销毁 workletNode，重置所有状态 |
| `_createWorkletNode()` | 移除 `if (this.workletNode) return;`，每次创建新节点 |
| `_initSharedBuffer()` | 移除重复检查 |
| `playAtPosition()` | 确保流程正确 |

### 核心原则

**每次播放都创建全新的 workletNode，确保状态完全干净**

---

## 已修复的问题

### Bug 1：采样率硬编码 ✅
- 问题：`_nominalRate = 48000` 硬编码
- 修复：从 `AudioContext.sampleRate` 获取实际值

### Bug 2：锚点设置时机 ✅
- 问题：在 PCM 还没播放时就设置 anchor
- 修复：在 worklet 开始消费帧时才设置 anchor（`_anchorSet`）

### Bug 3：getCurrentTime() 未检查 anchor ✅
- 问题：anchor 未设置时仍返回基于 consumed 的值
- 修复：anchor 未设置时返回 `anchorPos`

### Bug 4：workletNode 复用导致状态污染 ✅（本次修复）
- 问题：workletNode 被复用，旧的 consumed 累积
- 修复：每次 stop() 销毁 workletNode，每次播放创建新的

## 调试记录

| 时间 | 操作 | 结果 |
|------|------|------|
| 00:12 | 发现 drift 狂跳 | 问题定位 |
| 00:14 | 分析根因 | 采样率+锚点时机 |
| 00:15 | 修复并上传 | 等待测试 |
| 00:20 | 开始系统调试 | 本文档创建 |
| 00:22 | 增强 Console.log | 格式化输出 |
| 00:24 | 添加服务端 debug 处理 | main.go 修改 |
| 00:48 | 发现 drift 仍然 19 秒 | 服务器端计算 |
| 00:50 | 分析 getCurrentTime() | anchorSet 检查缺失 |
| 00:52 | 修复 getCurrentTime() | anchor 未设置时返回 anchorPos |
| 00:56 | 实现调试 API | /api/debug/status |
| 01:01 | 获取关键数据 | clientPos=20.86 expected=1.74 |
| 01:02 | 定位根因 | consumed 值异常 |

---

## 调试输出格式

### 主线程（player.js）
```
[sync] AudioContext sampleRate: 48000
[sync] worklet node created
[sync] SharedArrayBuffer initialized
[sync] playAtPosition: pos=0.00s, waiting for PCM to start...
[sync] _feedPCMSegments: startPos=0.00 startSeg=0 segments=10
[sync] _feedPCMSegments: fed 5 segments to worklet
[sync] ANCHOR_SET: sampleRate=48000 anchorPos=0.000 anchorServerTime=1234567890
[sync] DRIFT: sampleRate=48000 anchorPos=0.000 elapsed=1.234 expected=1.234 actual=1.235 consumed=59232 buffered=240000 drift=2.5ms
```

### Worklet 线程
```
[worklet] SharedArrayBuffer received
[worklet] PCM received: 240000 frames, buffered=240000
[worklet] clear: buffer reset
```

### 服务端日志
```
[debug] client=abc123 sampleRate=48000 anchorPos=0.000 elapsed=1.234 expected=1.234 actual=1.235 consumed=59232 buffered=240000 drift=2.5ms
```

---

## 关键数据定义

| 变量 | 含义 | 来源 |
|------|------|------|
| `_nominalRate` | AudioContext 采样率 | ctx.sampleRate |
| `_anchorPos` | 播放起始位置 | playAtPosition(position) |
| `_anchorServerTime` | anchor 设置时的服务端时间 | clockSync.getServerTime() |
| `_anchorSet` | anchor 是否已设置 | worklet 开始消费时设为 true |
| `_workletConsumed` | 已消费的帧数 | SharedArrayBuffer / postMessage |
| `_workletBuffered` | worklet buffer 中的帧数 | postMessage stats |
| `elapsedSec` | 从 anchor 开始的流逝时间 | (serverNow - anchorServerTime) / 1000 |
| `expectedPos` | 期望位置 | anchorPos + elapsedSec |
| `actualPos` | 实际位置 | anchorPos + consumed / sampleRate |
| `driftSec` | 漂移秒数 | actualPos - expectedPos |

---

## 下一步

1. ~~增强 Console.log 输出~~ ✅ 完成
2. ~~添加服务端 debug 消息处理~~ ✅ 完成
3. ~~上传到服务器~~ ✅ 完成
4. **用户测试播放** → SSH 查看日志分析问题
5. 循环修复直到最佳状态

---

## 调试信息格式

### Console.log 输出（用户复制给我）

```
[sync] ANCHOR_SET: sampleRate=48000 anchorPos=0.000 anchorServerTime=1234567890
[sync] DRIFT: sampleRate=48000 anchorPos=0.000 elapsed=1.234 expected=1.234 actual=1.235 consumed=59232 buffered=240000 drift=2.5ms
[sync] HARD_RESYNC: drift=150ms expected=5.000 actual=5.150
```

### 服务端日志输出（我 SSH 查看）

```
[debug] client=abc123 sampleRate=48000 anchorPos=0.000 elapsed=1.234 expected=1.234 actual=1.235 consumed=59232 buffered=240000 drift=2.5ms
```