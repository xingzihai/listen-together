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

