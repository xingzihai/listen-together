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
