# ListenTogether 一起听

实时同步听歌平台。创建房间、上传音乐，所有人在同一时刻听到同一个音符。

## ✨ 功能特性

- **房间系统** — 8位房间码，创建或加入房间即可同步听歌
- **精确同步** — NTP风格时钟校准 + 三级漂移纠正，同步精度 <30ms
- **全质量FLAC** — 所有音质档位均使用FLAC无损编码，无拼接爆音
- **多音质切换** — Lossless / High / Medium / Low 四档音质，按需选择
- **音乐库管理** — 上传、管理、搜索你的音乐收藏
- **播放列表** — 创建和管理播放列表，支持顺序/随机播放
- **LRC歌词同步** — 自动解析内嵌或外挂LRC歌词，逐行滚动显示
- **元数据提取** — 自动读取专辑封面、艺术家、标题等信息
- **双播放器样式** — Vinyl唱片机 / Card卡片两种视觉风格
- **布局编辑器** — 自定义界面布局，拖拽排列组件
- **动态磨玻璃背景** — 基于专辑封面的Glassmorphism视觉效果
- **用户设置同步** — 偏好设置服务端持久化，跨设备同步
- **用户认证** — JWT认证 + 登录限流 + 安全Cookie
- **响应式设计** — 桌面端和移动端自适应

## 🔧 技术栈

- **后端**: Go + Gorilla WebSocket + SQLite
- **前端**: 原生HTML/JS + Tailwind CSS + Web Audio API
- **音频处理**: ffmpeg（转码、分段、元数据提取）
- **同步协议**: 自研NTP-like时钟同步 + 三级漂移纠正

## 🚀 快速开始

### 环境要求

- Go 1.21+
- ffmpeg（需支持FLAC编码）

### 安装运行

```bash
git clone https://github.com/xingzihai/listen-together.git
cd listen-together
go build -o listen-together .
./listen-together
```

服务默认运行在 `http://localhost:8080`

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | HTTP服务端口 |
| `DATA_DIR` | `./data/rooms` | 音频数据存储目录 |
| `AUDIO_DIR` | - | 音频文件目录（可选） |
| `JWT_SECRET` | 随机生成 | JWT签名密钥 |
| `OWNER_USERNAME` | - | 管理员用户名 |
| `OWNER_PASSWORD` | - | 管理员密码 |
| `ALLOWED_ORIGINS` | - | WebSocket允许的Origin列表 |
| `TRUSTED_PROXIES` | - | 可信代理IP（用于获取真实客户端IP） |
| `SECURE_COOKIE` | `false` | 是否启用Secure Cookie（HTTPS环境设为true） |

## 🏗️ 架构

```
┌──────────────────────────────────────────────────────┐
│                  Go Server (:8080)                    │
├──────────────────────────────────────────────────────┤
│  HTTP: 静态文件 / 音频分段 / 上传 / 音乐库API        │
│  WebSocket: 房间管理 / 时钟同步 / 播放控制            │
│  ffmpeg: 音频转码（→ 多质量FLAC分段）                 │
│  SQLite: 用户 / 播放列表 / 设置持久化                 │
└──────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌─────────────────┐
│  浏览器（房主）   │          │  浏览器（听众）   │
│  上传音乐        │          │  加入房间         │
│  控制播放        │          │  同步收听         │
│  Web Audio API  │          │  本地缓存         │
└─────────────────┘          └─────────────────┘
```

## 🎯 同步协议

ListenTogether 使用自研的NTP风格时钟同步协议，实现 <30ms 的播放同步精度：

1. 客户端发送 `ping`（携带本地时间戳）
2. 服务端回复 `pong`（携带客户端时间戳 + 服务端时间戳）
3. 客户端计算RTT和时钟偏移
4. 重复5轮，取中位数确保精度
5. 每30秒重新校准

播放指令包含 `scheduledAt`（服务端时间 + 缓冲），所有客户端在同一时刻开始播放。

### 三级漂移纠正

| 级别 | 偏差范围 | 策略 |
|------|---------|------|
| Tier 1 | 5-50ms | 软纠正：微调下一分段的排列时间 |
| Tier 2 | 50-300ms | 播放速率调整：动态调节 playbackRate ±2-5% |
| Tier 3 | >300ms | 硬重置：重新定位播放位置 |

## 📁 项目结构

```
listen-together/
├── main.go              # 入口：HTTP/WebSocket路由、房间逻辑
├── internal/
│   ├── audio/           # 音频转码、分段、元数据提取
│   ├── auth/            # JWT认证、登录限流、中间件
│   ├── db/              # SQLite数据库、播放列表管理
│   ├── library/         # 音乐库管理
│   ├── room/            # 房间状态管理
│   └── sync/            # 时钟同步算法
├── web/static/          # 前端静态文件
│   ├── index.html       # 主页面（播放器、房间、歌词）
│   ├── library.html     # 音乐库页面
│   ├── admin.html       # 管理后台
│   ├── js/              # JavaScript模块
│   └── css/             # 样式文件
└── data/                # 运行时数据（音频、数据库）
```

## 📄 开源协议

[MIT License](LICENSE)
