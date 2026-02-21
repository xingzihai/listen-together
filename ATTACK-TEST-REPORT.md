# ListenTogether v0.7.0 攻防测试报告

> 测试日期：2026-02-21
> 测试范围：Go服务端全模块 + JS前端全模块
> 测试场景总数：见下方各章节

---

## 目录

- [第一部分：后端攻防测试（综合版 55场景）](#第一部分后端攻防测试)
- [第二部分：认证与授权专项（14场景）](#第二部分认证与授权专项)
- [第三部分：WebSocket与房间管理专项（20场景）](#第三部分websocket与房间管理专项)
- [第四部分：播放控制+数据库+API专项（28场景）](#第四部分播放控制数据库api专项)
- [第五部分：前端攻防测试（55+场景）](#第五部分前端攻防测试)

---

# 第一部分：后端攻防测试

# ListenTogether 后端攻防测试场景设计

> 基于源码审计的安全测试方案 | 审计日期: 2026-02-21
> 审计范围: main.go, internal/auth, internal/room, internal/db, internal/library, internal/audio, internal/sync

---

## ⚠️ 重大发现：测试模式限制全部放开

代码中存在大量 `TODO: restore to X after testing` 注释，以下限制在当前代码中被设为 **99999**，等同于无限制：

| 位置 | 常量/变量 | 当前值 | 应恢复值 | 风险 |
|------|-----------|--------|----------|------|
| `main.go` | `maxWSConnsPerUser` | 9999 | 5 | 单用户可耗尽服务器WebSocket资源 |
| `main.go` | `msgRateLimit` | 9999 | 10 | 消息洪水攻击无防护 |
| `main.go` | `pingRateLimit` | 9999 | 5 | ping洪水无防护 |
| `main.go` | `totalRateLimit` | 9999 | 12 | 总消息速率无限制 |
| `room.go` | `MaxRooms` | 99999 | 100 | 可创建海量房间耗尽内存 |
| `room.go` | `MaxRoomsPerUser` | 99999 | 3 | 单用户可创建无限房间 |
| `room.go` | `MaxClientsPerRoom` | 99999 | 50 | 单房间可加入无限用户 |
| `handlers.go` | 注册限流 | 9999/h | 5/h | 批量注册无防护 |
| `handlers.go` | 登录IP限流 | 9999/min | 5/min | 暴力破解无防护 |
| `handlers.go` | 登录用户名限流 | 9999/min | 5/min | 单账户暴力破解无防护 |
| `main.go` | join限流 | 30/min | 5/min | 房间枚举攻击门槛极低 |

---

## A. 认证与授权攻防 (12个场景)

### A-01 默认管理员密码未修改
- **分类**: 认证 | **严重程度**: 🔴 严重
- **攻击向量**: 使用 `admin` / `admin123` 登录获取owner权限
- **测试步骤**:
  1. POST `/api/auth/login` body: `{"username":"admin","password":"admin123"}`
  2. 检查返回的 `needChangePassword` 字段
  3. 若登录成功，尝试访问 `/api/admin/users` 验证owner权限
- **预期结果**: 登录成功后应强制修改密码
- **实际风险评估**: `db.go:init()` 中硬编码 `admin123` 作为默认密码，仅在前端提示修改（`needChangePassword`），后端不强制。攻击者可直接用API操作绕过前端提示
- **应对策略**: 后端强制首次登录修改密码，或使用环境变量 `OWNER_PASSWORD` 设置强密码

### A-02 暴力破解登录（限流已禁用）
- **分类**: 认证 | **严重程度**: 🔴 严重
- **攻击向量**: 限流设为9999，可无限尝试密码
- **测试步骤**:
  1. 编写脚本对 `/api/auth/login` 发送10000次不同密码请求
  2. 验证无任何429响应
  3. 使用字典攻击尝试常见密码
- **预期结果**: 应在5次失败后返回429
- **实际风险评估**: `handlers.go` 中 `loginLimiter.allow(ip, 9999, time.Minute)` 和 `usernameLoginLimiter.allow(username, 9999, time.Minute)` 使限流形同虚设
- **应对策略**: 恢复限流值为5/分钟，增加账户锁定机制

### A-03 批量注册攻击（限流已禁用）
- **分类**: 认证 | **严重程度**: 🟡 高危
- **攻击向量**: 注册限流设为9999/小时，可批量创建账户
- **测试步骤**:
  1. 循环调用 `/api/auth/register` 创建1000个用户
  2. 验证全部成功，无429
  3. 检查数据库膨胀情况
- **预期结果**: 应在5次/小时后限流
- **实际风险评估**: `regLimiter.allow(ip, 9999, time.Hour)` 无实际限制，可填充数据库
- **应对策略**: 恢复为5/小时，增加验证码

### A-04 JWT Token 过期后自动续期的权限提升
- **分类**: 授权 | **严重程度**: 🟡 高危
- **攻击向量**: 利用token自动续期窗口，在角色被降级后继续使用旧token
- **测试步骤**:
  1. 以admin身份登录获取token
  2. 管理员将该用户降级为user
  3. 在token过期前2小时内发起请求，触发 `tryAutoRenew`
  4. 检查续期后的token是否包含新角色
- **预期结果**: 续期应使用最新角色
- **实际风险评估**: `tryAutoRenew` 会从DB获取最新角色，且 `GlobalRoleCache` TTL仅5秒。但存在竞态窗口：降级后5秒内缓存未失效时，`validateClaimsAgainstDB` 可能放行旧角色token
- **应对策略**: 降级时主动调用 `GlobalRoleCache.Invalidate()`（代码已实现），确认缓存失效时序

### A-05 Cookie安全属性缺失（非HTTPS环境）
- **分类**: 认证 | **严重程度**: 🟡 高危
- **攻击向量**: HTTP环境下cookie无Secure标志，可被中间人截获
- **测试步骤**:
  1. 在HTTP环境下登录
  2. 检查Set-Cookie头的Secure属性
  3. 使用网络抓包工具验证cookie是否明文传输
- **预期结果**: 生产环境应强制HTTPS
- **实际风险评估**: `isSecureRequest` 仅在 `SECURE_COOKIE=true` 或 `X-Forwarded-Proto: https` 时设置Secure。默认HTTP部署下cookie可被嗅探
- **应对策略**: 生产环境设置 `SECURE_COOKIE=true`，强制HTTPS

### A-06 X-Forwarded-For IP欺骗绕过限流
- **分类**: 认证 | **严重程度**: 🟡 高危
- **攻击向量**: 当配置了 `TRUSTED_PROXIES` 时，伪造XFF头绕过IP限流
- **测试步骤**:
  1. 确认 `TRUSTED_PROXIES` 环境变量配置
  2. 从受信代理IP发送请求，伪造 `X-Forwarded-For: 1.2.3.4`
  3. 每次更换XFF中的IP，绕过同IP限流
- **预期结果**: 应验证XFF链的完整性
- **实际风险评估**: `GetClientIP` 仅取XFF第一个IP，攻击者可通过受信代理伪造任意客户端IP。但需要先知道受信代理IP
- **应对策略**: 使用CIDR匹配而非精确IP匹配，验证XFF链长度

### A-07 密码长度边界：bcrypt 72字节截断
- **分类**: 认证 | **严重程度**: 🟢 中危
- **攻击向量**: bcrypt截断超过72字节的密码，两个仅在72字节后不同的密码会匹配
- **测试步骤**:
  1. 注册密码为72个'a'
  2. 尝试用72个'a'+'xyz'登录
  3. 验证是否登录成功
- **预期结果**: 应拒绝登录
- **实际风险评估**: 代码已在 `HashPassword` 和 `CheckPassword` 中检查 `maxPasswordBytes=72`，注册和修改密码也有检查。**已正确防护**
- **应对策略**: 当前实现正确，保持

### A-08 并发修改密码导致session_version竞态
- **分类**: 认证 | **严重程度**: 🟢 中危
- **攻击向量**: 同时发起多个修改密码请求
- **测试步骤**:
  1. 同一用户并发发送10个 `/api/auth/password` PUT请求
  2. 检查 `password_version` 是否正确递增
  3. 验证旧token是否全部失效
- **预期结果**: 所有旧token应失效，仅最后一次修改的token有效
- **实际风险评估**: `UpdatePassword` 使用 `password_version=password_version+1` 原子操作，SQLite WAL模式串行化写入。但并发请求可能导致多个新token生成，只有最后一个有效
- **应对策略**: 可接受，SQLite串行化保证了一致性

### A-09 Logout后Token仍可使用的时间窗口
- **分类**: 认证 | **严重程度**: 🟢 中危
- **攻击向量**: Logout调用 `BumpSessionVersion`，但缓存有5秒TTL
- **测试步骤**:
  1. 登录获取token
  2. 调用 `/api/auth/logout`
  3. 立即（<5秒内）使用旧token访问API
  4. 5秒后再次尝试
- **预期结果**: Logout后token应立即失效
- **实际风险评估**: `GlobalRoleCache` 有5秒TTL，Logout时调用了 `Invalidate`，所以下次请求会查DB。**实际已正确处理**
- **应对策略**: 当前实现正确

### A-10 用户名枚举：注册与登录的差异响应
- **分类**: 认证 | **严重程度**: 🟢 中危
- **攻击向量**: 通过注册和登录的不同错误消息判断用户名是否存在
- **测试步骤**:
  1. 尝试注册已存在的用户名，观察错误消息
  2. 尝试登录不存在的用户名，观察错误消息
  3. 对比两种响应
- **预期结果**: 错误消息应统一
- **实际风险评估**: 注册返回"用户名可能已存在"，登录返回"用户名或密码错误"。注册接口可确认用户名存在
- **应对策略**: 注册失败统一返回模糊错误

### A-11 Owner角色不可被修改的绕过尝试
- **分类**: 授权 | **严重程度**: 🟢 中危
- **攻击向量**: 尝试通过API修改owner角色
- **测试步骤**:
  1. 以owner身份调用 `/api/admin/users/{owner_uid}/role` 修改自己角色
  2. 尝试将另一个owner降级
- **预期结果**: 应拒绝
- **实际风险评估**: `AdminUpdateRole` 检查 `target.Role == "owner"` 并拒绝。但 `AdminDeleteUser` 也检查了。**已正确防护**
- **应对策略**: 当前实现正确

### A-12 修改用户名后旧Token中的username不一致
- **分类**: 认证 | **严重程度**: ⚪ 低危
- **攻击向量**: 修改用户名后，其他设备上的旧token仍包含旧用户名
- **测试步骤**:
  1. 在设备A登录
  2. 在设备B修改用户名
  3. 设备A继续使用旧token，检查 `/api/auth/me` 返回的用户名
- **预期结果**: 应返回新用户名
- **实际风险评估**: `ChangeUsername` 不bump `session_version`，旧token仍有效但包含旧username。`/api/auth/me` 从DB读取，返回正确。但WebSocket中 `username` 来自token，会显示旧名
- **应对策略**: 修改用户名时bump session_version强制重新登录

---

## B. WebSocket协议攻防 (12个场景)

### B-01 单用户WebSocket连接洪水（限制已禁用）
- **分类**: WebSocket | **严重程度**: 🔴 严重
- **攻击向量**: `maxWSConnsPerUser=9999`，单用户可建立近万连接
- **测试步骤**:
  1. 以合法token建立1000个WebSocket连接到 `/ws`
  2. 监控服务器内存和文件描述符
  3. 持续增加连接直到服务崩溃
- **预期结果**: 应在5个连接后拒绝
- **实际风险评估**: `wsTracker.acquire` 限制为9999，每个连接消耗goroutine（ping ticker + 读循环）+ WebSocket缓冲区。1000连接约消耗2000+ goroutine和数十MB内存
- **应对策略**: 恢复 `maxWSConnsPerUser` 为5

### B-02 消息洪水攻击（速率限制已禁用）
- **分类**: WebSocket | **严重程度**: 🔴 严重
- **攻击向量**: `msgRateLimit=9999`，可每秒发送近万消息
- **测试步骤**:
  1. 建立WebSocket连接并加入房间
  2. 每秒发送5000条 `ping` 消息
  3. 观察服务器CPU和响应延迟
- **预期结果**: 应在10条/秒后断开连接
- **实际风险评估**: `checkRate` 函数存在但限制值为9999。每条消息触发JSON解析、switch分发、响应写入。高频消息可导致CPU饱和
- **应对策略**: 恢复 `msgRateLimit=10`, `pingRateLimit=5`, `totalRateLimit=12`

### B-03 超大WebSocket消息
- **分类**: WebSocket | **严重程度**: 🟡 高危
- **攻击向量**: 发送接近64KB的JSON消息
- **测试步骤**:
  1. 构造一个包含超长 `roomCode` 字段（60KB）的JSON消息
  2. 发送到WebSocket
  3. 发送超过64KB的消息验证是否被断开
- **预期结果**: 超过64KB应断开，但64KB以内的畸形消息应被处理
- **实际风险评估**: `conn.SetReadLimit(65536)` 限制了单消息大小。但64KB的JSON解析仍消耗CPU。合法消息通常<1KB
- **应对策略**: 考虑降低ReadLimit到4KB

### B-04 畸形JSON消息处理
- **分类**: WebSocket | **严重程度**: 🟢 中危
- **攻击向量**: 发送非JSON或畸形JSON
- **测试步骤**:
  1. 发送纯文本 "hello"
  2. 发送不完整JSON `{"type":"pla`
  3. 发送嵌套过深的JSON `{"type":{"a":{"b":{"c":...}}}}`
  4. 发送二进制数据
- **预期结果**: 应优雅处理，不崩溃
- **实际风险评估**: `conn.ReadJSON(&msg)` 失败时直接 `break` 退出循环，连接关闭。**处理正确**，但不会返回错误信息给客户端
- **应对策略**: 当前实现可接受

### B-05 未加入房间时发送控制消息
- **分类**: WebSocket | **严重程度**: 🟢 中危
- **攻击向量**: 连接后不join/create，直接发送play/pause/seek
- **测试步骤**:
  1. 建立WebSocket连接（已认证）
  2. 直接发送 `{"type":"play","position":0}`
  3. 发送 `{"type":"kick","targetClientID":"xxx"}`
  4. 发送 `{"type":"closeRoom"}`
- **预期结果**: 应忽略或返回错误
- **实际风险评估**: play/pause/seek/kick/closeRoom 都检查 `currentRoom == nil`，会 `continue` 跳过。**已正确防护**
- **应对策略**: 当前实现正确

### B-06 跨房间操作：加入房间A后操作房间B
- **分类**: WebSocket | **严重程度**: 🟡 高危
- **攻击向量**: 通过消息中的roomCode字段尝试操作其他房间
- **测试步骤**:
  1. 用户A创建房间X，用户B创建房间Y
  2. 用户A加入房间X后，发送 `{"type":"play","roomCode":"Y的code"}`
  3. 检查房间Y是否受影响
- **预期结果**: 不应影响房间Y
- **实际风险评估**: play/pause/seek等操作使用 `currentRoom` 变量（连接级别），不使用消息中的 `roomCode`。**已正确防护**，消息中的roomCode仅在join时使用
- **应对策略**: 当前实现正确

### B-07 WebSocket连接泄漏：异常断开不清理
- **分类**: WebSocket | **严重程度**: 🟡 高危
- **攻击向量**: 客户端异常断开（网络中断），服务端未检测到
- **测试步骤**:
  1. 建立连接并加入房间
  2. 直接关闭网络（不发送close frame）
  3. 等待30秒（ReadDeadline超时）
  4. 检查房间客户端列表是否清理
- **预期结果**: 30秒后应自动清理
- **实际风险评估**: ping/pong机制每10秒ping，ReadDeadline 30秒。超时后 `ReadJSON` 返回错误，触发 `defer` 中的 `RemoveClient`。**已正确处理**
- **应对策略**: 当前实现正确，但30秒窗口内幽灵连接仍占资源

### B-08 Ping洪水攻击（限制已禁用）
- **分类**: WebSocket | **严重程度**: 🟡 高危
- **攻击向量**: `pingRateLimit=9999`，可发送海量ping消息
- **测试步骤**:
  1. 建立连接后每秒发送1000条 `{"type":"ping"}`
  2. 每条ping都会触发pong响应和 `GetServerTime()` 调用
  3. 监控服务器CPU
- **预期结果**: 应在5条/秒后限流
- **实际风险评估**: 每个ping触发JSON编码+写入。高频ping可导致写锁竞争
- **应对策略**: 恢复 `pingRateLimit=5`

### B-09 同一用户多连接加入同一房间的去重竞态
- **分类**: WebSocket | **严重程度**: 🟢 中危
- **攻击向量**: 同一用户同时建立多个连接并加入同一房间
- **测试步骤**:
  1. 用户A同时建立5个WebSocket连接
  2. 5个连接同时发送join同一房间
  3. 检查房间中该用户的连接数
- **预期结果**: 应只保留最新连接
- **实际风险评估**: `AddClient` 中有UID去重逻辑，会关闭旧连接。但并发join可能导致多个连接同时通过去重检查（TOCTOU），短暂存在多个连接
- **应对策略**: 可接受，最终一致性由后续join的去重保证

### B-10 Host转移后的权限竞态
- **分类**: WebSocket | **严重程度**: 🟢 中危
- **攻击向量**: Host断开瞬间，新Host尚未确认时发送控制命令
- **测试步骤**:
  1. 房间有3个用户，Host断开
  2. 在Host转移通知到达前，原第二个用户发送play命令
  3. 检查命令是否被执行
- **预期结果**: 应基于服务端状态判断
- **实际风险评估**: play/pause/seek 检查 `currentRoom.IsHost(clientID)` 和 `currentRoom.OwnerID != userID`。OwnerID不随Host转移变化，所以非房主永远无法控制播放。**已正确防护**
- **应对策略**: 当前实现正确（双重检查：Host + OwnerID）

### B-11 WebSocket Origin检查绕过
- **分类**: WebSocket | **严重程度**: 🟢 中危
- **攻击向量**: 不发送Origin头但携带有效JWT
- **测试步骤**:
  1. 使用curl/脚本不带Origin头，但带有效JWT cookie连接 `/ws`
  2. 验证是否允许连接
- **预期结果**: 应允许（已认证的非浏览器客户端）
- **实际风险评估**: `checkOrigin` 在Origin为空时检查JWT。这是设计决策，允许认证的CLI工具连接。但如果 `ALLOWED_ORIGINS` 未设置，任何Origin都被允许
- **应对策略**: 生产环境必须设置 `ALLOWED_ORIGINS`

### B-12 statusReport消息伪造导致强制重同步
- **分类**: WebSocket | **严重程度**: ⚪ 低危
- **攻击向量**: 发送虚假的statusReport使服务端认为客户端不同步
- **测试步骤**:
  1. 加入房间后发送 `{"type":"statusReport","position":99999,"trackIndex":0}`
  2. 观察服务端是否发送 `forceResync`
  3. 发送错误的 `trackIndex` 触发 `forceTrack`
- **预期结果**: 服务端会发送纠正消息
- **实际风险评估**: forceResync/forceTrack 只发给报告者自己，不影响其他用户。攻击者只能"骚扰"自己
- **应对策略**: 当前实现正确，无安全影响

---

## C. 房间管理极端场景 (11个场景)

### C-01 房间创建洪水（全局限制已禁用）
- **分类**: 房间管理 | **严重程度**: 🔴 严重
- **攻击向量**: `MaxRooms=99999`，`MaxRoomsPerUser=99999`，可创建海量房间
- **测试步骤**:
  1. 以admin身份循环发送 `{"type":"create"}` 消息10000次
  2. 监控服务器内存（每个Room含map、mutex、状态）
  3. 检查 `manager.GetRooms()` 遍历性能
- **预期结果**: 应在100个全局/3个每用户后拒绝
- **实际风险评估**: 每个Room约占1-2KB内存，10000个约20MB。但 `cleanupLoop` 每5分钟遍历所有房间，`SyncTick` 每秒遍历所有房间，O(n)复杂度会导致CPU飙升
- **应对策略**: 恢复 `MaxRooms=100`, `MaxRoomsPerUser=3`

### C-02 房间Code碰撞
- **分类**: 房间管理 | **严重程度**: 🟢 中危
- **攻击向量**: `generateCode()` 生成8位hex（4字节），共4,294,967,296种可能
- **测试步骤**:
  1. 创建大量房间，检查是否有code重复
  2. 分析 `CreateRoom` 是否检查code唯一性
- **预期结果**: 应检查并重试
- **实际风险评估**: `CreateRoom` 直接 `m.rooms[code] = room`，如果code碰撞会覆盖已有房间！但概率极低（生日悖论：~65536个房间时50%碰撞概率）
- **应对策略**: CreateRoom中增加code存在性检查

### C-03 单房间万人涌入（限制已禁用）
- **分类**: 房间管理 | **严重程度**: 🔴 严重
- **攻击向量**: `MaxClientsPerRoom=99999`，单房间可加入无限用户
- **测试步骤**:
  1. 创建一个房间
  2. 用1000个不同用户加入该房间
  3. 触发播放，观察broadcast性能
- **预期结果**: 应在50人后拒绝
- **实际风险评估**: `broadcast` 遍历所有客户端逐个 `Send`，1000客户端时每次broadcast需1000次JSON编码+写入。`SyncTick` 每秒对所有playing房间执行此操作
- **应对策略**: 恢复 `MaxClientsPerRoom=50`

### C-04 房间Owner踢出自己
- **分类**: 房间管理 | **严重程度**: ⚪ 低危
- **攻击向量**: 发送kick消息，targetClientID为自己
- **测试步骤**:
  1. 创建房间后发送 `{"type":"kick","targetClientID":"自己的clientID"}`
  2. 检查响应
- **预期结果**: 应拒绝
- **实际风险评估**: 代码检查 `msg.TargetClientID == clientID` 并返回"不能踢出自己"。**已正确防护**
- **应对策略**: 当前实现正确

### C-05 非Owner尝试踢人
- **分类**: 房间管理 | **严重程度**: 🟢 中危
- **攻击向量**: 普通用户发送kick消息
- **测试步骤**:
  1. 用户A创建房间，用户B加入
  2. 用户B发送 `{"type":"kick","targetClientID":"A的clientID"}`
- **预期结果**: 应拒绝
- **实际风险评估**: kick检查 `currentRoom.OwnerID != userID`。**已正确防护**
- **应对策略**: 当前实现正确

### C-06 非Owner尝试关闭房间
- **分类**: 房间管理 | **严重程度**: 🟢 中危
- **攻击向量**: 普通用户发送closeRoom消息
- **测试步骤**:
  1. 用户B加入用户A的房间
  2. 用户B发送 `{"type":"closeRoom"}`
- **预期结果**: 应拒绝
- **实际风险评估**: closeRoom检查 `currentRoom.OwnerID != userID`。**已正确防护**
- **应对策略**: 当前实现正确

### C-07 房间清理循环中的并发访问
- **分类**: 房间管理 | **严重程度**: 🟡 高危
- **攻击向量**: cleanupLoop删除房间时，用户正在操作该房间
- **测试步骤**:
  1. 创建房间后30分钟不活动
  2. 在cleanupLoop触发删除的同时，尝试加入该房间
  3. 检查是否有panic或数据不一致
- **预期结果**: 应安全处理
- **实际风险评估**: `cleanupLoop` 在 `m.mu.Lock()` 下删除房间，`GetRoom` 用 `m.mu.RLock()`。但已获取Room引用的goroutine可能继续操作已删除的Room对象（内存中仍存在，只是从map移除）
- **应对策略**: 可接受，Go GC保证内存安全，但可能导致"幽灵房间"操作

### C-08 快速创建-离开-创建循环导致内存泄漏
- **分类**: 房间管理 | **严重程度**: 🟡 高危
- **攻击向量**: 反复创建房间后立即离开，房间变空但不被删除
- **测试步骤**:
  1. 循环：创建房间 → 立即断开WebSocket → 重新连接 → 创建新房间
  2. 执行1000次
  3. 检查 `manager.rooms` 中的空房间数量
- **预期结果**: 空房间应被及时清理
- **实际风险评估**: 离开时 `RemoveClient` 返回 `empty=true`，但主循环中只是广播userLeft，**不删除空房间**。空房间要等 `cleanupLoop` 每5分钟检查 `LastActive > 30min` 才删除。短时间内可积累大量空房间
- **应对策略**: 空房间应立即删除或启动短延迟删除（`ScheduleDelete` 已实现但未被调用）

### C-09 房间Code枚举攻击（join限流已放宽）
- **分类**: 房间管理 | **严重程度**: 🟡 高危
- **攻击向量**: join限流为30/分钟，8位hex code可被暴力枚举
- **测试步骤**:
  1. 每秒尝试join不同的roomCode
  2. 观察是否能发现活跃房间
  3. 计算枚举效率
- **预期结果**: 应在5次/分钟后限流
- **实际风险评估**: 30次/分钟 × 60分钟 = 1800次/小时。8位hex有65536种可能（4字节），约36小时可完全枚举。但实际活跃房间少，命中概率低
- **应对策略**: 恢复join限流为5/分钟，考虑增加code长度

### C-10 closeRoom后继续发送消息
- **分类**: 房间管理 | **严重程度**: ⚪ 低危
- **攻击向量**: 关闭房间后，在同一WebSocket连接上继续发送消息
- **测试步骤**:
  1. 创建房间并关闭
  2. 在同一连接上发送 `{"type":"play"}`
  3. 检查是否有异常
- **预期结果**: 应忽略
- **实际风险评估**: closeRoom后 `currentRoom = nil`，后续操作检查 `currentRoom == nil` 会跳过。但 `conn.Close()` 被调用，ReadJSON应返回错误退出循环
- **应对策略**: 当前实现正确

### C-11 SyncTick对大量房间的性能影响
- **分类**: 房间管理 | **严重程度**: 🟡 高危
- **攻击向量**: 创建大量playing状态的房间，SyncTick每秒遍历全部
- **测试步骤**:
  1. 创建1000个房间，每个有2个用户，全部处于playing状态
  2. 监控SyncTick goroutine的CPU使用
  3. 测量消息延迟
- **预期结果**: 应有性能保护
- **实际风险评估**: SyncTick每秒遍历 `manager.GetRooms()`（复制slice），对每个playing房间复制客户端列表并逐个发送。1000房间×2客户端=2000次JSON编码/秒，可能导致延迟
- **应对策略**: 恢复MaxRooms限制，考虑SyncTick分批处理

---

## D. 播放控制与同步攻防 (9个场景)

### D-01 NaN/Infinity Position注入
- **分类**: 播放控制 | **严重程度**: 🟡 高危
- **攻击向量**: 发送特殊浮点值作为position
- **测试步骤**:
  1. 发送 `{"type":"play","position":NaN}`（JSON中为null或字符串）
  2. 发送 `{"type":"seek","position":Infinity}`
  3. 发送 `{"type":"play","position":-1}`
- **预期结果**: 应拒绝
- **实际风险评估**: `validatePosition` 检查 `math.IsNaN`, `math.IsInf`, `pos < 0`, `pos > duration`。**已正确防护**。但JSON中NaN不是合法值，Go的json.Unmarshal会将其解析为0
- **应对策略**: 当前实现正确

### D-02 超出音频时长的Position
- **分类**: 播放控制 | **严重程度**: 🟢 中危
- **攻击向量**: seek到超出duration的位置
- **测试步骤**:
  1. 音频时长300秒，发送 `{"type":"seek","position":99999}`
  2. 检查服务端状态
- **预期结果**: 应拒绝
- **实际风险评估**: `validatePosition` 检查 `pos > duration` 并返回错误。**已正确防护**
- **应对策略**: 当前实现正确

### D-03 无音频时发送Play命令
- **分类**: 播放控制 | **严重程度**: ⚪ 低危
- **攻击向量**: 房间未设置音频时发送play
- **测试步骤**:
  1. 创建房间，不上传音频
  2. 发送 `{"type":"play","position":0}`
- **预期结果**: 应拒绝或忽略
- **实际风险评估**: `validatePosition` 中 `dur=0`（无TrackAudio和Audio），此时 `duration > 0` 为false，跳过时长检查。play会成功执行，房间进入Playing状态但无实际音频。**潜在问题**
- **应对策略**: 增加检查：无音频时拒绝play

### D-04 高频Seek攻击导致广播风暴
- **分类**: 播放控制 | **严重程度**: 🟡 高危
- **攻击向量**: Host快速连续seek，每次触发全房间广播
- **测试步骤**:
  1. 房间有50个用户
  2. Host每秒发送100次seek（限流已禁用）
  3. 监控网络带宽和CPU
- **预期结果**: 应被速率限制
- **实际风险评估**: 每次seek触发 `broadcast` 给所有客户端。50用户×100次/秒=5000次JSON写入/秒。消息速率限制已禁用（9999）
- **应对策略**: 恢复消息速率限制

### D-05 TrackChange竞态：切歌时同时Play
- **分类**: 播放控制 | **严重程度**: 🟢 中危
- **攻击向量**: 同时发送nextTrack和play消息
- **测试步骤**:
  1. Host同时发送 `{"type":"nextTrack","trackIndex":1}` 和 `{"type":"play","position":0}`
  2. 检查房间状态是否一致
- **预期结果**: 应串行处理
- **实际风险评估**: WebSocket消息在单goroutine中顺序处理（for循环），不存在并发。但nextTrack设置 `State=StateStopped`，紧接的play会将其改为Playing，可能导致客户端收到trackChange后立即收到play，在加载新音频前就开始播放
- **应对策略**: 可接受，客户端应处理此时序

### D-06 SyncTick Position溢出
- **分类**: 播放控制 | **严重程度**: 🟢 中危
- **攻击向量**: 长时间播放后position持续增长
- **测试步骤**:
  1. 播放一首5分钟的歌，不暂停
  2. 等待10分钟，检查SyncTick广播的position
- **预期结果**: position应被clamp到duration
- **实际风险评估**: SyncTick中 `if duration > 0 && currentPos > duration { currentPos = duration }`。**已正确防护**
- **应对策略**: 当前实现正确

### D-07 ScheduledAt时间戳操纵
- **分类**: 播放控制 | **严重程度**: ⚪ 低危
- **攻击向量**: 客户端忽略scheduledAt，立即播放导致不同步
- **测试步骤**:
  1. 观察play响应中的 `scheduledAt`（serverTime + 800ms）
  2. 客户端立即播放而非等待scheduledAt
  3. 检查与其他客户端的同步偏差
- **预期结果**: 客户端应遵守scheduledAt
- **实际风险评估**: scheduledAt是建议值，服务端无法强制。不同步只影响该客户端自身体验
- **应对策略**: 可接受，statusReport机制会纠正偏差

### D-08 非Owner发送Play/Pause/Seek
- **分类**: 播放控制 | **严重程度**: 🟢 中危
- **攻击向量**: 非房主用户尝试控制播放
- **测试步骤**:
  1. 用户B加入用户A的房间
  2. 用户B发送play/pause/seek消息
- **预期结果**: 应被忽略
- **实际风险评估**: 双重检查 `!currentRoom.IsHost(clientID)` 和 `currentRoom.OwnerID != userID`。**已正确防护**
- **应对策略**: 当前实现正确

### D-09 nextTrack越界索引
- **分类**: 播放控制 | **严重程度**: 🟢 中危
- **攻击向量**: 发送超出播放列表范围的trackIndex
- **测试步骤**:
  1. 播放列表有3首歌
  2. 发送 `{"type":"nextTrack","trackIndex":999}`
  3. 发送 `{"type":"nextTrack","trackIndex":-1}`
- **预期结果**: 应拒绝
- **实际风险评估**: 代码检查 `msg.TrackIndex < 0 || msg.TrackIndex >= len(items)`。**已正确防护**
- **应对策略**: 当前实现正确

---

## E. 数据库与存储攻防 (9个场景)

### E-01 SQLite并发写入瓶颈
- **分类**: 数据库 | **严重程度**: 🟡 高危
- **攻击向量**: 大量并发注册/登录导致SQLite写锁竞争
- **测试步骤**:
  1. 100个并发goroutine同时注册新用户
  2. 监控SQLite busy timeout（5000ms）
  3. 检查是否有注册失败
- **预期结果**: 应在busy_timeout内完成
- **实际风险评估**: `_busy_timeout=5000` 和 WAL模式允许并发读，但写入仍串行。高并发写入可能导致5秒超时。`CreateUser` 有3次重试机制
- **应对策略**: 注册限流是主要防线（需恢复），考虑连接池配置

### E-02 音频文件上传：路径穿越攻击
- **分类**: 存储 | **严重程度**: 🔴 严重
- **攻击向量**: 上传文件名包含 `../` 尝试写入任意路径
- **测试步骤**:
  1. 上传文件名为 `../../../etc/passwd.mp3` 的文件
  2. 检查文件是否被写入预期外的路径
- **预期结果**: 应被阻止
- **实际风险评估**: 上传使用 `uuid.New().String()` 作为目录名，原始文件名仅用于扩展名提取（`filepath.Ext`）和数据库记录。实际存储路径为 `{DataDir}/library/{userID}/{uuid}/original{ext}`。**已正确防护**
- **应对策略**: 当前实现正确

### E-03 音频文件上传：伪装文件类型
- **分类**: 存储 | **严重程度**: 🟡 高危
- **攻击向量**: 上传恶意文件但伪装为音频扩展名
- **测试步骤**:
  1. 将ELF二进制文件重命名为 `.mp3` 上传
  2. 将PHP webshell重命名为 `.flac` 上传
  3. 检查是否通过验证
- **预期结果**: 应被magic bytes检查拦截
- **实际风险评估**: `isAudioMagic` 检查文件头魔数，非音频文件会被拒绝。但文件仍会被传递给ffmpeg处理，ffmpeg可能有已知漏洞
- **应对策略**: 当前magic检查有效，建议在沙箱中运行ffmpeg

### E-04 50MB上传限制绕过
- **分类**: 存储 | **严重程度**: 🟢 中危
- **攻击向量**: 尝试上传超过50MB的文件
- **测试步骤**:
  1. 上传51MB的音频文件
  2. 使用chunked transfer encoding尝试绕过
- **预期结果**: 应被拒绝
- **实际风险评估**: `http.MaxBytesReader(w, r.Body, maxUploadSize)` 在读取超过50MB时返回错误。`limitedMux` 对非upload路由限制1MB。**已正确防护**
- **应对策略**: 当前实现正确

### E-05 音频Segment文件路径穿越
- **分类**: 存储 | **严重程度**: 🔴 严重
- **攻击向量**: 通过segment API读取任意文件
- **测试步骤**:
  1. 请求 `/api/library/segments/1/../../etc/passwd/medium/seg_000.flac`
  2. 请求 `/api/library/segments/1/audioID/../../.jwt_secret/seg_000.flac`
- **预期结果**: 应被阻止
- **实际风险评估**: `ServeSegmentFile` 对每个路径组件使用 `filepath.Base()` 并检查 `..`。还使用DB中的ownerID而非URL参数构建路径。**已正确防护**
- **应对策略**: 当前实现正确（多层防护）

### E-06 ffmpeg命令注入
- **分类**: 存储 | **严重程度**: 🔴 严重
- **攻击向量**: 通过文件名注入ffmpeg参数
- **测试步骤**:
  1. 上传文件名为 `-i /etc/passwd -f mp3.mp3` 的文件
  2. 检查ffmpeg是否执行了注入的参数
- **预期结果**: 应被阻止
- **实际风险评估**: `sanitizeInputPath` 检查路径是否以 `-` 开头并添加 `./` 前缀。但实际输入路径是 `{audioDir}/original{ext}`，不受用户控制。**已正确防护**
- **应对策略**: 当前实现正确

### E-07 磁盘空间耗尽攻击
- **分类**: 存储 | **严重程度**: 🟡 高危
- **攻击向量**: 反复上传大文件耗尽磁盘空间
- **测试步骤**:
  1. 反复上传49MB的音频文件
  2. 每个文件会生成多质量segment（原始+lossless+high+medium+low）
  3. 计算空间放大倍数
- **预期结果**: 应有存储配额
- **实际风险评估**: 49MB原始文件 → 4个质量等级的FLAC segment，总计可能200MB+。无用户存储配额限制，无全局磁盘空间检查
- **应对策略**: 增加用户存储配额，监控磁盘使用

### E-08 删除用户后音频文件残留
- **分类**: 存储 | **严重程度**: 🟢 中危
- **攻击向量**: 删除用户后磁盘文件未完全清理
- **测试步骤**:
  1. 用户上传多个音频文件
  2. 管理员删除该用户
  3. 检查磁盘上的文件是否全部删除
- **预期结果**: 应全部清理
- **实际风险评估**: `AdminDeleteUser` 调用 `DB.DeleteUser` 获取文件名列表，然后 `os.RemoveAll` 删除。但使用 `AUDIO_DIR` 环境变量（默认 `audio_files`），而上传使用 `DataDir/library/{userID}/`。**路径不匹配！** 删除操作可能清理错误目录
- **应对策略**: 统一音频文件存储路径，确保删除路径与上传路径一致

### E-09 播放列表引用已删除的音频文件
- **分类**: 数据库 | **严重程度**: 🟢 中危
- **攻击向量**: 删除音频文件后，播放列表中的引用变为悬空
- **测试步骤**:
  1. 将音频添加到播放列表
  2. 删除该音频文件
  3. 获取播放列表，检查是否有错误
  4. 尝试播放该曲目
- **预期结果**: 应优雅处理
- **实际风险评估**: `DeleteAudioFile` 先删除 `playlist_items` 再删除 `audio_files`（事务内）。**已正确防护**。但如果在事务提交后、客户端刷新前，客户端可能缓存了旧列表
- **应对策略**: 当前实现正确

---

## F. API安全攻防 (12个场景)

### F-01 未认证访问Admin API
- **分类**: API安全 | **严重程度**: 🟡 高危
- **攻击向量**: 无token直接访问 `/api/admin/users`
- **测试步骤**:
  1. 不带cookie/Authorization头请求 `GET /api/admin/users`
  2. 带普通user的token请求
  3. 带admin（非owner）的token请求
- **预期结果**: 全部返回403
- **实际风险评估**: `AdminListUsers` 检查 `user.Role != "owner"`。AuthMiddleware不强制（不返回401），但handler内部检查。admin角色也被拒绝。**已正确防护**
- **应对策略**: 当前实现正确

### F-02 IDOR：通过UID操作其他用户
- **分类**: API安全 | **严重程度**: 🟡 高危
- **攻击向量**: 修改URL中的UID参数访问/操作其他用户数据
- **测试步骤**:
  1. 用户A删除用户B的音频：`DELETE /api/library/files/{B的文件ID}`
  2. 用户A取消用户B的共享：`DELETE /api/library/share/{B的UID}`
- **预期结果**: 应拒绝
- **实际风险评估**: `DeleteFile` 检查 `af.OwnerID != user.UserID`。`Unshare` 使用 `user.UserID` 作为ownerID。**已正确防护**
- **应对策略**: 当前实现正确

### F-03 Segment访问控制绕过：非房间成员获取音频
- **分类**: API安全 | **严重程度**: 🟡 高危
- **攻击向量**: 知道audioUUID后直接请求segment文件
- **测试步骤**:
  1. 用户C（非owner、非共享、不在房间中）请求 `/api/library/segments/{ownerID}/{audioUUID}/medium/seg_000.flac`
  2. 检查是否返回403
- **预期结果**: 应返回403
- **实际风险评估**: `ServeSegmentFile` 检查 `CanAccessAudioFile`（owner或shared）和 `IsUserInRoomWithAudio`。**已正确防护**
- **应对策略**: 当前实现正确

### F-04 Playlist操作的房间Owner验证
- **分类**: API安全 | **严重程度**: 🟡 高危
- **攻击向量**: 非房主通过REST API操作播放列表
- **测试步骤**:
  1. 用户B（非房主）调用 `POST /api/room/{code}/playlist/add`
  2. 用户B调用 `DELETE /api/room/{code}/playlist/{itemID}`
  3. 用户B调用 `PUT /api/room/{code}/playlist/mode`
- **预期结果**: 全部返回403
- **实际风险评估**: 所有playlist操作调用 `isRoomOwner(user.UserID, code)`。**已正确防护**
- **应对策略**: 当前实现正确

### F-05 请求体大小限制绕过
- **分类**: API安全 | **严重程度**: 🟢 中危
- **攻击向量**: 发送超大JSON body到非upload API
- **测试步骤**:
  1. 向 `/api/auth/login` 发送2MB的JSON body
  2. 向 `/api/auth/register` 发送2MB body
- **预期结果**: 应被1MB限制拦截
- **实际风险评估**: `limitedMux` 对非 `/api/library/upload` 路由设置 `MaxBytesReader(1MB)`。**已正确防护**
- **应对策略**: 当前实现正确

### F-06 User Settings存储无大小限制
- **分类**: API安全 | **严重程度**: 🟢 中危
- **攻击向量**: 通过settings API存储大量数据
- **测试步骤**:
  1. `PUT /api/user/settings` body为900KB的JSON（在1MB限制内）
  2. 重复多次，检查数据库膨胀
- **预期结果**: 应有settings大小限制
- **实际风险评估**: `SaveUserSettings` 直接存储任意JSON字符串，无大小验证。受限于全局1MB body限制，但每个用户可存储接近1MB的settings
- **应对策略**: 增加settings大小限制（如10KB）

### F-07 共享库权限：共享给非admin用户
- **分类**: API安全 | **严重程度**: 🟢 中危
- **攻击向量**: 尝试将音频库共享给普通user角色
- **测试步骤**:
  1. admin用户调用 `POST /api/library/share` body: `{"shared_with_uid": 普通用户UID}`
- **预期结果**: 应拒绝
- **实际风险评估**: `Share` 检查 `target.Role != "admin" && target.Role != "owner"`。**已正确防护**
- **应对策略**: 当前实现正确

### F-08 静态文件缓存头安全
- **分类**: API安全 | **严重程度**: ⚪ 低危
- **攻击向量**: 敏感页面被浏览器缓存
- **测试步骤**:
  1. 访问 `/admin` 页面，检查缓存头
  2. 访问 `.js` 和 `.css` 文件，检查缓存头
- **预期结果**: 动态页面不应被缓存
- **实际风险评估**: CSS/JS和根路径设置了 `no-cache`，但 `/admin` 和 `/library` 页面使用 `http.ServeFile` 未设置缓存头
- **应对策略**: 为敏感页面添加 `Cache-Control: no-store`

### F-09 HTTP方法限制不一致
- **分类**: API安全 | **严重程度**: ⚪ 低危
- **攻击向量**: 使用非预期HTTP方法访问API
- **测试步骤**:
  1. `GET /api/auth/login`（应只允许POST）
  2. `POST /api/library/files`（应只允许GET）
  3. `OPTIONS` 请求各端点
- **预期结果**: 应返回405
- **实际风险评估**: 各handler手动检查HTTP方法并返回405。**已正确防护**，但缺少统一的CORS预检处理
- **应对策略**: 考虑添加CORS中间件

### F-10 Admin页面的前端权限检查可绕过
- **分类**: API安全 | **严重程度**: 🟢 中危
- **攻击向量**: 直接请求admin.html静态文件
- **测试步骤**:
  1. 非owner用户直接请求 `/admin`
  2. 检查是否重定向
  3. 直接请求 `/admin.html`（如果存在）
- **预期结果**: 应重定向到首页
- **实际风险评估**: `/admin` 路由检查 `userInfo.Role != "owner"` 并重定向。但如果 `admin.html` 在静态文件目录中，可能通过其他路径访问。实际上Go的ServeMux精确匹配 `/admin`，不会匹配 `/admin.html`，但静态文件服务器可能提供
- **应对策略**: 将admin.html移出静态目录，或添加中间件拦截

### F-11 Playlist RoomCode注入
- **分类**: API安全 | **严重程度**: 🟢 中危
- **攻击向量**: 使用恶意roomCode创建播放列表
- **测试步骤**:
  1. `POST /api/room/'; DROP TABLE playlists;--/playlist`
  2. `POST /api/room/../../admin/playlist`
- **预期结果**: 应被安全处理
- **实际风险评估**: roomCode通过URL路径提取（`strings.Split`），作为参数传入SQL查询（使用 `?` 占位符）。**SQL注入已防护**。路径穿越不影响（roomCode只用于DB查询）
- **应对策略**: 当前实现正确

### F-12 音频处理后台goroutine泄漏
- **分类**: API安全 | **严重程度**: 🟡 高危
- **攻击向量**: 上传音频后立即删除，后台质量转码goroutine仍在运行
- **测试步骤**:
  1. 上传音频文件（触发多质量转码）
  2. 立即删除该文件
  3. 检查后台goroutine是否仍在运行ffmpeg
  4. 检查是否写入已删除的目录
- **预期结果**: 应取消后台处理
- **实际风险评估**: `ProcessAudioMultiQuality` 中后台goroutine无取消机制（无context传递）。删除文件后goroutine继续运行ffmpeg，写入已不存在的目录（会失败但不panic）。goroutine最终会结束，但浪费CPU
- **应对策略**: 为后台转码添加context取消机制

---

## 风险汇总表

| 严重程度 | 数量 | 场景编号 |
|----------|------|----------|
| 🔴 严重 | 5 | A-01, A-02, B-01, B-02, C-01 |
| 🟡 高危 | 16 | A-03, A-04, A-05, A-06, B-03, B-08, C-03, C-07, C-08, C-09, C-11, D-04, E-01, E-03, E-07, F-12 |
| 🟢 中危 | 24 | A-07, A-08, A-10, A-11, B-04, B-05, B-06, B-09, B-10, B-11, C-02, C-05, C-06, D-02, D-05, D-06, D-08, D-09, E-04, E-08, E-09, F-05, F-06, F-07, F-10, F-11 |
| ⚪ 低危 | 10 | A-09, A-12, B-07, B-12, C-04, C-10, D-01, D-03, D-07, F-08, F-09 |

### 🚨 最高优先级修复项

1. **恢复所有 `TODO: restore` 限制值** — 当前代码等同于无任何资源保护，涉及10+处常量
2. **强制修改默认admin密码** — 后端层面阻止默认密码登录
3. **统一音频文件存储/删除路径** — E-08发现的路径不匹配问题（`AUDIO_DIR` vs `DataDir/library/`）
4. **为后台ffmpeg转码添加context取消机制** — 防止goroutine和CPU资源泄漏
5. **空房间即时清理** — 调用已实现但未使用的 `ScheduleDelete`
6. **增加用户存储配额** — 防止磁盘空间耗尽攻击-e 

---

# 第二部分：认证与授权专项

# A - 认证与授权攻防测试场景

> 基于 `internal/auth/auth.go`、`internal/auth/handlers.go`、`main.go` 源码分析
> 生成日期：2026-02-21

---

## ⚠️ 全局风险提示：Rate Limit 全部失效

代码中以下 rate limit 阈值均被设为 **9999**（标注 `TODO: restore`），**当前等同于无限制**：

| 位置 | 原始值 | 当前值 | 影响 |
|------|--------|--------|------|
| `handlers.go` 注册限流 | 5/hour/IP | 9999 | 可批量注册 |
| `handlers.go` 登录IP限流 | 5/min/IP | 9999 | 可暴力破解 |
| `handlers.go` 登录用户名限流 | 5/min/user | 9999 | 可针对单账户爆破 |
| `main.go` WS消息限流 | 10/s | 9999 | 可DoS |
| `main.go` WS ping限流 | 5/s | 9999 | 可DoS |
| `main.go` WS总限流 | 12/s | 9999 | 可DoS |
| `main.go` WS连接数/用户 | 5 | 9999 | 可耗尽资源 |

---

## 场景 A-01：登录暴力破解（无限制）

- **严重程度**：🔴 严重
- **攻击向量**：利用 `loginLimiter` 阈值为 9999，对 `/api/auth/login` 发起高速密码字典攻击
- **测试步骤**：
  1. 准备常见密码字典（top 10000）
  2. 对已知用户名循环 POST `/api/auth/login`，每秒 100+ 请求
  3. 观察是否收到 429 响应
- **预期结果**：第 6 次起应返回 429
- **实际风险评估**：阈值 9999，实际不会触发限流。6 位纯数字密码可在 10 秒内穷举完毕
- **应对策略**：立即将 `loginLimiter` 恢复为 5/min/IP；`usernameLoginLimiter` 恢复为 5/min/user；考虑引入指数退避或账户锁定

---

## 场景 A-02：批量注册资源耗尽

- **严重程度**：🔴 严重
- **攻击向量**：`regLimiter` 阈值 9999，脚本批量 POST `/api/auth/register` 创建海量账户
- **测试步骤**：
  1. 循环注册 `bot_0001` ~ `bot_9999`，密码统一 `123456`
  2. 检查数据库用户表膨胀情况
- **预期结果**：第 6 次起应返回 429
- **实际风险评估**：无限制，可在分钟级创建数千账户，耗尽磁盘/DB资源
- **应对策略**：恢复为 5/hour/IP；增加 CAPTCHA 或邮箱验证

---

## 场景 A-03：JWT 密钥弱化 — 短密钥 padding

- **严重程度**：🟡 中等
- **攻击向量**：`JWT_SECRET` 环境变量设为极短值（如 `"a"`），`padSecretIfNeeded()` 用随机字节补齐，但每次重启 padding 不同导致所有 token 失效；若攻击者知道短密钥前缀，爆破空间缩小
- **测试步骤**：
  1. 设置 `JWT_SECRET=ab`，启动服务
  2. 登录获取 token，重启服务
  3. 用旧 token 访问 `/api/auth/me`
- **预期结果**：旧 token 应失效（padding 变化）
- **实际风险评估**：padding 随机部分每次重启变化，token 全部失效影响可用性；短密钥降低爆破难度
- **应对策略**：启动时校验 `JWT_SECRET` 最小长度 ≥ 32 字节，不足则拒绝启动而非静默 padding

---

## 场景 A-04：JWT Token 篡改 — 角色提权

- **严重程度**：🔴 严重
- **攻击向量**：修改 JWT payload 中 `role` 字段为 `"owner"`，尝试绕过权限检查
- **测试步骤**：
  1. 普通用户登录获取 token
  2. Base64 解码 payload，将 `role` 改为 `owner`，重新签名（需猜测密钥）
  3. 用篡改 token 访问 `/api/admin/users`
- **预期结果**：签名验证失败，返回 401
- **实际风险评估**：`validateClaimsAgainstDB()` 会比对 DB 中的 role，即使签名被绕过也会拦截。双重防护有效。但若 `authDB == nil`（未调用 `SetDB`），则直接信任 token 中的 role
- **应对策略**：确保 `SetDB()` 在所有路径上都被调用；增加启动断言

---

## 场景 A-05：Owner 默认密码未修改

- **严重程度**：🔴 严重
- **攻击向量**：Login handler 检查 owner 是否使用默认密码 `admin123`，但仅返回 `needChangePassword` 提示，不强制
- **测试步骤**：
  1. 用 `admin` / `admin123` 登录
  2. 忽略修改密码提示，直接访问管理接口
- **预期结果**：应强制修改密码后才能操作
- **实际风险评估**：默认密码硬编码在源码中（`CheckPassword(user.PasswordHash, "admin123")`），任何人都可尝试。登录成功后拥有 owner 全部权限
- **应对策略**：首次登录强制改密码（后端拦截，非前端提示）；从源码中移除明文默认密码

---

## 场景 A-06：WebSocket 连接洪泛

- **严重程度**：🔴 严重
- **攻击向量**：`maxWSConnsPerUser = 9999`，单用户可建立近万条 WS 连接耗尽服务器 fd/内存
- **测试步骤**：
  1. 用合法 token 并发建立 500 条 `/ws` 连接
  2. 监控服务器内存和 fd 使用
- **预期结果**：第 6 条起应返回 429
- **实际风险评估**：9999 上限等于无限制，单用户可耗尽服务器资源
- **应对策略**：恢复为 5/user；增加全局 WS 连接上限

---

## 场景 A-07：X-Forwarded-For 欺骗绕过 IP 限流

- **严重程度**：🟡 中等
- **攻击向量**：`GetClientIP()` 在 `TRUSTED_PROXIES` 配置时信任 XFF 头。若配置不当（如设为 `0.0.0.0/0`），攻击者可伪造任意 IP 绕过所有 IP 限流
- **测试步骤**：
  1. 设置 `TRUSTED_PROXIES` 为反代 IP
  2. 直接（非经反代）发请求，携带 `X-Forwarded-For: 1.2.3.4`
  3. 检查限流是否基于伪造 IP
- **预期结果**：非受信来源的 XFF 应被忽略
- **实际风险评估**：代码用字符串精确匹配 `remoteIP`，未做 CIDR 解析。若 `TRUSTED_PROXIES` 未设置则安全（仅用 RemoteAddr）。但配置错误时可被绕过
- **应对策略**：支持 CIDR 格式；文档明确说明仅填反代内网 IP

---

## 场景 A-08：Token 自动续期权限提升

- **严重程度**：🟡 中等
- **攻击向量**：`tryAutoRenew()` 在 token 剩余 <2h 时自动续期。若用户已被降权但旧 token 未过期，续期时是否使用旧权限？
- **测试步骤**：
  1. Admin 用户登录获取 token
  2. Owner 将其降为 user
  3. 等待 token 进入续期窗口（<2h），发起请求触发续期
  4. 检查新 token 中的 role
- **预期结果**：新 token 应为 `user` 角色
- **实际风险评估**：`tryAutoRenew()` 从 DB 获取最新 role/version，**此处实现正确**。降权后续期会拿到新角色
- **应对策略**：当前实现安全，保持 DB 查询逻辑不变

---

## 场景 A-09：密码修改后旧 Token 仍有效窗口

- **严重程度**：🟡 中等
- **攻击向量**：修改密码后 `GlobalRoleCache` 被 Invalidate，但缓存 TTL 为 5 秒。在缓存未命中前的极短窗口内，旧 token 是否仍可用？
- **测试步骤**：
  1. 用户 A 登录获取 token T1
  2. 用户 A 修改密码，获取新 token T2
  3. 立即用 T1 访问受保护接口
- **预期结果**：T1 应立即失效
- **实际风险评估**：`ChangePassword` 调用 `Invalidate()` 清除缓存，下次验证会查 DB 发现 `password_version` 不匹配。**实际安全**，无窗口问题
- **应对策略**：当前实现正确。可增加集成测试验证

---

## 场景 A-10：Logout 未认证也可调用

- **严重程度**：🟢 低
- **攻击向量**：`/api/auth/logout` 不经过 AuthMiddleware，任何人可调用。若携带他人 token（如 XSS 窃取），可使其 session 失效
- **测试步骤**：
  1. 窃取用户 token（模拟 XSS）
  2. 用该 token 调用 `/api/auth/logout`
  3. 检查原用户是否被登出
- **预期结果**：原用户所有 session 失效（`BumpSessionVersion`）
- **实际风险评估**：Cookie 设置了 `HttpOnly` + `SameSiteStrict`，XSS 窃取 cookie 难度高。但若 token 通过 Authorization header 泄露（如日志），可被利用强制登出
- **应对策略**：Logout 前验证 CSRF token；日志中脱敏 Authorization header

---

## 场景 A-11：房间码枚举

- **严重程度**：🟢 低
- **攻击向量**：房间码为 8 位十六进制（`generateCode()` = 4 bytes hex），共 4,294,967,296 种。`joinLimiter` 设为 30/min，可缓慢枚举
- **测试步骤**：
  1. 认证后建立 WS 连接
  2. 循环发送 `{"type":"join","roomCode":"XXXXXXXX"}` 尝试不同房间码
  3. 观察成功加入的响应
- **预期结果**：频繁失败后应被限流
- **实际风险评估**：30/min 限流存在但空间大（43亿），实际枚举成功率极低。但活跃房间少时概率上升
- **应对策略**：join 失败不透露"房间不存在"vs"限流"的区别；考虑更长房间码

---

## 场景 A-12：WebSocket Origin 绕过（空 Origin）

- **严重程度**：🟡 中等
- **攻击向量**：`checkOrigin()` 对空 Origin 的请求，只要携带有效 JWT 就放行。恶意原生应用或 curl 可绕过 Origin 检查
- **测试步骤**：
  1. 用 curl/wscat 不带 Origin 头，携带有效 token 连接 `/ws`
  2. 检查是否成功升级为 WebSocket
- **预期结果**：应拒绝非浏览器来源
- **实际风险评估**：设计意图是支持非浏览器客户端（注释说明）。但这意味着 CSRF 防护依赖 token 而非 Origin
- **应对策略**：若仅支持浏览器，拒绝空 Origin；否则确保 token 不可被 CSRF 窃取（当前 HttpOnly + SameSiteStrict 已覆盖）

---

## 场景 A-13：bcrypt 72 字节截断

- **严重程度**：⚪ 信息
- **攻击向量**：bcrypt 算法对超过 72 字节的密码静默截断。代码已做 `maxPasswordBytes = 72` 检查
- **测试步骤**：
  1. 注册时提交 73 字节密码
  2. 检查是否返回错误
- **预期结果**：返回 400 "密码过长"
- **实际风险评估**：`HashPassword()` 和 `Register/ChangePassword` handler 均做了长度校验，**已正确防护**
- **应对策略**：当前实现安全，无需修改

---

## 场景 A-14：Admin API 路径遍历

- **严重程度**：🟡 中等
- **攻击向量**：`AdminDeleteUser` 用 `strings.TrimPrefix(r.URL.Path, "/api/admin/users/")` 提取 UID，若传入 `../../etc` 等非数字路径
- **测试步骤**：
  1. Owner 身份 DELETE `/api/admin/users/../../etc/passwd`
  2. 检查是否触发异常行为
- **预期结果**：`strconv.ParseInt` 解析失败，返回 400
- **实际风险评估**：`ParseInt` 会拒绝非数字输入，**路径遍历不可行**。但 `AdminDeleteUser` 删除用户后清理音频文件用了 `os.RemoveAll(filepath.Join(audioDir, fn))`，若 `fn`（来自 DB）被污染则有风险
- **应对策略**：对 `fn` 做 `filepath.Base()` 过滤，防止路径穿越

---

## 总结

| 风险等级 | 数量 | 关键发现 |
|---------|------|---------|
| 🔴 严重 | 4 | Rate limit 全部失效、默认密码、WS 连接洪泛 |
| 🟡 中等 | 4 | JWT 弱密钥、XFF 欺骗、Origin 绕过、路径遍历 |
| 🟢 低 | 2 | Logout 无认证、房间码枚举 |
| ⚪ 信息 | 1 | bcrypt 截断（已防护） |
| ✅ 安全 | 2 | Token 续期、密码修改后失效（实现正确） |

**最高优先级**：恢复所有 `9999` rate limit 到生产值，这是当前最大的安全隐患。
-e 

---

# 第三部分：WebSocket与房间管理专项

# ListenTogether 测试场景：WebSocket协议攻防 + 房间管理极端场景

> 生成日期：2026-02-21
> 源码版本：main.go + internal/room/room.go
> 注意：当前 maxWSConnsPerUser=9999, MaxRooms=99999, MaxClientsPerRoom=99999, msgRateLimit=9999 等限制已放开（TODO状态）

---

## B. WebSocket协议攻防

### B-01 未认证WebSocket连接
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🔴 |
| 攻击向量 | 不携带JWT Token直接发起WebSocket握手请求 |
| 测试步骤 | 1. 使用wscat/curl等工具直接连接 `ws://host:8080/ws`，不带任何Authorization header或cookie<br>2. 携带过期/伪造JWT连接<br>3. 携带空Origin且无JWT连接 |
| 预期结果 | 服务端返回401 Unauthorized，拒绝升级为WebSocket；`checkOrigin`中空Origin+无JWT也被拒绝 |
| 实际风险评估 | 低风险。`handleWebSocket`入口处有`ExtractUserFromRequest`校验，`checkOrigin`对空Origin也要求JWT有效。防线完整 |
| 应对策略 | 当前实现已覆盖。建议增加连接失败的IP级限流，防止暴力探测 |

### B-02 畸形JSON消息注入
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🟡 |
| 攻击向量 | 发送非法JSON、截断JSON、嵌套超深JSON、含非预期字段的JSON |
| 测试步骤 | 1. 发送 `{invalid json`<br>2. 发送 `{"type": 123}` (type非string)<br>3. 发送 `{"type":"play","position":"not_a_number"}`<br>4. 发送嵌套1000层的合法JSON<br>5. 发送含额外未知字段 `{"type":"play","evil":"payload"}` |
| 预期结果 | `conn.ReadJSON(&msg)` 解析失败时返回error，主循环break，连接关闭。类型不匹配的字段被Go零值处理 |
| 实际风险评估 | 中风险。畸形JSON导致连接断开是安全的，但`position`为string时Go的json.Unmarshal会报错断开连接，可能被用于DoS单个用户连接 |
| 应对策略 | 当前行为可接受。可考虑在ReadJSON失败时区分"客户端错误"和"网络错误"，对前者发送error消息后再断开 |

### B-03 超大消息攻击（64KB限制绕过）
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🟡 |
| 攻击向量 | 发送超过64KB的单条WebSocket消息，尝试耗尽服务端内存 |
| 测试步骤 | 1. 构造65KB的JSON消息（如超长roomCode字段）发送<br>2. 构造恰好64KB的消息验证边界<br>3. 连续发送多条接近64KB的消息 |
| 预期结果 | `conn.SetReadLimit(65536)` 生效，超过64KB的消息触发读取错误，连接断开 |
| 实际风险评估 | 低风险。gorilla/websocket的ReadLimit机制可靠。但64KB×大量并发连接仍可消耗可观内存 |
| 应对策略 | 当前64KB限制合理。建议在恢复连接数限制后（maxWSConnsPerUser=5），总内存风险可控 |

### B-04 高频消息洪泛（Rate Limit失效）
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🔴 |
| 攻击向量 | 利用当前 msgRateLimit=9999/s 的放开状态，每秒发送数千条消息 |
| 测试步骤 | 1. 认证后建立WS连接<br>2. 循环发送 `{"type":"ping"}` 消息，速率5000条/秒<br>3. 观察服务端CPU和内存使用<br>4. 同时从多个连接发起洪泛 |
| 预期结果 | 当前TODO状态下，9999条/秒的限制几乎不生效，服务端被迫处理所有消息 |
| 实际风险评估 | **高风险**。这是当前最大的安全隐患。rate limit形同虚设，单用户可轻松发起DoS。`checkRate`函数的滑动窗口在高频下还会产生大量时间戳切片分配 |
| 应对策略 | **立即恢复** msgRateLimit=10, pingRateLimit=5, totalRateLimit=12。考虑用令牌桶替代滑动窗口减少内存分配 |

### B-05 WebSocket连接耗尽攻击
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🔴 |
| 攻击向量 | 利用 maxWSConnsPerUser=9999 的放开状态，单用户建立数千条WebSocket连接 |
| 测试步骤 | 1. 使用同一JWT Token并发建立1000条WebSocket连接<br>2. 每条连接保持活跃（响应ping/pong）<br>3. 观察服务端文件描述符、goroutine数量、内存使用<br>4. 尝试用多个用户账号各建立1000条连接 |
| 预期结果 | 当前限制下全部连接成功。每条连接至少消耗2个goroutine（读循环+ping定时器），1000连接=2000+goroutine |
| 实际风险评估 | **高风险**。每条WS连接消耗：1个goroutine(读循环) + 1个goroutine(ping ticker) + 连接缓冲区。1000连接≈数十MB内存+2000 goroutine。可耗尽服务端fd限制 |
| 应对策略 | **立即恢复** maxWSConnsPerUser=5。增加全局连接数上限。考虑在反向代理层（nginx）增加per-IP连接限制 |

### B-06 并发写入竞态条件
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🟡 |
| 攻击向量 | 触发对同一WebSocket连接的并发写入，利用gorilla/websocket不支持并发写的特性 |
| 测试步骤 | 1. 用户加入一个多人房间<br>2. 房主快速连续触发play/pause/seek，同时syncTick goroutine也在广播<br>3. 另一用户同时join触发broadcast，与ping goroutine的WriteControl并发<br>4. 使用`-race`标志运行服务端检测竞态 |
| 预期结果 | `Client.mu`互斥锁保护所有写操作（Send/Lock+WriteControl），不应出现并发写入 |
| 实际风险评估 | 低风险。代码中`safeWrite`在join前用`connMu`，join后用`myClient.Send()`，`safePing`也正确获取锁。但存在一个窗口：`myClient`赋值和实际使用之间无原子保证 |
| 应对策略 | 建议用`-race`做压力测试验证。考虑将`myClient`的赋值和使用用atomic.Value包装 |

### B-07 Ping/Pong超时与僵尸连接
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🟢 |
| 攻击向量 | 建立连接后不响应Ping帧，或故意延迟Pong响应 |
| 测试步骤 | 1. 建立WS连接后，客户端不设置Pong handler（不回复Pong）<br>2. 等待30秒观察服务端是否断开连接<br>3. 建立连接后立即停止发送任何数据<br>4. 在Pong中故意延迟25秒再回复 |
| 预期结果 | `SetReadDeadline(30s)` + 10秒ping间隔：如果30秒内无任何读取（包括Pong），ReadJSON超时，连接断开 |
| 实际风险评估 | 低风险。死连接检测机制完整。但如果攻击者持续发送最小数据（如ping消息）保持连接活跃，ReadDeadline会被重置 |
| 应对策略 | 当前机制足够。恢复rate limit后，持续发ping也会被限流断开 |

### B-08 Origin伪造与CSRF攻击
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🟡 |
| 攻击向量 | 伪造Origin header绕过`checkOrigin`，或在未设置ALLOWED_ORIGINS时从恶意网站发起跨站WebSocket |
| 测试步骤 | 1. 未设置ALLOWED_ORIGINS时，从 `evil.com` 发起WS连接（携带有效JWT）<br>2. 设置ALLOWED_ORIGINS后，伪造Origin为允许的域名<br>3. 通过恶意网页的JavaScript发起WebSocket连接（浏览器会自动带Origin） |
| 预期结果 | 未设置ALLOWED_ORIGINS时，任何Origin都被允许（代码注释"backward-compatible permissive"）。设置后只允许白名单域名 |
| 实际风险评估 | 中风险。生产环境如果未设置ALLOWED_ORIGINS，任何网站都可以发起跨站WebSocket（前提是用户浏览器中有有效JWT cookie）。Origin header在非浏览器客户端可随意伪造 |
| 应对策略 | **生产环境必须设置ALLOWED_ORIGINS**。WebSocket的CSRF防护不能仅依赖Origin，JWT的传递方式（cookie vs header）也需考虑 |

### B-09 消息类型混淆与未知类型处理
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🟢 |
| 攻击向量 | 发送未定义的消息类型，或在不同状态下发送不匹配的消息类型 |
| 测试步骤 | 1. 发送 `{"type":"admin_delete_all"}`<br>2. 发送 `{"type":""}` 空类型<br>3. 未加入房间时发送 `{"type":"play"}`<br>4. 非房主发送 `{"type":"kick"}` |
| 预期结果 | switch语句无匹配case时静默忽略。未加入房间时`currentRoom==nil`检查阻止操作。非房主的权限检查通过`IsHost`和`OwnerID`双重验证 |
| 实际风险评估 | 低风险。Go的switch不会fall-through，未知类型被安全忽略。权限检查完整 |
| 应对策略 | 可考虑对未知类型返回error消息帮助客户端调试，但不影响安全性 |

### B-10 Position字段特殊值注入
| 项目 | 内容 |
|------|------|
| 分类 | B |
| 严重程度 | 🟡 |
| 攻击向量 | 在play/seek消息中注入NaN、Infinity、负数、超大数值等特殊Position值 |
| 测试步骤 | 1. 发送 `{"type":"play","position":NaN}` (JSON中为null或特殊编码)<br>2. 发送 `{"type":"seek","position":-1}`<br>3. 发送 `{"type":"seek","position":999999999}`<br>4. 发送 `{"type":"play","position":1e308}` |
| 预期结果 | `validatePosition`函数检查NaN、Inf、负数、超出duration，返回错误消息。JSON中的NaN不是合法JSON，ReadJSON会失败 |
| 实际风险评估 | 低风险。`validatePosition`覆盖了主要边界情况。但Go的`json.Unmarshal`对`1e308`会解析为合法float64（接近MaxFloat64），如果duration为0则不会被拦截 |
| 应对策略 | 当前防护基本完整。可考虑增加绝对上限（如position不超过24小时=86400秒）作为额外安全网 |

---

## C. 房间管理极端场景

### C-01 房间爆炸：海量房间创建
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🔴 |
| 攻击向量 | 利用 MaxRooms=99999, MaxRoomsPerUser=99999 的放开状态，单用户创建数万房间 |
| 测试步骤 | 1. 以admin角色认证，循环发送 `{"type":"create"}` 消息10000次<br>2. 观察 `manager.rooms` map大小、内存占用<br>3. 创建后不加入任何客户端，观察cleanupLoop是否清理<br>4. 同时用GetRooms()遍历（syncTick每秒调用），测量延迟 |
| 预期结果 | 全部创建成功。每个Room对象含map+RWMutex+多字段，10000个≈数十MB。syncTick遍历所有房间产生显著CPU开销 |
| 实际风险评估 | **高风险**。syncTick每秒遍历所有房间（含空房间），O(n)复杂度。cleanupLoop每5分钟清理不活跃房间，但LastActive在创建时设置，需等30分钟才过期 |
| 应对策略 | **立即恢复** MaxRooms=100, MaxRoomsPerUser=3。syncTick应跳过空房间（已有clientCount>1判断，风险可控） |

### C-02 幽灵客户端：连接断开但未清理
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟡 |
| 攻击向量 | 客户端TCP连接异常断开（如拔网线、kill进程），服务端未感知 |
| 测试步骤 | 1. 客户端加入房间后，用iptables/防火墙直接丢弃该连接的包（模拟网络中断）<br>2. 等待30秒（ReadDeadline超时）<br>3. 检查房间客户端列表是否仍包含该幽灵客户端<br>4. 在超时前，其他用户尝试向该幽灵客户端broadcast |
| 预期结果 | 30秒后ReadJSON超时，主循环break，defer中调用RemoveClient清理。broadcast期间Send()会阻塞在写锁上直到超时 |
| 实际风险评估 | 中风险。30秒窗口内幽灵客户端仍在房间列表中。broadcast中`c.Send()`对幽灵连接会阻塞（TCP缓冲区满后），可能拖慢整个broadcast循环 |
| 应对策略 | Send()应增加写超时（`Conn.SetWriteDeadline`）。broadcast可考虑并发发送或跳过写入失败的客户端 |

### C-03 房主断线后的Host转移竞态
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟡 |
| 攻击向量 | 房主断线瞬间，多个客户端同时操作，触发host转移与消息处理的竞态 |
| 测试步骤 | 1. 房间有房主A + 用户B、C<br>2. A断线，触发RemoveClient → host转移给B<br>3. 在A断线的同一时刻，C发送join请求到同一房间<br>4. 检查host转移后的broadcast与C的join broadcast是否交错 |
| 预期结果 | RemoveClient持有写锁，host转移是原子的。但断线处理中的broadcast（发送hostTransfer）在锁外执行，可能与join的broadcast交错 |
| 实际风险评估 | 中风险。`handleWebSocket`末尾的host转移通知在`RemoveClient`之后逐个Send，期间房间状态可能被其他goroutine修改。用户列表可能不一致 |
| 应对策略 | 将host转移通知的用户列表快照在RemoveClient内部获取，确保一致性 |

### C-04 踢人竞态：被踢用户同时操作
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟡 |
| 攻击向量 | 房主踢人的同时，被踢用户正在发送消息或正在被踢的过程中再次加入 |
| 测试步骤 | 1. 房主发送kick消息踢用户B<br>2. 同一时刻B发送play/seek消息<br>3. kick执行RemoveClientByID后、Conn.Close()前，B的ReadJSON仍在进行<br>4. B在收到kicked消息后立即用同一JWT重新连接并join同一房间 |
| 预期结果 | kick流程：RemoveClientByID(加写锁) → Send(kicked) → Conn.Close()。B的ReadJSON在Close后返回error退出循环 |
| 实际风险评估 | 中风险。kick后B可以立即重新连接加入（无踢出冷却期）。RemoveClientByID和B自己的消息处理在不同goroutine，存在短暂窗口B仍能发送消息 |
| 应对策略 | 增加踢出冷却期（如30秒内禁止被踢用户重新加入同一房间）。kick后的Conn.Close()应确保B的goroutine及时退出 |

### C-05 同用户多连接：去重逻辑边界
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟡 |
| 攻击向量 | 同一用户（相同UID）同时从多个标签页/设备加入同一房间 |
| 测试步骤 | 1. 用户A从浏览器Tab1加入房间，获得clientID_1<br>2. 用户A从Tab2加入同一房间，触发AddClient中的去重逻辑<br>3. 检查Tab1的连接是否被关闭（`go c.Conn.Close()`）<br>4. Tab1的handleWebSocket goroutine是否正确执行清理（defer中的RemoveClient） |
| 预期结果 | AddClient检测到相同UID，删除旧client并`go c.Conn.Close()`。旧连接的goroutine在ReadJSON失败后执行defer清理 |
| 实际风险评估 | 中风险。旧连接的defer会调用RemoveClient(旧clientID)，但此时旧client已被从map中删除，RemoveClient是空操作。但如果旧连接的defer执行时新连接还未完成AddClient，可能删除新client（clientID不同，不会误删） |
| 应对策略 | 当前去重逻辑基本安全。但`go c.Conn.Close()`是异步的，旧连接可能在短暂窗口内仍收到消息。建议先Send关闭通知再Close |

### C-06 房主权限与OwnerID不一致
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟡 |
| 攻击向量 | 房主断线后host转移给普通用户，但play/pause/kick等操作同时检查IsHost和OwnerID |
| 测试步骤 | 1. 用户A（OwnerID）创建房间，用户B加入<br>2. A断线，host转移给B（B.IsHost=true）<br>3. B尝试发送play消息 → `IsHost(clientID)`返回true，但`OwnerID != userID`<br>4. B尝试发送kick消息 → 同样被OwnerID检查拦截 |
| 预期结果 | play/pause/seek/kick/closeRoom都有`OwnerID != userID`检查，即使host转移，非owner也无法操作 |
| 实际风险评估 | 低风险（安全角度）但**高风险（功能角度）**。房主断线后，房间变成无人可控状态——新host有IsHost标记但无操作权限。这是设计缺陷而非安全漏洞 |
| 应对策略 | 需要明确产品设计：host转移后是否应该转移控制权？当前双重检查导致"僵尸房间"。建议owner断线时要么转移OwnerID，要么关闭房间 |

### C-07 房间关闭与客户端操作的竞态
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟡 |
| 攻击向量 | 房主发送closeRoom的同时，其他用户正在join或发送消息 |
| 测试步骤 | 1. 房主发送closeRoom<br>2. 同一时刻用户B通过join消息加入该房间（manager.GetRoom在DeleteRoom之前返回了房间引用）<br>3. closeRoom执行broadcast→Close所有连接→DeleteRoom<br>4. B的join在GetRoom之后、AddClient之前，房间已被删除 |
| 预期结果 | B的GetRoom可能在DeleteRoom之前成功获取房间引用。之后AddClient仍可成功（Room对象仍在内存中），但房间已从manager.rooms中删除 |
| 实际风险评估 | 中风险。存在"幽灵房间"：Room对象存在但不在manager中，无法被cleanupLoop清理，无法被其他人找到。B会卡在一个孤立房间中 |
| 应对策略 | closeRoom应先从manager删除（防止新join），再通知现有客户端。或在Room上增加closed标志，AddClient检查该标志 |

### C-08 cleanupLoop与活跃操作的竞态
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟢 |
| 攻击向量 | cleanupLoop判定房间不活跃并删除时，恰好有用户正在操作该房间 |
| 测试步骤 | 1. 房间30分钟无活动，cleanupLoop开始清理<br>2. cleanupLoop在`m.mu.Lock()`和`delete(m.rooms, code)`之间<br>3. 同一时刻用户发送play消息，通过`currentRoom`引用操作房间<br>4. 房间被删除后，用户的后续操作（如broadcast）仍通过旧引用执行 |
| 预期结果 | cleanupLoop持有manager写锁期间，GetRoom会阻塞。但已持有`currentRoom`引用的goroutine不受影响，可继续操作已删除的房间 |
| 实际风险评估 | 低风险。已删除房间的操作不会crash（Room对象仍有效），但broadcast的消息不会到达新加入的用户（因为房间已不在manager中） |
| 应对策略 | 可接受的竞态窗口。cleanupLoop发送roomClosed通知后客户端会断开。可增加Room.closed标志做额外防护 |

### C-09 大量用户同时加入同一房间
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🔴 |
| 攻击向量 | 利用 MaxClientsPerRoom=99999 的放开状态，数千用户同时加入一个房间 |
| 测试步骤 | 1. 创建一个房间，分享房间码<br>2. 1000个认证用户同时发送join消息<br>3. 房主发送play消息，触发broadcast到1000个客户端<br>4. syncTick每秒向999个非host客户端发送syncTick消息<br>5. 任一用户join/leave触发broadcast（含完整用户列表） |
| 预期结果 | 全部加入成功。broadcast变成O(n)操作，每次play/pause/seek都要向1000个客户端逐个Send |
| 实际风险评估 | **高风险**。broadcast是串行的，1000个客户端×每次Send加锁≈显著延迟。syncTick每秒999次Send。userJoined/userLeft的Users列表包含1000个ClientInfo，每条消息数十KB |
| 应对策略 | **立即恢复** MaxClientsPerRoom=50。broadcast考虑并发化。Users列表在大房间中应分页或省略 |

### C-10 ScheduleDelete与CancelDelete竞态
| 项目 | 内容 |
|------|------|
| 分类 | C |
| 严重程度 | 🟢 |
| 攻击向量 | 房间最后一个用户离开触发ScheduleDelete，30秒内新用户加入触发CancelDelete，两者竞态 |
| 测试步骤 | 1. 房间最后一个用户离开（当前代码中ScheduleDelete被注释为dead code）<br>2. 假设启用ScheduleDelete，29秒时新用户join<br>3. CancelDelete和ScheduleDelete的timer回调同时执行<br>4. timer回调中再次检查ClientCount()==0 |
| 预期结果 | pdMu互斥锁保护timer的创建和取消。timer回调中有二次检查（ClientCount()==0），即使竞态也不会误删有人的房间 |
| 实际风险评估 | 低风险。当前代码中ScheduleDelete未被调用（dead code）。即使启用，二次检查机制提供了安全网 |
| 应对策略 | 当前无风险（未启用）。如果启用，建议在timer回调中也持有manager写锁，确保删除的原子性 |

---

## 汇总

### 风险等级分布

| 等级 | 数量 | 场景编号 |
|------|------|----------|
| 🔴 高 | 4 | B-04, B-05, C-01, C-09 |
| 🟡 中 | 10 | B-02, B-03, B-06, B-08, B-10, C-02, C-03, C-04, C-05, C-06, C-07 |
| 🟢 低 | 6 | B-07, B-09, C-08, C-10 |

### 🔴 需立即修复（TODO限制恢复）

| 参数 | 当前值 | 建议恢复值 | 影响场景 |
|------|--------|-----------|----------|
| `maxWSConnsPerUser` | 9999 | 5 | B-05 |
| `msgRateLimit` | 9999 | 10 | B-04 |
| `pingRateLimit` | 9999 | 5 | B-04 |
| `totalRateLimit` | 9999 | 12 | B-04 |
| `MaxRooms` | 99999 | 100 | C-01 |
| `MaxRoomsPerUser` | 99999 | 3 | C-01 |
| `MaxClientsPerRoom` | 99999 | 50 | C-09 |

### 🟡 架构级改进建议

1. **broadcast并发化**：当前串行Send在大房间中成为瓶颈，建议用goroutine池并发发送
2. **Send写超时**：`Client.Send()`缺少`SetWriteDeadline`，幽灵连接可阻塞broadcast
3. **Room.closed标志**：防止对已删除房间的操作，解决closeRoom/join竞态
4. **踢出冷却期**：被踢用户可立即重新加入，需增加时间窗口限制
5. **Owner断线策略**：当前host转移后新host无操作权限，需明确产品设计
6. **滑动窗口优化**：`checkRate`在高频下产生大量切片分配，建议改用令牌桶算法

-e 

---

# 第四部分：播放控制+数据库+API专项

# ListenTogether 攻防测试场景：播放控制 + 数据库 + API安全

> 生成日期：2026-02-21
> 源码版本：基于 main.go / db.go / handlers.go / audio.go 分析
> 分类：D=播放控制与同步攻防 | E=数据库与存储攻防 | F=API安全攻防
> 严重程度：🔴致命 🟡高危 🟢中危 ⚪低危

---

## D. 播放控制与同步攻防

### D-01 | Seek注入NaN/Infinity导致同步崩溃
- **分类**: D | **严重程度**: 🔴
- **攻击向量**: 通过WebSocket发送 `{"type":"seek","position":NaN}` 或 `Infinity`
- **测试步骤**:
  1. 房主创建房间并加载音轨
  2. 构造WebSocket消息，position字段设为 `NaN`、`Infinity`、`-Infinity`
  3. 发送seek消息，观察服务端及其他客户端行为
- **预期结果**: `validatePosition()` 拦截非法值，返回错误"position 值无效"
- **实际风险评估**: 代码已有 `math.IsNaN` 和 `math.IsInf` 检查（`validatePosition`函数），风险已缓解
- **应对策略**: 当前防护有效；建议增加单元测试覆盖边界值 `±math.MaxFloat64`

### D-02 | 非房主伪造play/pause/seek控制指令
- **分类**: D | **严重程度**: 🟡
- **攻击向量**: 普通成员通过WebSocket发送 `{"type":"play"}` 等控制消息
- **测试步骤**:
  1. 用户A创建房间，用户B加入
  2. 用户B发送play/pause/seek消息
  3. 观察是否被执行
- **预期结果**: 服务端检查 `IsHost(clientID)` 和 `OwnerID != userID`，静默忽略
- **实际风险评估**: 双重校验（host + ownerID），防护充分。但静默忽略无错误反馈，攻击者可能持续尝试
- **应对策略**: 建议对非授权控制消息返回明确错误提示，并记录日志用于审计

### D-03 | Seek到负数或超出音频时长的位置
- **分类**: D | **严重程度**: 🟢
- **攻击向量**: 发送 `{"type":"seek","position":-100}` 或 `position: 999999`
- **测试步骤**:
  1. 房主加载一首3分钟的歌曲
  2. 发送seek position=-100，观察响应
  3. 发送seek position=999999，观察响应
- **预期结果**: `validatePosition` 拒绝负数（"position 不能为负数"）和超时长值（"position 超出音频时长"）
- **实际风险评估**: 已有完整校验。但当 `duration==0`（无音轨时）跳过时长检查，可能允许任意正值
- **应对策略**: 当 duration==0 时也应限制 position 上限或拒绝操作

### D-04 | syncTick位置泄露与时间篡改
- **分类**: D | **严重程度**: 🟢
- **攻击向量**: 监听syncTick广播获取精确播放位置；伪造statusReport中的position制造虚假漂移
- **测试步骤**:
  1. 加入房间，被动监听syncTick消息
  2. 发送statusReport，position设为与服务端差异>400ms的值
  3. 观察服务端是否发送forceResync
- **预期结果**: syncTick仅广播给非host客户端；statusReport漂移>400ms触发forceResync
- **实际风险评估**: syncTick跳过host是正确的。但恶意客户端可通过伪造statusReport反复触发forceResync日志刷屏
- **应对策略**: 对statusReport添加频率限制（如每5秒最多1次）

### D-05 | nextTrack越界索引攻击
- **分类**: D | **严重程度**: 🟡
- **攻击向量**: 发送 `{"type":"nextTrack","trackIndex":-1}` 或超出播放列表长度的索引
- **测试步骤**:
  1. 创建房间，添加3首歌到播放列表
  2. 发送nextTrack，trackIndex分别设为 -1、3、999999、`math.MaxInt`
  3. 观察服务端行为
- **预期结果**: 代码检查 `msg.TrackIndex < 0 || msg.TrackIndex >= len(items)`，拒绝越界
- **实际风险评估**: 边界检查存在且正确。但JSON反序列化时int溢出行为需验证
- **应对策略**: 增加对 trackIndex 的类型和范围的显式校验测试

### D-06 | 高频play/pause切换导致状态混乱
- **分类**: D | **严重程度**: 🟡
- **攻击向量**: 房主快速交替发送play和pause（每秒>10次）
- **测试步骤**:
  1. 房主创建房间，多个用户加入
  2. 自动化脚本每50ms交替发送play/pause
  3. 观察其他客户端的播放状态是否一致
- **预期结果**: 每次操作都广播，客户端应以最后收到的状态为准
- **实际风险评估**: 消息速率限制当前设为9999（测试模式），生产环境恢复为10/s后可缓解。但广播风暴可能影响所有客户端
- **应对策略**: 恢复生产速率限制；考虑对play/pause添加最小间隔（如200ms防抖）

### D-07 | 房间关闭后残留WebSocket连接
- **分类**: D | **严重程度**: 🟢
- **攻击向量**: closeRoom后，已断开的客户端WebSocket未完全清理，尝试继续发送消息
- **测试步骤**:
  1. 创建房间，多用户加入
  2. 房主发送closeRoom
  3. 在closeRoom广播到达前，其他客户端发送play/seek消息
  4. 检查是否有panic或资源泄露
- **预期结果**: closeRoom后所有客户端conn.Close()，后续消息触发ReadJSON错误退出循环
- **实际风险评估**: 竞态窗口很小但存在。`currentRoom`在closeRoom后设为nil，后续消息检查`currentRoom == nil`会跳过
- **应对策略**: 当前设计基本安全；建议添加room级别的"已关闭"标志位

### D-08 | forceTrack/forceResync消息伪造
- **分类**: D | **严重程度**: ⚪
- **攻击向量**: 恶意客户端忽略服务端发送的forceTrack/forceResync纠正消息
- **测试步骤**:
  1. 修改客户端代码，忽略forceTrack和forceResync消息
  2. 持续发送错误trackIndex的statusReport
  3. 观察服务端日志和其他客户端影响
- **预期结果**: 服务端持续发送纠正消息，但不影响其他客户端
- **实际风险评估**: 仅影响恶意客户端自身体验，不影响他人。但会产生大量日志
- **应对策略**: 对同一客户端的连续纠正次数设上限，超限后断开连接

---

## E. 数据库与存储攻防

### E-01 | SQLite并发写入导致数据库锁定
- **分类**: E | **严重程度**: 🔴
- **攻击向量**: 多个用户同时上传文件/修改播放列表，触发SQLite写锁竞争
- **测试步骤**:
  1. 10个并发请求同时调用AddPlaylistItem到同一播放列表
  2. 同时5个用户上传音频文件
  3. 监控是否出现"database is locked"错误
- **预期结果**: `_busy_timeout=5000` 和 WAL模式应处理大部分并发
- **实际风险评估**: WAL模式+5秒busy_timeout可应对中等并发。但极端情况下仍可能超时。`AddPlaylistItem`使用事务内SELECT+INSERT，持锁时间较长
- **应对策略**: 考虑对高频写操作添加应用层队列；监控busy_timeout命中率

### E-02 | 默认管理员密码未修改
- **分类**: E | **严重程度**: 🔴
- **攻击向量**: 利用默认凭据 `admin/admin123` 登录获取owner权限
- **测试步骤**:
  1. 部署新实例，不设置 `OWNER_USERNAME` 和 `OWNER_PASSWORD` 环境变量
  2. 使用 admin/admin123 登录
  3. 验证是否获得owner权限
- **预期结果**: 登录成功，获得完整owner权限
- **实际风险评估**: 🔴极高。`db.go init()` 中硬编码默认密码，日志仅打印"请尽快修改"但无强制措施
- **应对策略**: 首次登录强制修改密码；或生成随机密码打印到日志；禁止默认密码在生产环境使用

### E-03 | 用户删除后音频文件磁盘残留
- **分类**: E | **严重程度**: 🟡
- **攻击向量**: DeleteUser返回文件名列表但调用方可能未清理磁盘文件
- **测试步骤**:
  1. 用户上传多个音频文件
  2. 管理员删除该用户
  3. 检查 `data/library/{userID}/` 目录是否仍存在
- **预期结果**: DeleteUser返回filenames列表，调用方负责删除磁盘文件
- **实际风险评估**: 如果调用方忽略返回值或清理失败，磁盘文件永久残留，造成存储泄露和数据残留
- **应对策略**: 在DeleteUser事务内记录待清理路径到专用表；添加定期清理任务

### E-04 | 播放列表position字段竞态条件
- **分类**: E | **严重程度**: 🟡
- **攻击向量**: 两个请求同时调用AddPlaylistItem，`MAX(position)+1` 可能返回相同值
- **测试步骤**:
  1. 对同一播放列表并发发送10个AddItem请求
  2. 检查playlist_items表中position是否有重复
  3. 验证播放顺序是否正确
- **预期结果**: 事务内SELECT+INSERT应保证原子性
- **实际风险评估**: SQLite串行化写事务可防止此问题，但在高并发下事务重试可能导致性能下降
- **应对策略**: 当前事务设计正确；可考虑使用 `INSERT ... SELECT MAX(position)+1` 单语句替代

---

## E. 数据库与存储攻防（续）

### E-05 | ReorderPlaylistItems注入非法itemID
- **分类**: E | **严重程度**: 🟡
- **攻击向量**: 在reorder请求中包含不属于当前播放列表的itemID
- **测试步骤**:
  1. 创建两个房间A和B，各有播放列表
  2. 在房间A的reorder请求中包含房间B的playlist_item ID
  3. 观察是否修改了房间B的数据
- **预期结果**: SQL条件 `WHERE id=? AND playlist_id=?` 限制只能修改本播放列表的项
- **实际风险评估**: playlist_id校验有效防止跨列表篡改。但注入不存在的ID会静默失败，不报错
- **应对策略**: 验证传入的itemIDs数量与实际播放列表项数一致；对不匹配情况返回错误

### E-06 | 音频文件UUID碰撞
- **分类**: E | **严重程度**: ⚪
- **攻击向量**: UUID v4碰撞导致文件覆盖
- **测试步骤**:
  1. 检查Upload handler中UUID生成逻辑
  2. 验证是否有碰撞检测机制
  3. 模拟UUID重复场景（mock uuid.New）
- **预期结果**: `uuid.New()` 生成v4 UUID，碰撞概率极低
- **实际风险评估**: 理论碰撞概率可忽略（2^122）。但代码未检查目录是否已存在，碰撞时会覆盖
- **应对策略**: 在创建audioDir前检查目录是否存在；数据库filename字段添加UNIQUE约束

### E-07 | bcrypt 72字节密码截断
- **分类**: E | **严重程度**: 🟢
- **攻击向量**: bcrypt只处理前72字节，超长密码的尾部差异被忽略
- **测试步骤**:
  1. 创建用户，密码为73字节长的字符串
  2. 用前72字节相同但第73字节不同的密码登录
  3. 观察是否登录成功
- **预期结果**: `CreateUser` 检查 `len([]byte(password)) > 72` 并拒绝
- **实际风险评估**: 代码已有72字节限制检查，风险已缓解。但 `UpdatePassword` 也有同样检查，一致性良好
- **应对策略**: 当前防护有效；前端也应限制密码长度并提示用户

### E-08 | library_shares自引用共享
- **分类**: E | **严重程度**: ⚪
- **攻击向量**: 尝试将音乐库共享给自己，可能导致查询重复
- **测试步骤**:
  1. 调用Share API，shared_with_uid设为自己的UID
  2. 观察响应
  3. 如果成功，检查GetAccessibleAudioFiles是否返回重复记录
- **预期结果**: handlers.go检查 `target.ID == user.UserID` 并返回"不能共享给自己"
- **实际风险评估**: 已有防护。但检查的是DB内部ID而非UID，逻辑正确（GetUserByUID返回的是完整User对象）
- **应对策略**: 当前防护有效

---

## F. API安全攻防

### F-01 | 路径遍历访问其他用户音频段
- **分类**: F | **严重程度**: 🔴
- **攻击向量**: 构造 `/api/library/segments/../../etc/passwd/audioID/high/seg_000.flac`
- **测试步骤**:
  1. 登录普通用户账号
  2. 请求 `/api/library/segments/..%2F..%2Fetc/audioUUID/high/seg_000.flac`
  3. 尝试 `userID=../../../etc`、`audioID=../../other_user` 等变体
- **预期结果**: `filepath.Base()` 清理每个路径组件；`..` 检测拒绝请求；最终使用DB中的ownerID而非URL参数构建路径
- **实际风险评估**: 三层防护（filepath.Base + 显式..检测 + DB ownerID替代URL参数），路径遍历风险极低
- **应对策略**: 当前防护充分；建议添加集成测试覆盖各种编码变体（%2e%2e、双重编码等）

### F-02 | 未授权用户访问他人音频段文件
- **分类**: F | **严重程度**: 🔴
- **攻击向量**: 已知audioUUID，直接请求其他用户的音频段
- **测试步骤**:
  1. 用户A上传音频，记录audioUUID
  2. 用户B（未被共享）请求 `/api/library/segments/{A_id}/{audioUUID}/high/seg_000.flac`
  3. 观察是否返回403
- **预期结果**: `CanAccessAudioFile` 检查所有权和共享关系；`IsUserInRoomWithAudio` 检查房间权限
- **实际风险评估**: 访问控制完整（owner + share + room三条路径）。但audioUUID可预测性需评估
- **应对策略**: 当前防护有效；UUID v4不可预测，枚举成本极高

### F-03 | 上传伪装音频文件（扩展名欺骗）
- **分类**: F | **严重程度**: 🟡
- **攻击向量**: 将恶意文件（如ELF二进制）重命名为.mp3上传
- **测试步骤**:
  1. 创建一个PHP/EXE文件，重命名为 `malware.mp3`
  2. 通过upload API上传
  3. 观察是否通过验证
- **预期结果**: 扩展名白名单通过，但 `isAudioMagic()` 魔数检测失败，返回"文件内容与音频格式不匹配"
- **实际风险评估**: 双重验证（扩展名+魔数）有效阻止非音频文件。但精心构造的文件（前512字节为合法音频头+后续恶意内容）可绕过
- **应对策略**: 上传后由ffmpeg处理会自然过滤非法内容；可考虑对处理后的文件做二次校验

### F-04 | 50MB上传限制绕过（分块传输）
- **分类**: F | **严重程度**: 🟡
- **攻击向量**: 使用chunked transfer-encoding尝试绕过MaxBytesReader限制
- **测试步骤**:
  1. 构造>50MB的音频文件
  2. 使用chunked编码上传
  3. 使用Content-Length头伪造小文件大小
- **预期结果**: `http.MaxBytesReader` 基于实际读取字节数限制，不受Content-Length影响
- **实际风险评估**: MaxBytesReader正确限制实际读取量。但非upload路由的1MB全局限制（limitedMux）也需验证
- **应对策略**: 当前防护有效；建议压测验证chunked编码场景

### F-05 | WebSocket连接耗尽攻击
- **分类**: F | **严重程度**: 🔴
- **攻击向量**: 单用户创建大量WebSocket连接耗尽服务器资源
- **测试步骤**:
  1. 使用自动化工具对同一用户建立100个WebSocket连接
  2. 观察服务端内存和goroutine数量
  3. 检查 `maxWSConnsPerUser` 限制是否生效
- **预期结果**: `wsTracker` 限制每用户连接数
- **实际风险评估**: 🔴当前 `maxWSConnsPerUser=9999`（测试模式），等同于无限制！生产环境必须恢复为5
- **应对策略**: 立即将 `maxWSConnsPerUser` 恢复为5；添加全局WebSocket连接上限

### F-06 | 消息速率限制处于测试模式
- **分类**: F | **严重程度**: 🔴
- **攻击向量**: 利用当前9999/s的速率限制发送海量消息
- **测试步骤**:
  1. 建立WebSocket连接
  2. 每秒发送1000条消息
  3. 观察是否被限流
- **预期结果**: 当前不会被限流（限制为9999）
- **实际风险评估**: 🔴三个速率限制全部为9999（msgRateLimit/pingRateLimit/totalRateLimit），完全无效
- **应对策略**: 立即恢复生产值：msgRateLimit=10, pingRateLimit=5, totalRateLimit=12

### F-07 | Join房间代码枚举
- **分类**: F | **严重程度**: 🟡
- **攻击向量**: 暴力枚举8位十六进制房间代码（4字节=32位，约43亿种）
- **测试步骤**:
  1. 自动化脚本快速发送join消息，遍历房间代码
  2. 观察joinLimiter是否生效
  3. 计算在速率限制下枚举成功的概率
- **预期结果**: `joinLimiter` 限制每IP 30次/分钟
- **实际风险评估**: 30次/分钟的限制使枚举不可行（43亿/30=1.4亿分钟≈270年）。但限制从5改为30，宽松了6倍
- **应对策略**: 考虑恢复为5次/分钟；对连续失败的IP实施递增惩罚

### F-08 | ffmpeg/ffprobe命令注入
- **分类**: F | **严重程度**: 🔴
- **攻击向量**: 上传文件名以 `-` 开头，被ffmpeg解释为参数
- **测试步骤**:
  1. 上传文件名为 `-i /etc/passwd -f null -` 的音频文件
  2. 观察ffprobe/ffmpeg是否将文件名解释为参数
- **预期结果**: `sanitizeInputPath()` 在 `-` 开头的路径前添加 `./` 前缀
- **实际风险评估**: `sanitizeInputPath` 防护了参数注入。但文件存储时使用UUID作为目录名而非原始文件名，进一步降低风险
- **应对策略**: 当前防护有效；文件名存储为 `original{ext}`，不直接使用用户输入的文件名

### F-09 | DeleteFile的IDOR（不安全直接对象引用）
- **分类**: F | **严重程度**: 🟡
- **攻击向量**: 管理员A尝试删除管理员B的音频文件
- **测试步骤**:
  1. 管理员A上传文件，记录ID=1
  2. 管理员B上传文件，记录ID=2
  3. 管理员A请求 `DELETE /api/library/files/2`
  4. 观察是否成功删除
- **预期结果**: 检查 `af.OwnerID != user.UserID` 返回403"只能删除自己的文件"
- **实际风险评估**: 所有权检查正确。但DeleteFile中先查询再删除存在TOCTOU窗口（极小）
- **应对策略**: 当前防护有效；`DeleteAudioFile` 的SQL也包含 `owner_id=?` 条件，双重保障

### F-10 | 房间内音轨锁定绕过
- **分类**: F | **严重程度**: 🟢
- **攻击向量**: 在房间播放歌曲A时，请求歌曲B的音频段
- **测试步骤**:
  1. 加入房间，当前播放歌曲A
  2. 请求歌曲B的segment文件（通过已知的audioUUID）
  3. 观察是否返回409 Conflict
- **预期结果**: `IsCurrentTrackInRoom` 检查当前曲目，非当前曲目返回409 "Track changed"
- **实际风险评估**: 锁定机制仅对"在房间中但无直接访问权"的用户生效。有共享权限的用户不受此限制（合理设计）
- **应对策略**: 当前设计合理；409状态码帮助客户端正确处理曲目切换

### F-11 | quality参数注入非法值
- **分类**: F | **严重程度**: 🟢
- **攻击向量**: 请求 `/api/library/segments/{id}/{uuid}/../../etc/high/seg.flac`
- **测试步骤**:
  1. 请求quality参数为 `../high`、`lossless/../../../etc`、`LOSSLESS`（大小写）
  2. 观察响应
- **预期结果**: `validQ` 白名单仅允许 lossless/high/medium/low 四个值
- **实际风险评估**: 严格白名单+filepath.Base清理，注入风险极低
- **应对策略**: 当前防护充分

### F-12 | Origin头绕过WebSocket CORS检查
- **分类**: F | **严重程度**: 🟡
- **攻击向量**: 不发送Origin头，或伪造Origin头连接WebSocket
- **测试步骤**:
  1. 不带Origin头发起WebSocket连接（需携带有效JWT）
  2. 带伪造Origin头（如 `https://evil.com`）发起连接
  3. 在未设置ALLOWED_ORIGINS时测试
- **预期结果**: 无Origin时需有效JWT；有ALLOWED_ORIGINS时严格匹配；未设置时宽松模式
- **实际风险评估**: 无Origin+有效JWT的组合允许非浏览器客户端连接（合理）。但ALLOWED_ORIGINS未设置时完全开放，生产环境必须配置
- **应对策略**: 生产环境必须设置ALLOWED_ORIGINS；文档中强调此配置的重要性

### F-13 | 全局1MB请求体限制绕过
- **分类**: F | **严重程度**: 🟢
- **攻击向量**: 对非upload API发送>1MB的请求体
- **测试步骤**:
  1. 向 `/api/library/share` 发送2MB的JSON body
  2. 向 `/api/room/{code}/playlist/reorder` 发送包含百万个itemID的JSON
  3. 观察是否被limitedMux拦截
- **预期结果**: `limitedMux` 对非upload路由设置1MB限制，超限返回错误
- **实际风险评估**: 全局限制有效。但1MB仍可包含大量恶意数据（如reorder中的超长数组）
- **应对策略**: 对特定API添加业务层限制（如reorder最多1000个item）

---

## 汇总统计

| 分类 | 🔴致命 | 🟡高危 | 🟢中危 | ⚪低危 | 合计 |
|------|--------|--------|--------|--------|------|
| D. 播放控制与同步 | 1 | 3 | 3 | 1 | 8 |
| E. 数据库与存储 | 2 | 3 | 1 | 2 | 8 |
| F. API安全 | 4 | 4 | 4 | 0 | 12 |
| **总计** | **7** | **10** | **8** | **3** | **28** |

### 🔴 需立即修复（P0）
1. **F-05/F-06**: WebSocket连接数和消息速率限制处于测试模式（9999），生产环境完全无防护
2. **E-02**: 默认管理员密码 `admin/admin123` 硬编码，无强制修改机制

### 🟡 建议尽快修复（P1）
1. **D-06**: play/pause无防抖，可造成广播风暴
2. **E-01**: SQLite并发写入在高负载下可能锁定
3. **F-07**: join速率限制从5放宽到30，枚举防护减弱
4. **F-12**: 生产环境必须配置ALLOWED_ORIGINS

### 整体评价
代码安全意识较强，路径遍历防护（三层）、播放位置校验（validatePosition）、权限检查（双重验证）等关键防线设计合理。最大风险点是多个安全参数处于测试模式（TODO注释），需在上线前全部恢复。
-e 

---

# 第五部分：前端攻防测试

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
