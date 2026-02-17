# ListenTogether

Real-time synchronized music listening for groups. Share a room code, upload a track, and everyone hears the same beat at the same moment.

## Features

- **Room System** — Create or join rooms with 6-character codes
- **Audio Streaming** — Segmented audio delivery (no full download required)
- **Clock Sync** — NTP-style calibration achieves <30ms sync accuracy
- **Host Controls** — Play, pause, seek — synced across all listeners
- **Local Caching** — Cache API stores segments for reduced bandwidth
- **Responsive UI** — Works on desktop and mobile

## How It Works

1. Host creates a room and uploads an audio file
2. Server transcodes to 128kbps AAC, segments into 5-second chunks
3. Clients join and perform clock calibration (5-round ping-pong)
4. Host controls playback; server broadcasts scheduled start times
5. Clients use Web Audio API to start playback at the precise moment

## Requirements

- Go 1.21+
- ffmpeg (with AAC encoder)

## Quick Start

```bash
# Clone and build
git clone https://github.com/xingzihai/listen-together.git
cd listen-together
go build -o listen-together .

# Run
./listen-together
# Server starts on http://localhost:8080
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `DATA_DIR` | `./data/rooms` | Audio storage directory |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Go Server (:8080)                    │
├─────────────────────────────────────────────────────────┤
│  HTTP: Static files, audio segments, upload endpoint   │
│  WebSocket: Room management, clock sync, playback ctrl │
│  ffmpeg: Audio transcoding (MP3/WAV → AAC segments)    │
└─────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌─────────────────┐
│   Browser (Host)│          │  Browser (Guest)│
│  - Upload audio │          │  - Join room    │
│  - Control play │          │  - Sync listen  │
│  - Web Audio API│          │  - Cache API    │
└─────────────────┘          └─────────────────┘
```

## Sync Protocol

1. Client sends `ping` with local timestamp
2. Server responds `pong` with client timestamp + server timestamp
3. Client calculates RTT and clock offset
4. Repeat 5 rounds, use median for accuracy
5. Re-calibrate every 30 seconds

Play command includes `scheduledAt` (server time + 500ms buffer), allowing all clients to start simultaneously.

## API

### WebSocket Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `create` | → Server | Create new room |
| `join` | → Server | Join existing room |
| `ping` | → Server | Clock sync request |
| `play` | → Server | Start playback (host only) |
| `pause` | → Server | Pause playback (host only) |
| `seek` | → Server | Seek to position (host only) |

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Static files |
| `/api/upload?room=CODE` | POST | Upload audio (multipart) |
| `/api/segments/{room}/{file}` | GET | Fetch audio segment |

## License

MIT
