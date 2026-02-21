# P0 修复代码审查报告

> 审查日期：2026-02-21
> 审查人：Go Code Review Engineer (AI)

---

## 问题 1：Owner默认密码强制修改拦截

**✅ 修复正确**

- `isOwnerWithDefaultPassword()` 在 `auth.go` 中实现，逻辑清晰：查DB获取用户→检查role→比对默认密码
- `AuthMiddleware` 和 `RequireAuth` 中均添加了拦截，放行 `/api/auth/password`
- `authDB == nil` 时安全降级返回 `false`

**审查发现：**
- 每次owner请求都会触发一次DB查询（`GetUserByID` + bcrypt比对），性能开销不小。但仅owner触发，且修改密码后不再命中，可接受。
- 拦截位置在 `tryAutoRenew` 之后，意味着即使被拦截，token仍可能被续期。不影响安全性（续期后的token下次请求仍会被拦截），但略显多余。

---

## 问题 2：删除用户音频文件清理路径修正

**✅ 修复正确**

- `AdminDeleteUser` 中路径改为 `filepath.Join(dataDir, "library", strconv.FormatInt(target.ID, 10), fn)`，与上传路径 `filepath.Join(h.DataDir, "library", userID, audioID)` 一致
- 额外清理空的用户目录 `os.Remove(userLibDir)`（仅空目录时成功）

**审查发现：**
- `DATA_DIR` 环境变量默认值 `"./data"` 与 `LibraryHandlers.DataDir` 硬编码的 `"./data"` 一致。但两处独立定义，未来可能不同步。建议统一为常量或配置。
- `deletedFiles` 返回的是 `fn`（即 `audioFile.Filename`，也就是UUID），拼接路径正确。

---

## 问题 3：ffmpeg转码goroutine取消机制

**✅ 修复正确**

- `ProcessAudioMultiQuality` 创建 `bgCtx, bgCancel`，后台goroutine在每次循环前检查 `bgCtx.Err()`
- `segmentOneQuality` 接收 `context.Context`，使用 `exec.CommandContext(ctx, "ffmpeg", ...)`，取消时ffmpeg进程会被kill
- `LibraryHandlers` 新增 `cancelMu` + `transcodeCancel map[int64]context.CancelFunc`
- `DeleteFile` 中先调用 `cancel()` 再删除文件

**审查发现：**
- `ProcessAudioMultiQuality` 签名返回 `context.CancelFunc`，调用方（Upload）正确保存到map中。
- 同步阶段（medium tier）也使用 `bgCtx`，如果同步阶段被取消会返回错误，Upload会清理并返回500，逻辑正确。
- goroutine中 `defer bgCancel()` 确保完成后释放资源。无remaining时直接 `bgCancel()`，无泄漏。
- map在服务重启后丢失，但ffmpeg子进程也会随父进程终止，可接受。

---

## 问题 4：空房间即时清理

**✅ 修复正确**

- WebSocket断开时：`empty := currentRoom.RemoveClient(clientID)` → `if empty` → 清理音频 + `manager.DeleteRoom`
- `create` case 中离开旧房间：同样检查 `empty` 并清理
- `join` case 中离开旧房间：同样检查 `empty` 并清理

**审查发现：**
- `RemoveClient` 内部持有写锁，返回后锁已释放，`DeleteRoom` 再获取写锁，无死锁风险。
- 并发场景：用户A离开导致empty=true，同时用户B正在join同一房间。`DeleteRoom` 持有 `Manager.mu` 写锁，B的 `GetRoom` 在删除后返回nil，B收到"Room not found"错误。这是正确的竞态处理。
- `cleanupLoop` 仍保留作为兜底，30分钟清理不活跃房间，双保险。

---

## 问题 5：房间Code碰撞检查+重试

**✅ 修复正确**

- `CreateRoom` 中添加 `if _, exists := m.rooms[code]; exists` 检查，碰撞时返回错误
- `main.go` create case 中重试3次，每次生成新code

**审查发现：**
- 碰撞检查在 `m.mu.Lock()` 保护下，线程安全。
- 重试3次后仍碰撞的概率极低（4字节hex = 2^32种可能），即使100个房间碰撞率也仅约 7×10^-22。
- 重试失败时返回最后一次的 `createErr`，可能是碰撞错误也可能是其他错误（如达到上限），错误信息准确。

---

## 问题 6：Host转移后OwnerID同步

**⚠️ 有小问题（不影响正确性）**

- 断开处理中 `wasOwner` 在 `RemoveClient` 之前记录，正确。
- `RemoveClient` 内部已将host转移给下一个client。
- 外部循环找到新host后，`Mu.Lock()` 更新 `OwnerID` 和 `OwnerName`。

**审查发现：**
- **竞态窗口**：`RemoveClient` 返回后到 `Mu.Lock()` 更新OwnerID之间，存在短暂窗口。此时新host的 `IsHost=true` 但 `OwnerID` 仍是旧值。如果新host在此窗口内发送play/pause，会被 `OwnerID != userID` 拦截。但这个窗口极短（微秒级），实际触发概率极低。
- **遍历效率**：`GetClients()` 返回所有client的拷贝，然后遍历找host。可以直接读 `currentRoom.Host`，但当前实现也能工作。
- **产品语义变化**：原来只有创建者能控制，现在断线后控制权转移。REMEDIATION-PLAN已注明这是有意设计。

**建议**：将OwnerID更新移入 `RemoveClient` 方法内部（在同一把锁内完成），消除竞态窗口。

---

## 问题 7：无音频时Play拦截

**✅ 修复正确**

- `play`、`pause`、`seek` case 中均添加了音频存在性检查：
  ```go
  hasAudio := currentRoom.TrackAudio != nil || currentRoom.Audio != nil
  if !hasAudio {
      safeWrite(WSResponse{Type: "error", Error: "请先选择音频"})
      continue
  }
  ```
- 检查在 `RLock` 保护下读取，正确。

**审查发现：**
- 同时检查 `TrackAudio` 和 `Audio` 两个字段，覆盖了播放列表模式和直接上传模式。
- pause 和 seek 也添加了检查，防止无音频时的状态异常。
- `nextTrack` 中从DB加载音频信息，如果加载失败直接 `continue`，不会设置空音频。

---

## 总体评分：8.5 / 10

**总结**：7个P0修复全部按照REMEDIATION-PLAN实施，逻辑正确，错误处理完善。锁的使用基本正确，仅问题6存在一个极短的竞态窗口（OwnerID更新未在RemoveClient锁内完成），实际影响极低但建议后续优化。代码风格一致，边界条件覆盖充分。整体修复质量高，可以上线。
