# ListenTogether v0.7.0 — 经验教训与进度报告
> 2026-02-20

## 一、今日完成

### 后端
- 音频元数据提取（title/artist/album/cover/genre/year/lyrics）
- 封面API、歌词API
- 用户设置API（GET/PUT /api/user/settings）
- 客户端状态上报（statusReport）+ 服务端校验 + forceTrack/forceResync下发

### 前端
- LRC歌词同步滚动显示
- 两种播放器样式（vinyl唱片机/card卡片）+ 🎨菜单切换
- 布局编辑器（封面/歌词位置、大小、高亮色）
- 动态磨玻璃背景（封面色彩提取 + 音频频谱驱动）
- 精简/展开房间头 + 👥听众管理按钮
- 进度条/音量滑块UI同步
- 同步watchdog + 客户端上报机制

### 运维
- v0.7.0 推送GitHub（exp/overlap-encoding分支）
- ROADMAP.md 竞品调研报告
- r2-file-share skill修正

---

## 二、经验教训

### 🔴 致命级

**1. 不能改的文件一定不能改**
app.js被早期子agent改过（加了updateCoverArt等），导致后续所有子agent都要小心翼翼绕开。应该从一开始就把"不可修改文件"作为铁律写进每个子agent的task里。今天做到了，但代价是之前的改动已经混进去了。

**2. DOM元素ID是隐式API契约**
删掉`audiencePanelClose`和`copyInviteLink`导致app.js报null错，阻断所有后续JS执行。教训：任何被其他文件引用的DOM ID都是API，不能随意删除或重命名。

### 🟡 重要级

**3. 子agent做UI经常不听指令**
多次要求浅色主题，子agent做成深色。原因：模型对"参考lxserver风格"的理解偏差。解决：给子agent的task里必须写死具体CSS值（如`background: #ffffff`），不能只说"浅色"。

**4. let变量跨script标签不可访问**
app.js里`let audioInfo`在inline script里永远是undefined。这是JS作用域的基本规则，但在多文件协作时容易忘。解决：用window全局变量或DOM事件通信。

**5. 同步机制缺少双向校验**
之前只有服务端→客户端的syncTick，客户端播错了服务端完全不知道。今天加了客户端上报，但这个应该从v0.1就有。

**6. inline script拦截WS消息是脆弱的hack**
为了不改app.js，用inline script覆盖ws.onmessage做拦截。这依赖ws变量的可访问性和赋值时序，任何app.js的重构都可能打破它。

### 🟢 建议级

**7. 子agent审查机制有效**
今天的9项审查全部通过，说明"开发→审查→部署"流程是对的。但审查agent和开发agent用同一个模型，可能有盲区。

**8. r2.py路径记错浪费时间**
SKILL.md里写的路径是错的，绕了一大圈才找到正确路径。教训：工具路径变更后必须同步更新所有引用。

---

## 三、当前状态

| 维度 | 状态 |
|------|------|
| 版本 | v0.7.0 |
| 线上 | frp-bar.com:45956 ✅ |
| GitHub | exp/overlap-encoding 已push |
| 同步 | 三级纠正 + watchdog + 客户端上报 + 服务端校验（opus审查中） |
| UI | vinyl/card双样式 + 布局编辑器 + 动态背景 |
| 歌词 | LRC同步滚动 ✅ |
| 安全 | 6个漏洞已修，部分待验证 |

---

## 四、待解决问题

1. **同步审查报告待出**：opus正在逐行审查player.js/sync.js/app.js/main.go的同步逻辑
2. **串台根因未确认**：加了forceTrack兜底，但根因可能在segment加载逻辑
3. **动态背景效果一般**：冰水评价"还可以但比较一般"，后续优化
4. **分支管理混乱**：exp/overlap-encoding积累了大量改动，需要整理后合并master
5. **FLAC体积问题**：比opus大7倍，长期需要优化

---

## 五、下一步（参考ROADMAP.md）

- v0.7.x：根据同步审查报告修复问题 → 实时聊天 → 表情反应 → 安全加固
- v0.8：共享队列 + 投票点歌 + 逐字歌词 + PWA
- v1.0：DJ轮播 + 弹幕 + 跨设备控制
