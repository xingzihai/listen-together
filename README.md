# ListenTogether 一起听

实时同步听歌平台。创建房间、上传音乐，所有人在同一时刻听到同一个音符。

## ✨ 功能特性

- **房间系统** — 8位房间码，创建或加入房间即可同步听歌
- **精确同步** — 服务器权威模型 + 三重时钟锚点 + 渐进漂移纠正，同局域网 <15ms
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
- **空闲客户端自动恢复** — 服务端检测未播放客户端并强制同步
- **用户认证** — JWT认证 + 登录限流 + 安全Cookie
- **响应式设计** — 桌面端和移动端自适应

## 🔧 技术栈

- **后端**: Go + Gorilla WebSocket + SQLite
- **前端**: 原生HTML/JS + Tailwind CSS + Web Audio API
- **音频处理**: ffmpeg（转码、分段、元数据提取）
- **同步协议**: 服务器权威模型 + NTP-like三重时钟锚点 + Lookahead调度

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

ListenTogether v0.9.0 使用服务器权威同步模型，实现高精度播放同步：

### 三重时钟锚点

客户端同时校准三个时钟域，消除跨域转换误差：

1. **anchorServerTime** — 服务端时间（ms），NTP-like ping/pong校准
2. **anchorPerfTime** — performance.now()，用于非音频时间计算
3. **anchorCtxTime** — AudioContext.currentTime，用于音频调度

### 服务器权威模型

- 服务端维护唯一真相源：`(position, startTime)`
- 所有 play/seek/forceResync/syncTick 统一使用 `room.StartTime` 作为时间基准
- 客户端通过 `elapsed = clockSync.getServerTime() - startTime` 计算当前位置
- 消除了之前 serverTime 与 StartTime 不一致导致的永久偏差

### Lookahead 调度 + 渐进漂移纠正

| 机制 | 触发条件 | 策略 |
|------|---------|------|
| 渐进纠正 | 每个segment边界（5s） | 调整 _nextSegTime ±30ms，无感知 |
| 硬重置 | 连续3次 >100ms | 客户端请求服务端协调全房间重同步 |
| 空闲恢复 | 客户端未播放 | 服务端检测后发送 forceResync |

### outputLatency 补偿

自动检测设备音频输出延迟（有线/蓝牙），提前调度 segment 播放，确保声音在正确时刻到达耳朵。

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
