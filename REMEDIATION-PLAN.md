# ListenTogether v0.7.0 修复对策文档

> 生成日期：2026-02-21
> 基于攻防测试报告（后端55场景 + 认证14场景 + WS/房间20场景 + 播放/DB/API 28场景 + 前端57场景）
> 过滤规则：已跳过所有 TODO:restore 限制类问题、已正确防护的场景、可接受的设计

---

# P0 立即修复

## 问题 1：Owner默认密码未强制修改——后端不拦截

- **来源场景**: A-01(综合), A-05(认证专项), E-02(DEF)
- **严重程度**: 🔴 致命
- **问题描述**: 默认密码 `admin123` 硬编码在源码中，登录后仅前端提示修改，后端不强制，攻击者可直接用API操作绕过前端提示
- **影响范围**: 整个系统——获取owner权限后可管理所有用户、删除数据、控制所有房间
- **根因分析**: `internal/auth/handlers.go` Login函数（约第145行）仅返回 `needChangePassword: true`，不阻止后续API调用
- **修复方案**:
  在 `AuthMiddleware` 和 `RequireAuth` 中增加默认密码检测拦截。当owner使用默认密码时，除修改密码API外的所有请求返回403。

  **文件**: `internal/auth/auth.go`，在 `validateClaimsAgainstDB` 函数之后新增辅助函数：

  ```go
  // isOwnerWithDefaultPassword checks if the user is owner still using admin123
  func isOwnerWithDefaultPassword(userID int64) bool {
      if authDB == nil {
          return false
      }
      u, err := authDB.GetUserByID(userID)
      if err != nil || u.Role != "owner" {
          return false
      }
      return CheckPassword(u.PasswordHash, "admin123")
  }
  ```

  **文件**: `internal/auth/auth.go`，修改 `RequireAuth` 中间件，在 `tryAutoRenew` 之后、`next.ServeHTTP` 之前添加：

  ```go
  // Block owner with default password from all routes except password change
  if claims.Role == "owner" && r.URL.Path != "/api/auth/password" && isOwnerWithDefaultPassword(claims.UserID) {
      http.Error(w, `{"error":"请先修改默认密码","needChangePassword":true}`, http.StatusForbidden)
      return
  }
  ```

  同样在 `AuthMiddleware` 中添加相同检查（对于非强制认证的路由也需拦截owner操作）。

- **验证方法**: 用 `admin/admin123` 登录后直接调用 `/api/admin/users`，应返回403；修改密码后正常访问
- **注意事项**: 每次请求会多一次DB查询（仅owner触发），可用缓存优化；需确保 `/api/auth/password` 路由不被拦截

---

## 问题 2：删除用户后音频文件清理路径不匹配

- **来源场景**: E-08(综合)
- **严重程度**: 🔴 致命
- **问题描述**: `AdminDeleteUser` 使用 `AUDIO_DIR`（默认 `audio_files`）拼接删除路径，但上传使用 `DataDir/library/{userID}/`，路径不匹配导致文件永远不会被删除
- **影响范围**: 删除用户后磁盘文件残留，存储泄漏，且残留文件可能包含敏感音频内容
- **根因分析**: `internal/auth/handlers.go` 第375-381行 `AdminDeleteUser` 函数：
  ```go
  audioDir := os.Getenv("AUDIO_DIR")
  if audioDir == "" {
      audioDir = "audio_files"  // 错误！上传路径是 ./data/library/{userID}/{uuid}/
  }
  os.RemoveAll(filepath.Join(audioDir, fn))  // fn 是 uuid，拼出 audio_files/{uuid}
  ```
  而上传路径在 `internal/library/handlers.go` 第107行：
  ```go
  audioDir := filepath.Join(h.DataDir, "library", strconv.FormatInt(user.UserID, 10), audioID)
  // 实际路径: ./data/library/{userID}/{uuid}/
  ```
- **修复方案**:
  **文件**: `internal/auth/handlers.go`，修改 `AdminDeleteUser` 中的文件清理逻辑：

  ```go
  // Clean up audio files from disk — use same path structure as upload
  dataDir := os.Getenv("DATA_DIR")
  if dataDir == "" {
      dataDir = "./data"
  }
  for _, fn := range deletedFiles {
      diskPath := filepath.Join(dataDir, "library", strconv.FormatInt(target.ID, 10), fn)
      os.RemoveAll(diskPath)
  }
  // Also try to remove the user's library directory if empty
  userLibDir := filepath.Join(dataDir, "library", strconv.FormatInt(target.ID, 10))
  os.Remove(userLibDir) // only succeeds if empty
  ```

- **验证方法**: 上传音频 → 管理员删除用户 → 检查 `./data/library/{userID}/` 目录是否被清理
- **注意事项**: 需确保 `DATA_DIR` 环境变量与 `LibraryHandlers.DataDir` 一致；建议将路径统一为常量

---

## 问题 3：后台ffmpeg转码goroutine无取消机制

- **来源场景**: F-12(综合)
- **严重程度**: 🟡 高危（影响安全归入P0）
- **问题描述**: `ProcessAudioMultiQuality` 中后台goroutine无context传递，删除文件后goroutine继续运行ffmpeg，浪费CPU资源
- **影响范围**: 上传后立即删除文件时，后台goroutine继续运行ffmpeg进程（每个最长5分钟），可被利用进行CPU耗尽攻击
- **根因分析**: `internal/audio/audio.go` 第148-165行，后台goroutine直接调用 `segmentOneQuality`，无取消机制：
  ```go
  go func() {
      for _, q := range remaining {
          s, err := segmentOneQuality(inputPath, outputDir, q)  // 无context
          // ...
      }
  }()
  ```
- **修复方案**:
  1. 为 `ProcessAudioMultiQuality` 添加 `context.Context` 参数
  2. 将 context 传递给 `segmentOneQuality`
  3. 在删除文件时取消context

  **文件**: `internal/audio/audio.go`

  修改函数签名：
  ```go
  func ProcessAudioMultiQuality(ctx context.Context, inputPath, outputDir, filename string) (*MultiQualityManifest, *ProbeResult, context.CancelFunc, error) {
  ```

  在函数内创建子context：
  ```go
  bgCtx, bgCancel := context.WithCancel(ctx)
  ```

  后台goroutine中检查context：
  ```go
  go func() {
      defer bgCancel()
      for _, q := range remaining {
          if bgCtx.Err() != nil {
              return // cancelled
          }
          s, err := segmentOneQuality(bgCtx, inputPath, outputDir, q)
          // ...
      }
  }()
  return manifest, probe, bgCancel, nil
  ```

  修改 `segmentOneQuality` 使用传入的context：
  ```go
  func segmentOneQuality(ctx context.Context, inputPath, outputDir string, q qualityDef) ([]string, error) {
      // ...
      cmd := exec.CommandContext(ctx, "ffmpeg", args...)
      // ...
  }
  ```

  **文件**: `internal/library/handlers.go`，Upload函数中保存cancelFunc，DeleteFile时调用取消。
  需要在内存中维护一个 `map[int64]context.CancelFunc`（audioFileID → cancel），删除时调用。

- **验证方法**: 上传音频 → 立即删除 → 检查是否有残留ffmpeg进程（`ps aux | grep ffmpeg`）
- **注意事项**: 需要在 `LibraryHandlers` 中添加一个并发安全的map来存储cancelFunc；服务重启后map丢失但ffmpeg进程也会被kill

---

## 问题 4：空房间不会被即时清理，可积累大量空房间

- **来源场景**: C-08(综合)
- **严重程度**: 🟡 高危（影响安全归入P0）
- **问题描述**: 用户离开房间后 `RemoveClient` 返回 `empty=true`，但主循环不删除空房间。空房间要等 `cleanupLoop` 每5分钟检查且 `LastActive > 30min` 才删除
- **影响范围**: 快速创建-离开循环可在30分钟内积累大量空房间，`SyncTick` 每秒遍历所有房间导致CPU飙升
- **根因分析**: `main.go` handleWebSocket 函数末尾（约第380行），断开连接时：
  ```go
  empty := currentRoom.RemoveClient(clientID)
  if !empty {
      // 只在非空时广播
  }
  // empty=true 时什么都不做！
  ```
  `ScheduleDelete` 已实现但被注释为 dead code（第310行 `// manager.CancelDelete(msg.RoomCode) // dead code`）
- **修复方案**:
  **文件**: `main.go`，在 handleWebSocket 函数末尾的断开处理中，空房间立即删除：

  ```go
  if currentRoom != nil {
      empty := currentRoom.RemoveClient(clientID)
      if empty {
          code := currentRoom.Code
          audio.CleanupRoom(filepath.Join(dataDir, code))
          manager.DeleteRoom(code)
      } else {
          users := currentRoom.GetClientList()
          for _, c := range currentRoom.GetClients() {
              if currentRoom.IsHost(c.ID) {
                  c.Send(WSResponse{Type: "hostTransfer", IsHost: true, ClientCount: currentRoom.ClientCount(), Users: users})
              } else {
                  c.Send(WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: users})
              }
          }
      }
  }
  ```

  同样在 `closeRoom` case 之后的 `create` 和 `join` 中离开旧房间时也需要检查：
  ```go
  if currentRoom != nil {
      empty := currentRoom.RemoveClient(clientID)
      if empty {
          audio.CleanupRoom(filepath.Join(dataDir, currentRoom.Code))
          manager.DeleteRoom(currentRoom.Code)
      } else {
          broadcast(currentRoom, WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: currentRoom.GetClientList()}, "")
      }
  }
  ```

- **验证方法**: 创建房间 → 立即断开 → 检查 `manager.GetRooms()` 长度是否为0
- **注意事项**: 需确保删除操作在 `RemoveClient` 返回后执行（锁已释放）；并发场景下可能有另一个用户正在join，但 `DeleteRoom` 持有写锁，join的 `GetRoom` 会在删除后返回nil

---

## 问题 5：房间Code碰撞会覆盖已有房间

- **来源场景**: C-02(综合)
- **严重程度**: 🟡 高危（影响安全归入P0）
- **问题描述**: `CreateRoom` 直接 `m.rooms[code] = room`，如果 `generateCode()` 生成了重复code，会覆盖已有房间，导致原房间用户丢失
- **影响范围**: 虽然概率极低（4字节hex，43亿种），但在高并发创建时风险上升
- **根因分析**: `internal/room/room.go` 第138行 `CreateRoom` 函数：
  ```go
  m.rooms[code] = room  // 不检查code是否已存在
  ```
- **修复方案**:
  **文件**: `internal/room/room.go`，在 `CreateRoom` 中添加碰撞检查：

  ```go
  func (m *Manager) CreateRoom(code string, ownerID int64) (*Room, error) {
      m.mu.Lock()
      defer m.mu.Unlock()

      if len(m.rooms) >= MaxRooms {
          return nil, ErrMaxRoomsReached
      }

      // Check for code collision
      if _, exists := m.rooms[code]; exists {
          return nil, errors.New("房间码冲突，请重试")
      }

      // ... rest unchanged
  ```

  **文件**: `main.go`，在 `create` case 中添加重试逻辑：

  ```go
  case "create":
      // ...permission check...
      var newRoom *room.Room
      var code string
      var createErr error
      for i := 0; i < 3; i++ {
          code = generateCode()
          newRoom, createErr = manager.CreateRoom(code, userID)
          if createErr == nil {
              break
          }
      }
      if createErr != nil {
          safeWrite(WSResponse{Type: "error", Error: createErr.Error()})
          continue
      }
      // ... rest unchanged
  ```

- **验证方法**: mock `generateCode` 返回固定值，连续创建两个房间，第二个应返回错误
- **注意事项**: 重试3次后仍碰撞的概率可忽略不计

---

## 问题 6：Host转移后新Host无操作权限（僵尸房间）

- **来源场景**: C-06(BC-ws-room)
- **严重程度**: 🟡 高危（影响安全归入P0）
- **问题描述**: 房主断线后host转移给普通用户，但 `play/pause/seek/kick/closeRoom` 都检查 `OwnerID != userID`，新host虽有 `IsHost=true` 但无法操作，房间变成无人可控的僵尸状态
- **影响范围**: 所有多人房间——房主断线后房间功能完全瘫痪，其他用户只能离开
- **根因分析**: `main.go` 中 play/pause/seek 等操作的双重检查：
  ```go
  if currentRoom == nil || !currentRoom.IsHost(clientID) {
      continue
  }
  if currentRoom.OwnerID != userID {  // 这行导致新host也无法操作
      continue
  }
  ```
- **修复方案**:
  房主断线时，将 `OwnerID` 转移给新host。

  **文件**: `main.go`，在 handleWebSocket 末尾的断开处理中，host转移时同步更新OwnerID：

  ```go
  if currentRoom != nil {
      wasOwner := currentRoom.OwnerID == userID
      empty := currentRoom.RemoveClient(clientID)
      if empty {
          // ... 空房间删除逻辑
      } else {
          users := currentRoom.GetClientList()
          for _, c := range currentRoom.GetClients() {
              if currentRoom.IsHost(c.ID) {
                  // Transfer ownership if original owner left
                  if wasOwner {
                      currentRoom.Mu.Lock()
                      currentRoom.OwnerID = c.UID
                      currentRoom.OwnerName = c.Username
                      currentRoom.Mu.Unlock()
                  }
                  c.Send(WSResponse{Type: "hostTransfer", IsHost: true, ClientCount: currentRoom.ClientCount(), Users: users})
              } else {
                  c.Send(WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: users})
              }
          }
      }
  }
  ```

- **验证方法**: 用户A创建房间 → 用户B加入 → A断线 → B尝试play/pause → 应成功
- **注意事项**: 这改变了产品行为——原来只有创建者能控制，现在断线后控制权转移。需确认这是期望的产品设计。如果不希望转移控制权，应在owner断线时自动关闭房间

---

## 问题 7：无音频时可发送Play命令使房间进入Playing状态

- **来源场景**: D-03(综合)
- **严重程度**: 🟡 高危
- **问题描述**: 房间未设置音频时发送play，`validatePosition` 中 `duration=0` 跳过时长检查，play成功执行，房间进入Playing状态但无实际音频
- **影响范围**: 房间状态异常，SyncTick会对无音频的Playing房间持续广播，浪费资源
- **根因分析**: `main.go` play case 中：
  ```go
  dur := 0.0
  if currentRoom.TrackAudio != nil { dur = currentRoom.TrackAudio.Duration }
  else if currentRoom.Audio != nil { dur = currentRoom.Audio.Duration }
  // dur=0 时 validatePosition 不检查时长，play 成功
  ```
- **修复方案**:
  **文件**: `main.go`，在 play case 中添加音频存在性检查：

  ```go
  case "play":
      if currentRoom == nil || !currentRoom.IsHost(clientID) {
          continue
      }
      if currentRoom.OwnerID != userID {
          continue
      }
      // Check audio exists
      currentRoom.Mu.RLock()
      hasAudio := currentRoom.TrackAudio != nil || currentRoom.Audio != nil
      currentRoom.Mu.RUnlock()
      if !hasAudio {
          safeWrite(WSResponse{Type: "error", Error: "请先选择音频"})
          continue
      }
      // ... rest unchanged
  ```

- **验证方法**: 创建房间 → 不添加音频 → 发送play → 应返回错误
- **注意事项**: 无

---

# P1 本迭代修复

## 问题 8：segment解码失败导致播放链完全断裂

- **来源场景**: 前端 A-03, A-04
- **严重程度**: 🔴 致命
- **问题描述**: `_scheduleAhead` 中 `loadSegment` 的 `decodeAudioData` 异常会向上冒泡，`break` 终止后续所有segment调度，播放完全中断
- **影响范围**: 任何单个segment加载失败（网络抖动、409响应被拦截器替换为空ArrayBuffer）都会导致整首歌播放中断
- **根因分析**: `web/static/js/player.js` `loadSegment` 方法中 `decodeAudioData` 失败时异常冒泡到 `_scheduleAhead` 的循环，触发 `break`
- **修复方案**:
  **文件**: `web/static/js/player.js`，在 `loadSegment` 方法中 catch `decodeAudioData` 异常，返回静音buffer：

  ```javascript
  async loadSegment(index) {
      // ... existing fetch logic ...
      try {
          const buffer = await this.ctx.decodeAudioData(arrayBuffer);
          // ... existing trimming logic ...
          return buffer;
      } catch (e) {
          console.warn(`[player] segment ${index} decode failed, using silence:`, e);
          // Return a silent buffer of segmentTime duration
          const sr = this.ctx.sampleRate;
          const len = Math.ceil(this.segmentTime * sr);
          return this.ctx.createBuffer(2, len, sr);
      }
  }
  ```

  同时修复 `index.html` 中 fetch 拦截器，对409返回有效静音数据而非空ArrayBuffer。

- **验证方法**: 拦截某个segment请求返回损坏数据 → 播放应跳过该segment继续
- **注意事项**: 静音buffer会导致该segment位置无声，但不会中断整体播放

---

## 问题 9：WS onmessage 被多层拦截器覆盖导致消息丢失

- **来源场景**: 前端 C-03, C-01(P2已知Bug)
- **严重程度**: 🔴 致命
- **问题描述**: index.html 中 statusReport 的 `setInterval(500ms)` 持续覆盖 `ws.onmessage`，与 app.js 的 `ws.onmessage` 和 WebSocket 构造函数拦截器形成三层拦截，可能导致消息丢失
- **影响范围**: 所有WS消息处理——roomClosed、forceResync等关键消息可能被吞掉
- **根因分析**: `web/static/index.html` 中多处覆盖 `ws.onmessage`，`origOnMsg` 引用链可能断裂
- **修复方案**:
  将所有WS消息拦截逻辑统一到 `app.js` 的 `handleMessage` 函数中，移除 index.html 中的 onmessage 覆盖和 setInterval patch。

  **文件**: `web/static/js/app.js`，在 `handleMessage` 函数中添加：
  ```javascript
  function handleMessage(msg) {
      // Handle roomClosed — clear active room
      if (msg.type === 'roomClosed') {
          localStorage.removeItem('lt_active_room');
      }
      // Handle statusReport/forceResync inline
      if (msg.type === 'forceResync' && window.audioPlayer) {
          // ... existing forceResync handling ...
      }
      // ... rest of existing switch ...
  }
  ```

  **文件**: `web/static/index.html`，移除 statusReport 的 `setInterval` onmessage patch 和 WebSocket 构造函数拦截器中的 roomClosed 处理。

- **验证方法**: 断开重连后服务端发送 roomClosed → `lt_active_room` 应被清除
- **注意事项**: 需要仔细迁移所有拦截器逻辑，避免遗漏

---

## 问题 10：[P5已知Bug] soft correction 虚假修正导致振荡

- **来源场景**: 前端 B-03
- **严重程度**: 🔴 致命（已知Bug）
- **问题描述**: `correctDrift` 在 `_pendingDriftCorrection` 尚未被消费前被多次调用，导致 `_nextSegTime` 被过度调整，产生反向漂移→振荡
- **影响范围**: 长时间播放时同步精度持续恶化，用户体验严重下降
- **根因分析**: `web/static/js/player.js` 中 `correctDrift` 方法，soft correction 基于绝对漂移而非上次修正后的增量漂移
- **修复方案**:
  **文件**: `web/static/js/player.js`，修改 `correctDrift` 方法：
  ```javascript
  correctDrift(drift) {
      // Only correct based on drift SINCE last correction, not absolute
      const correctedDrift = drift - this._lastCorrectedDrift;
      if (Math.abs(correctedDrift) < 0.005) return; // < 5ms, skip
      
      // Add cooldown: skip if last correction was < 500ms ago
      const now = this.ctx.currentTime;
      if (now - this._lastCorrectionTime < 0.5) return;
      this._lastCorrectionTime = now;
      this._lastCorrectedDrift = drift;
      
      // ... rest of correction logic using correctedDrift ...
  }
  ```

- **验证方法**: 制造5-50ms稳定漂移 → 观察 `_nextSegTime` 不应振荡
- **注意事项**: 需要初始化 `_lastCorrectedDrift = 0` 和 `_lastCorrectionTime = 0`

---

## 问题 11：drift correction 三层阈值边界振荡（无滞后区间）

- **来源场景**: 前端 B-04
- **严重程度**: 🟡 高危
- **问题描述**: Tier 1 上界50ms与Tier 2下界50ms完全重合，漂移在边界附近波动时交替触发两种修正策略
- **影响范围**: 同步精度在边界附近持续抖动
- **根因分析**: `web/static/js/sync.js` 或 `player.js` 中 drift correction 阈值定义
- **修复方案**:
  引入5-10ms滞后区间：
  ```javascript
  // Tier 1 (soft): 5ms < drift <= 55ms (上界增加5ms滞后)
  // Tier 2 (rate): 50ms < drift <= 200ms
  // 50-55ms 区间：维持当前tier，不切换
  ```

- **验证方法**: 制造45-55ms波动漂移 → 修正策略不应频繁切换
- **注意事项**: 需要记录当前所在tier，在滞后区间内保持不变

---

## 问题 12：_driftOffset 累积超过±500ms时硬重置导致周期性中断

- **来源场景**: 前端 B-06
- **严重程度**: 🔴 致命
- **问题描述**: 长时间运行中soft correction持续单方向累积，触发硬重置（stop+restart），且重置后漂移重新累积——周期性音频中断
- **影响范围**: 长时间播放（>10分钟）的所有用户
- **根因分析**: `web/static/js/player.js` 中 `_driftOffset` 累积到500ms时触发硬重置
- **修复方案**:
  在 `_driftOffset` 达到200ms时切换到playbackRate修正模式，而非等到500ms硬重置：
  ```javascript
  if (Math.abs(this._driftOffset) > 0.2) {
      // Switch to Tier 2 (playbackRate) to gradually reduce accumulated offset
      // instead of waiting for 500ms hard reset
      this._applyRateCorrection(-this._driftOffset);
      this._driftOffset = 0;
  }
  ```

- **验证方法**: 模拟持续1ms/s的单方向漂移 → 200秒后不应出现硬重置中断
- **注意事项**: 需确保playbackRate修正能有效消化累积的offset

---

## 问题 13：幽灵重连弹窗风暴（lt_active_room未清理）

- **来源场景**: 前端 D-08
- **严重程度**: 🟡 高危
- **问题描述**: 关闭标签页后 `lt_active_room` 未清除，重新打开时自动尝试加入已不存在的房间，`tryJoin` 最多尝试20次，每次弹出错误alert
- **影响范围**: 所有非正常退出（关闭标签页、浏览器崩溃）的用户
- **根因分析**: `web/static/js/app.js` 中 `handleMessage` 的 error 处理只 `alert(msg.error)`，不清理状态；自动重连尝试20次
- **修复方案**:
  **文件**: `web/static/js/app.js`，在 error 处理中检测房间不存在并清理：

  ```javascript
  case 'error':
      if (msg.error && (msg.error.includes('not found') || msg.error.includes('Room not found'))) {
          localStorage.removeItem('lt_active_room');
          showScreen('home');
          // Don't alert for auto-rejoin failures
          if (!isAutoRejoin) alert(msg.error);
      } else {
          alert(msg.error);
      }
      break;
  ```

  同时将自动重连次数从20降为1：
  ```javascript
  // Auto-rejoin: only try once, not 20 times
  let tryJoinAttempts = 0;
  const maxAutoJoinAttempts = 1;
  ```

- **验证方法**: 进入房间 → 关闭标签页 → 等房间销毁 → 重新打开 → 不应弹出错误
- **注意事项**: 需要区分自动重连和手动加入的错误处理

---

## 问题 14：hostTransfer后UI权限刷新不完整

- **来源场景**: 前端 D-03
- **严重程度**: 🟡 高危
- **问题描述**: 收到 `hostTransfer` 消息后，`isHost = true` 但 prev/next 按钮的 disabled 状态未更新，播放列表项的点击事件不响应
- **影响范围**: 所有host转移场景——新host看到按钮但无法点击
- **根因分析**: `web/static/js/app.js` 中 `hostTransfer` 处理未调用 `updatePrevNextButtons()` 和 `renderPlaylist()`
- **修复方案**:
  **文件**: `web/static/js/app.js`，在 hostTransfer 处理中添加：

  ```javascript
  case 'hostTransfer':
      isHost = msg.isHost;
      // ... existing logic ...
      updatePrevNextButtons();
      if (typeof renderPlaylist === 'function') renderPlaylist();
      break;
  ```

- **验证方法**: A创建房间添加歌曲 → B加入 → A断线 → B的prev/next按钮应变为可用
- **注意事项**: 无

---

## 问题 15：coverUrl未转义导致潜在XSS属性注入

- **来源场景**: 前端 F-01, D-06
- **严重程度**: 🟡 高危
- **问题描述**: `renderPlaylist` 中 `coverUrl` 直接拼接到 `<img src="...">` 中，若变量包含 `"` 可闭合属性注入事件处理器
- **影响范围**: 播放列表渲染——虽然服务端生成的UUID通常安全，但属于纵深防御缺失
- **根因分析**: `web/static/js/app.js` 中 renderPlaylist 使用字符串拼接构建HTML
- **修复方案**:
  **文件**: `web/static/js/app.js`，对URL中所有变量使用 `encodeURIComponent`：

  ```javascript
  const coverUrl = `/api/library/cover/${encodeURIComponent(item.owner_id)}/${encodeURIComponent(item.audio_uuid)}/cover.jpg`;
  ```

  或更好的方案——使用DOM API构建元素而非innerHTML：
  ```javascript
  const img = document.createElement('img');
  img.src = coverUrl;
  img.alt = '';
  ```

- **验证方法**: 构造包含特殊字符的audio_uuid → 检查DOM中img标签是否安全
- **注意事项**: 需要对所有innerHTML拼接中的URL变量统一处理

---

## 问题 16：移动端后台标签页timer节流导致播放中断

- **来源场景**: 前端 G-02
- **严重程度**: 🔴 致命
- **问题描述**: 移动浏览器将后台标签页的 `setInterval` 节流到1分钟/次，lookahead调度器停止喂segment，导致静音
- **影响范围**: 所有移动端用户切换到其他App时
- **根因分析**: `web/static/js/player.js` 中 `_lookaheadTimer`（200ms interval）被浏览器节流
- **修复方案**:
  **文件**: `web/static/js/player.js`，在 `visibilitychange` 恢复时强制执行 `playAtPosition` 而非仅 `_scheduleAhead`：

  ```javascript
  document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.isPlaying) {
          // Force full resync after returning from background
          const currentPos = this.getCurrentTime();
          setTimeout(() => {
              if (this.isPlaying) this.playAtPosition(currentPos);
          }, 500); // Wait for clockSync burst to complete
      }
  });
  ```

- **验证方法**: 移动端播放 → 切到其他App 30秒 → 切回 → 应在1秒内恢复播放
- **注意事项**: `playAtPosition` 会stop再restart，可能有短暂静音

---

## 问题 17：JSON.parse异常未捕获

- **来源场景**: 前端 C-04
- **严重程度**: 🟡 高危
- **问题描述**: `ws.onmessage = e => handleMessage(JSON.parse(e.data))` 无try-catch，非JSON消息会抛出未捕获异常
- **影响范围**: 虽然后续消息不受影响（每次调用独立），但会产生控制台错误
- **根因分析**: `web/static/js/app.js` 中 onmessage 赋值
- **修复方案**:
  ```javascript
  ws.onmessage = e => {
      try { handleMessage(JSON.parse(e.data)); }
      catch (err) { console.warn('[ws] invalid message:', err); }
  };
  ```

- **验证方法**: 通过WS代理注入非JSON文本 → 不应有未捕获异常
- **注意事项**: 无

---

## 问题 18：User Settings存储无大小限制

- **来源场景**: F-06(综合)
- **严重程度**: 🟢 中危
- **问题描述**: `SaveUserSettings` 直接存储任意JSON字符串，无大小验证，每个用户可存储接近1MB的settings
- **影响范围**: 数据库膨胀——100个用户各存1MB = 100MB
- **根因分析**: `internal/auth/handlers.go` `UserSettings` PUT handler 直接存储 `json.RawMessage`
- **修复方案**:
  **文件**: `internal/auth/handlers.go`，在 UserSettings PUT 中添加大小检查：

  ```go
  case http.MethodPut:
      var raw json.RawMessage
      if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
          jsonError(w, "invalid json", 400)
          return
      }
      if len(raw) > 10240 { // 10KB limit
          jsonError(w, "settings too large (max 10KB)", 400)
          return
      }
      // ... rest unchanged
  ```

- **验证方法**: 发送>10KB的settings JSON → 应返回400
- **注意事项**: 需确认现有用户settings不超过10KB

---

# P2 下迭代修复

## 问题 19：修改用户名后WebSocket中仍显示旧名

- **来源场景**: A-12(综合)
- **严重程度**: ⚪ 低危
- **问题描述**: `ChangeUsername` 不bump `session_version`，旧token仍有效但包含旧username，WebSocket中 `username` 来自token会显示旧名
- **影响范围**: 修改用户名后其他设备上的房间内显示旧名
- **根因分析**: `internal/auth/handlers.go` `ChangeUsername` 函数未调用 `BumpSessionVersion`
- **修复方案**:
  **文件**: `internal/auth/handlers.go`，在 `ChangeUsername` 中 `UpdateUsername` 成功后添加：
  ```go
  h.DB.BumpSessionVersion(user.UserID)
  GlobalRoleCache.Invalidate(user.UserID)
  ```
- **验证方法**: 设备A登录 → 设备B改名 → 设备A刷新后应需重新登录
- **注意事项**: 会强制所有设备重新登录

---

## 问题 20：用户名枚举——注册与登录差异响应

- **来源场景**: A-10(综合)
- **严重程度**: 🟢 中危
- **问题描述**: 注册返回"用户名可能已存在"，登录返回"用户名或密码错误"，注册接口可确认用户名存在
- **影响范围**: 攻击者可枚举有效用户名
- **根因分析**: `internal/auth/handlers.go` Register 函数返回 `"注册失败，用户名可能已存在"`
- **修复方案**:
  将注册失败消息改为更模糊的表述：`"注册失败，请稍后重试"`
- **验证方法**: 注册已存在用户名 → 错误消息不应暗示用户名已存在
- **注意事项**: 可能影响用户体验（不知道为什么注册失败）

---

## 问题 21：JWT密钥短于32字节时静默padding

- **来源场景**: A-03(认证专项)
- **严重程度**: 🟡 高危
- **问题描述**: `padSecretIfNeeded()` 用随机字节补齐短密钥，每次重启padding不同导致所有token失效
- **影响范围**: 使用短JWT_SECRET的部署——重启后所有用户被登出
- **根因分析**: `internal/auth/auth.go` `padSecretIfNeeded` 函数（约第115行）
- **修复方案**:
  **文件**: `internal/auth/auth.go`，将 `padSecretIfNeeded` 改为拒绝启动：
  ```go
  func padSecretIfNeeded() {
      if len(jwtSecret) < 32 {
          log.Fatalf("[JWT] FATAL: secret is %d bytes, minimum required is 32. Set a longer JWT_SECRET.", len(jwtSecret))
      }
  }
  ```
- **验证方法**: 设置 `JWT_SECRET=ab` → 服务应拒绝启动
- **注意事项**: 仅影响通过环境变量设置短密钥的场景；自动生成的密钥已是32字节

---

## 问题 22：visibilitychange后burst re-sync时序问题

- **来源场景**: 前端 B-10
- **严重程度**: 🟡 高危
- **问题描述**: 页面从后台恢复时 `_scheduleAhead` 被立即调用，但clockSync可能尚未完成burst重新同步，导致基于旧offset的错误调度
- **影响范围**: 从后台恢复后短暂的同步偏差
- **根因分析**: `web/static/js/sync.js` 和 `player.js` 中 visibilitychange 处理时序
- **修复方案**:
  在burst完成后（延迟500ms）再触发 `_scheduleAhead`，而非立即调用。（已在问题16中一并处理）
- **验证方法**: 后台30秒 → 恢复 → 检查前500ms内不应有基于旧offset的调度
- **注意事项**: 与问题16的修复方案合并

---

## 问题 23：screen切换时残留状态（modal/panel未清理）

- **来源场景**: 前端 D-01
- **严重程度**: 🟡 高危
- **问题描述**: 从room切回home时，playlistModal、debugPanel、libraryModal未被隐藏
- **影响范围**: UI残留——离开房间后仍看到房间相关面板
- **根因分析**: `web/static/js/app.js` `leaveBtn.onclick` 只隐藏了 `audiencePanel`
- **修复方案**:
  在 `showScreen` 函数中统一清理所有overlay/modal：
  ```javascript
  function showScreen(name) {
      // Hide all modals/panels when leaving room
      ['audiencePanel','playlistModal','debugPanel','libraryModal'].forEach(id => {
          const el = $(id);
          if (el) el.classList.add('hidden');
      });
      // ... existing screen switching logic
  }
  ```
- **验证方法**: 展开所有面板 → 离开房间 → 所有面板应隐藏
- **注意事项**: 无

---

## 问题 24：localStorage操作无try-catch

- **来源场景**: 前端 E-07
- **严重程度**: 🟢 中危
- **问题描述**: 所有 `localStorage.setItem` 调用均无try-catch，配额溢出会抛出未捕获异常
- **影响范围**: localStorage接近5MB配额时核心功能可能中断
- **修复方案**:
  封装localStorage操作：
  ```javascript
  function safeSetItem(key, value) {
      try { localStorage.setItem(key, value); }
      catch (e) { console.warn('localStorage full:', e); }
  }
  ```
- **验证方法**: 填满localStorage → 触发saveLayout → 不应有未捕获异常
- **注意事项**: 需全局替换所有 `localStorage.setItem` 调用

---

## 问题 25：reconnect指数退避上限过高

- **来源场景**: 前端 C-02
- **严重程度**: 🟡 高危
- **问题描述**: `reconnectDelay` 从3000ms指数增长到60000ms，网络恢复后最长等待48秒
- **影响范围**: 网络短暂中断后用户等待时间过长
- **修复方案**:
  监听 `navigator.onLine` 事件，网络恢复时立即尝试重连：
  ```javascript
  window.addEventListener('online', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
          reconnectDelay = 3000; // reset backoff
          connect();
      }
  });
  ```
- **验证方法**: 断网30秒 → 恢复网络 → 应在3秒内重连
- **注意事项**: 无

---

# 修复工作量估算表

| # | 问题 | 优先级 | 修改文件数 | 预估行数 | 预估耗时 |
|---|------|--------|-----------|---------|---------|
| 1 | Owner默认密码未强制修改 | P0 | 1 | ~20 | 30min |
| 2 | 删除用户音频清理路径不匹配 | P0 | 1 | ~10 | 15min |
| 3 | ffmpeg转码goroutine无取消机制 | P0 | 2 | ~50 | 1.5h |
| 4 | 空房间不即时清理 | P0 | 1 | ~15 | 30min |
| 5 | 房间Code碰撞覆盖 | P0 | 2 | ~15 | 20min |
| 6 | Host转移后无操作权限 | P0 | 1 | ~10 | 20min |
| 7 | 无音频时可Play | P0 | 1 | ~8 | 10min |
| 8 | segment解码失败链断裂 | P1 | 2 | ~15 | 30min |
| 9 | WS onmessage多层覆盖 | P1 | 2 | ~60 | 2h |
| 10 | soft correction振荡(P5) | P1 | 1 | ~20 | 1h |
| 11 | drift阈值边界振荡 | P1 | 1 | ~15 | 30min |
| 12 | driftOffset累积硬重置 | P1 | 1 | ~10 | 30min |
| 13 | 幽灵重连弹窗风暴 | P1 | 1 | ~15 | 20min |
| 14 | hostTransfer UI刷新不完整 | P1 | 1 | ~5 | 10min |
| 15 | coverUrl XSS属性注入 | P1 | 1 | ~10 | 20min |
| 16 | 移动端后台timer节流 | P1 | 1 | ~15 | 30min |
| 17 | JSON.parse异常未捕获 | P1 | 1 | ~5 | 5min |
| 18 | Settings无大小限制 | P1 | 1 | ~5 | 10min |
| 19 | 改名后WS显示旧名 | P2 | 1 | ~3 | 5min |
| 20 | 用户名枚举 | P2 | 1 | ~2 | 5min |
| 21 | JWT短密钥静默padding | P2 | 1 | ~5 | 10min |
| 22 | visibility burst时序 | P2 | 1 | ~10 | 20min |
| 23 | screen切换残留状态 | P2 | 1 | ~10 | 15min |
| 24 | localStorage无try-catch | P2 | 1 | ~15 | 20min |
| 25 | reconnect退避过高 | P2 | 1 | ~8 | 15min |
| **合计** | | | **~30文件次** | **~346行** | **~10h** |

### 分组耗时

| 优先级 | 问题数 | 预估总耗时 | 建议完成时间 |
|--------|--------|-----------|-------------|
| P0 立即修复 | 7 | ~3h | 当天 |
| P1 本迭代修复 | 11 | ~5.5h | 本周内 |
| P2 下迭代修复 | 7 | ~1.5h | 下个迭代 |

