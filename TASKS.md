# ListenTogether v0.7 — 一小时任务表

> 目标：实现实时聊天 + 表情反应，补齐社交基础
> 基线：v0.9.0 + audit fixes (dfa8557)，审查问题已全部修复
> 分支：exp/server-authority-sync

---

## 任务1：实时聊天 — 后端（~15分钟）

### 1.1 WebSocket 消息类型
- [ ] `main.go` WSMessage 新增 `chat` 类型处理
- [ ] 收到 `{"type":"chat","content":"..."}` 后广播给房间内所有人
- [ ] 广播消息附带发送者昵称、UID、时间戳
- [ ] 消息内容长度限制（500字符）
- [ ] 频率限制（每人每秒最多2条，复用现有 rate limiter 框架）

### 1.2 聊天记录内存缓存
- [ ] 每个房间维护最近50条消息的环形缓冲
- [ ] 新用户加入房间时，推送最近消息（`chatHistory` 类型）
- [ ] 房间销毁时自动清理

---

## 任务2：实时聊天 — 前端（~20分钟）

### 2.1 聊天面板 UI
- [ ] `index.html` 新增聊天侧栏（右侧滑出，类似播放列表面板）
- [ ] 底栏新增聊天按钮（💬图标），点击切换侧栏显示
- [ ] 消息列表：昵称（彩色）+ 时间 + 内容，自动滚动到底部
- [ ] 输入框 + 发送按钮，Enter 发送，Shift+Enter 换行
- [ ] 未读消息计数气泡（面板关闭时）

### 2.2 消息处理
- [ ] `app.js` handleMessage 新增 `chat` 和 `chatHistory` 类型处理
- [ ] 发送：`ws.send(JSON.stringify({type:'chat', content: text}))`
- [ ] 接收：渲染到消息列表，XSS 转义（复用现有 escapeHtml）
- [ ] 加入房间时接收 chatHistory 并渲染

---

## 任务3：表情反应（~10分钟）

### 3.1 后端
- [ ] `main.go` 新增 `reaction` 类型处理
- [ ] 收到 `{"type":"reaction","emoji":"🔥"}` 后广播给房间所有人
- [ ] emoji 白名单（限制为预定义的 8-10 个常用 emoji）
- [ ] 频率限制（每人每5秒最多1个反应）

### 3.2 前端
- [ ] 播放器区域下方添加 emoji 反应栏（6-8个常用 emoji 按钮）
- [ ] 点击后发送 reaction 消息
- [ ] 收到 reaction 广播后，在播放器区域显示浮动 emoji 动画（上飘渐隐）
- [ ] CSS 动画：`@keyframes float-up`（1.5s 上飘 + 渐隐）

---

## 任务4：编译验证 + 提交（~10分钟）

- [ ] `go build -o listen-together .` 编译通过
- [ ] 通读前后端改动，确认逻辑自洽
- [ ] 本地启动测试基本功能不回退
- [ ] `git add -A && git commit`

---

## 执行策略

- **并行**：我写后端（任务1.1 + 1.2 + 3.1），同时派 sonnet 子agent 写前端（任务2 + 3.2）
- **子agent 上下文**：提供 app.js 和 index.html 的关键结构、现有 escapeHtml 函数、WebSocket 消息格式
- **合并**：两边完成后合并，任务4 统一验证

---

## 不在本次范围

- 聊天消息持久化（不需要，房间销毁即丢弃）
- 聊天表情包/图片（后续版本）
- @提及功能（后续版本）
- 320k/FLAC 音质选项（下次）
