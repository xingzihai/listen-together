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
