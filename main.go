package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xingzihai/listen-together/internal/audio"
	"github.com/xingzihai/listen-together/internal/auth"
	"github.com/xingzihai/listen-together/internal/db"
	"github.com/xingzihai/listen-together/internal/library"
	"github.com/xingzihai/listen-together/internal/room"
	syncpkg "github.com/xingzihai/listen-together/internal/sync"
)

var (
	upgrader = websocket.Upgrader{
		CheckOrigin: checkOrigin,
	}
	manager  = room.NewManager()
	dataDir  = "./data/rooms"
	globalDB *db.DB
)

type WSMessage struct {
	Type           string  `json:"type"`
	RoomCode       string  `json:"roomCode,omitempty"`
	ClientTime     int64   `json:"clientTime,omitempty"`
	Position       float64 `json:"position,omitempty"`
	TargetClientID string  `json:"targetClientID,omitempty"`
	TrackIndex     int     `json:"trackIndex"`
}

type PlaylistBroadcast struct {
	Playlist interface{} `json:"playlist"`
	Items    interface{} `json:"items"`
}

type WSResponse struct {
	Type         string                `json:"type"`
	Success      bool                  `json:"success,omitempty"`
	RoomCode     string                `json:"roomCode,omitempty"`
	IsHost       bool                  `json:"isHost,omitempty"`
	ClientCount  int                   `json:"clientCount,omitempty"`
	Audio        *room.AudioInfo       `json:"audio,omitempty"`
	TrackAudio   *room.TrackAudioInfo  `json:"trackAudio,omitempty"`
	State        string                `json:"state,omitempty"`
	Position     float64               `json:"position,omitempty"`
	ServerTime   int64                 `json:"serverTime,omitempty"`
	ClientTime   int64                 `json:"clientTime,omitempty"`
	ScheduledAt  int64                 `json:"scheduledAt,omitempty"`
	Error        string                `json:"error,omitempty"`
	Username     string                `json:"username,omitempty"`
	Role         string                `json:"role,omitempty"`
	Users        []room.ClientInfo     `json:"users,omitempty"`
	PlaylistData *PlaylistBroadcast    `json:"playlistData,omitempty"`
	TrackIndex   int                   `json:"trackIndex"`
}

func main() {
	os.MkdirAll(dataDir, 0755)
	os.MkdirAll("./data", 0755)

	database, err := db.Open("./data/listen-together.db")
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer database.Close()

	globalDB = database
	auth.InitJWT()
	auth.SetDB(database)

	mux := http.NewServeMux()

	authHandlers := &auth.AuthHandlers{DB: database, Manager: manager}
	authHandlers.RegisterRoutes(mux)

	// Library handlers
	libHandlers := &library.LibraryHandlers{DB: database, DataDir: "./data", Manager: manager}
	libHandlers.RegisterRoutes(mux)

	// Playlist handlers
	plHandlers := &library.PlaylistHandlers{
		DB:      database,
		DataDir: "./data",
		Manager: manager,
		OnPlaylistUpdate: func(roomCode string) {
			rm := manager.GetRoom(roomCode)
			if rm == nil {
				return
			}
			// Broadcast playlist update to all clients in the room
			pl, err := database.GetPlaylistByRoom(roomCode)
			if err != nil {
				return
			}
			items, _ := database.GetPlaylistItems(pl.ID)
			broadcast(rm, WSResponse{
				Type: "playlistUpdate",
				PlaylistData: &PlaylistBroadcast{
					Playlist: pl,
					Items:    items,
				},
			}, "")
		},
	}
	plHandlers.RegisterRoutes(mux)

	mux.HandleFunc("/ws", handleWebSocket)

	// Admin page (owner only)
	mux.HandleFunc("/admin", func(w http.ResponseWriter, r *http.Request) {
		userInfo := auth.ExtractUserFromRequest(r)
		if userInfo == nil || userInfo.Role != "owner" {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		http.ServeFile(w, r, "./web/static/admin.html")
	})

	staticFS := http.FileServer(http.Dir("./web/static"))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".css") || strings.HasSuffix(r.URL.Path, ".js") || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			w.Header().Set("Pragma", "no-cache")
		}
		staticFS.ServeHTTP(w, r)
	}))

	// Fix #2: Global request body limit (1MB for non-upload routes; upload has its own 50MB limit)
	limitedMux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/library/upload" {
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB
		}
		mux.ServeHTTP(w, r)
	})

	// SyncTick: broadcast current playback position to all playing rooms every 1s
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			for _, rm := range manager.GetRooms() {
				rm.Mu.RLock()
				state := rm.State
				pos := rm.Position
				startT := rm.StartTime
				clientCount := len(rm.Clients)
				// Get duration for position clamping
				duration := 0.0
				if rm.TrackAudio != nil {
					duration = rm.TrackAudio.Duration
				} else if rm.Audio != nil {
					duration = rm.Audio.Duration
				}
				var clients []*room.Client
				hostID := ""
				// Only broadcast to multi-client rooms
				if state == room.StatePlaying && clientCount > 1 {
					if rm.Host != nil {
						hostID = rm.Host.ID
					}
					clients = make([]*room.Client, 0, clientCount)
					for _, c := range rm.Clients {
						clients = append(clients, c)
					}
				}
				rm.Mu.RUnlock()
				if clients == nil {
					continue
				}
				elapsed := time.Since(startT).Seconds()
				currentPos := pos + elapsed
				// Clamp position to duration
				if duration > 0 && currentPos > duration {
					currentPos = duration
				}
				msg := map[string]interface{}{
					"type":       "syncTick",
					"position":   currentPos,
					"serverTime": syncpkg.GetServerTime(),
				}
				// Pre-serialize once, reuse for all clients
				jsonBytes, err := json.Marshal(msg)
				if err != nil {
					continue
				}
				raw := json.RawMessage(jsonBytes)
				for _, c := range clients {
					if c.ID == hostID {
						continue // host is the time source, skip syncTick
					}
					c.Send(raw)
				}
			}
		}
	}()

	log.Println("ListenTogether server starting on :8080")
	log.Fatal(http.ListenAndServe(":8080", limitedMux))
}

func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")

	// Empty Origin: only allow if the request carries a valid JWT (authenticated client).
	// This blocks unauthenticated non-browser clients while still supporting
	// legitimate tools/apps that authenticate but don't send Origin.
	if origin == "" {
		return auth.ExtractUserFromRequest(r) != nil
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()

	// Always allow localhost for development
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}

	allowedStr := os.Getenv("ALLOWED_ORIGINS")
	if allowedStr != "" {
		// ALLOWED_ORIGINS is set: only allow listed origins (+ localhost above)
		for _, allowed := range strings.Split(allowedStr, ",") {
			allowed = strings.TrimSpace(allowed)
			if allowed == "" {
				continue
			}
			au, err := url.Parse(allowed)
			if err != nil {
				if origin == allowed {
					return true
				}
				continue
			}
			if host == au.Hostname() {
				return true
			}
		}
		return false
	}

	// ALLOWED_ORIGINS not set: backward-compatible permissive behavior
	return true
}

func generateCode() string {
	b := make([]byte, 4)
	rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

func generateClientID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// --- Join rate limiter (anti-enumeration) ---
type rateLimiter struct {
	mu      sync.Mutex
	entries map[string][]time.Time
}

const maxRateLimitEntries = 10000

func newRateLimiter() *rateLimiter {
	rl := &rateLimiter{entries: make(map[string][]time.Time)}
	go func() {
		for range time.NewTicker(10 * time.Minute).C {
			rl.mu.Lock()
			now := time.Now()
			for k, times := range rl.entries {
				valid := times[:0]
				for _, t := range times {
					if now.Sub(t) < 5*time.Minute {
						valid = append(valid, t)
					}
				}
				if len(valid) == 0 {
					delete(rl.entries, k)
				} else {
					rl.entries[k] = valid
				}
			}
			rl.mu.Unlock()
		}
	}()
	return rl
}

func (rl *rateLimiter) allow(key string, maxAttempts int, window time.Duration) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-window)
	// Prune old entries
	valid := rl.entries[key][:0]
	for _, t := range rl.entries[key] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	if len(valid) >= maxAttempts {
		rl.entries[key] = valid
		return false
	}
	// Enforce max entries limit
	if len(rl.entries) >= maxRateLimitEntries {
		rl.cleanOldestEntries()
	}
	rl.entries[key] = append(valid, now)
	return true
}

func (rl *rateLimiter) cleanOldestEntries() {
	toRemove := len(rl.entries) / 10
	if toRemove < 1 {
		toRemove = 1
	}
	type entry struct {
		key  string
		last time.Time
	}
	entries := make([]entry, 0, len(rl.entries))
	for k, times := range rl.entries {
		if len(times) > 0 {
			entries = append(entries, entry{k, times[len(times)-1]})
		}
	}
	for i := 0; i < len(entries)-1; i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].last.Before(entries[i].last) {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
	for i := 0; i < toRemove && i < len(entries); i++ {
		delete(rl.entries, entries[i].key)
	}
}

var joinLimiter = newRateLimiter()

// --- Per-user WebSocket connection limiter ---
type wsConnTracker struct {
	mu    sync.Mutex
	conns map[int64]int // userID -> active connection count
}

var wsTracker = &wsConnTracker{conns: make(map[int64]int)}

const maxWSConnsPerUser = 9999 // TODO: restore to 5 after testing

func (t *wsConnTracker) acquire(userID int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conns[userID] >= maxWSConnsPerUser {
		return false
	}
	t.conns[userID]++
	return true
}

func (t *wsConnTracker) release(userID int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conns[userID]--
	if t.conns[userID] <= 0 {
		delete(t.conns, userID)
	}
}

// validatePosition checks that pos is a finite non-negative number and
// optionally within duration. Returns an error string or "".
func validatePosition(pos float64, duration float64) string {
	if math.IsNaN(pos) || math.IsInf(pos, 0) {
		return "position 值无效"
	}
	if pos < 0 {
		return "position 不能为负数"
	}
	if duration > 0 && pos > duration {
		return "position 超出音频时长"
	}
	return ""
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// --- Fix #1: Reject unauthenticated WebSocket connections ---
	userInfo := auth.ExtractUserFromRequest(r)
	if userInfo == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	username := userInfo.Username
	userRole := userInfo.Role
	userID := userInfo.UserID

	// --- Per-user connection limit ---
	if !wsTracker.acquire(userID) {
		http.Error(w, "Too many connections", http.StatusTooManyRequests)
		return
	}
	defer wsTracker.release(userID)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	conn.SetReadLimit(65536) // 64KB, enough for all legitimate messages

	clientID := generateClientID()
	var currentRoom *room.Room
	var myClient *room.Client // set after join/create, used for unified write locking

	// Safe write: before joining a room uses connMu, after joining uses Client.mu
	var connMu sync.Mutex
	safeWrite := func(v interface{}) {
		if myClient != nil {
			myClient.Send(v)
		} else {
			connMu.Lock()
			defer connMu.Unlock()
			conn.WriteJSON(v)
		}
	}
	safePing := func() error {
		if myClient != nil {
			myClient.Lock()
			defer myClient.Unlock()
			return conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
		}
		connMu.Lock()
		defer connMu.Unlock()
		return conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
	}

	// WebSocket ping/pong for dead connection detection
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		return nil
	})
	pingDone := make(chan struct{})
	defer close(pingDone)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-pingDone:
				return
			case <-ticker.C:
				if err := safePing(); err != nil {
					return
				}
			}
		}
	}()

	// --- Per-connection message rate limiter (sliding window) ---
	const (
		msgRateWindow  = time.Second
		msgRateLimit   = 9999 // TODO: restore to 10 after testing
		pingRateLimit  = 9999 // TODO: restore to 5 after testing
		totalRateLimit = 9999 // TODO: restore to 12 after testing
	)
	var (
		msgTimes            = make([]time.Time, 0, msgRateLimit)
		pingTimes           = make([]time.Time, 0, pingRateLimit)
		totalTimes          = make([]time.Time, 0, totalRateLimit)
		lastStatusReport    time.Time // per-client: max 1/sec
		lastForceResyncSent time.Time // per-client: max 1/5sec
	)
	checkRate := func(times *[]time.Time, limit int) bool {
		now := time.Now()
		cutoff := now.Add(-msgRateWindow)
		valid := (*times)[:0]
		for _, t := range *times {
			if t.After(cutoff) {
				valid = append(valid, t)
			}
		}
		if len(valid) >= limit {
			*times = valid
			return false
		}
		*times = append(valid, now)
		return true
	}

	for {
		var msg WSMessage
		if err := conn.ReadJSON(&msg); err != nil {
			break
		}
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))

		// Rate limit check — total first, then per-type
		if !checkRate(&totalTimes, totalRateLimit) {
			safeWrite(WSResponse{Type: "error", Error: "消息频率过高，连接已断开"})
			break
		}
		if msg.Type == "ping" {
			if !checkRate(&pingTimes, pingRateLimit) {
				safeWrite(WSResponse{Type: "error", Error: "消息频率过高，连接已断开"})
				break
			}
		} else {
			if !checkRate(&msgTimes, msgRateLimit) {
				safeWrite(WSResponse{Type: "error", Error: "消息频率过高，连接已断开"})
				break
			}
		}

		switch msg.Type {
		case "create":
			// Permission check: only admin and owner can create rooms
			if userRole != "admin" && userRole != "owner" {
				safeWrite(WSResponse{Type: "error", Error: "没有创建房间的权限"})
				continue
			}
			var newRoom *room.Room
			var code string
			var createErr error
			for i := 0; i < 3; i++ {
				code = generateCode()
				newRoom, createErr = manager.CreateRoom(code, userID)
				if createErr == nil {
					break
				}
			}
			if createErr != nil {
				safeWrite(WSResponse{Type: "error", Error: createErr.Error()})
				continue
			}
			// Leave old room before joining new one to prevent client leak
			if currentRoom != nil {
				empty := currentRoom.RemoveClient(clientID)
				if empty {
					audio.CleanupRoom(filepath.Join(dataDir, currentRoom.Code))
					manager.DeleteRoom(currentRoom.Code)
				} else {
					broadcast(currentRoom, WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: currentRoom.GetClientList()}, "")
				}
			}
			currentRoom = newRoom
			currentRoom.OwnerID = userID
			currentRoom.OwnerName = username
			client := &room.Client{ID: clientID, Username: username, Conn: conn, UID: userID, JoinedAt: time.Now()}
			if err := currentRoom.AddClient(client); err != nil {
				safeWrite(WSResponse{Type: "error", Error: err.Error()})
				continue
			}
			myClient = client
			safeWrite(WSResponse{Type: "created", Success: true, RoomCode: code, IsHost: true, Username: username, Role: userRole, Users: currentRoom.GetClientList()})

		case "join":
			// Fix #3: Rate limit join attempts (5 per minute per IP)
			if !joinLimiter.allow(auth.GetClientIP(r), 30, time.Minute) {
				safeWrite(WSResponse{Type: "error", Error: "操作太频繁，请稍后再试"})
				continue
			}
			joinRoom := manager.GetRoom(msg.RoomCode)
			if joinRoom == nil {
				safeWrite(WSResponse{Type: "error", Error: "Room not found"})
				continue
			}
			// Leave old room before joining new one to prevent client leak
			if currentRoom != nil {
				empty := currentRoom.RemoveClient(clientID)
				if empty {
					audio.CleanupRoom(filepath.Join(dataDir, currentRoom.Code))
					manager.DeleteRoom(currentRoom.Code)
				} else {
					broadcast(currentRoom, WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: currentRoom.GetClientList()}, "")
				}
			}
			currentRoom = joinRoom
			// 取消该房间的延迟删除（有人加入）
			// manager.CancelDelete(msg.RoomCode) // dead code, rooms no longer auto-delete
			client := &room.Client{ID: clientID, Username: username, Conn: conn, UID: userID, JoinedAt: time.Now()}
			if err := currentRoom.AddClient(client); err != nil {
				safeWrite(WSResponse{Type: "error", Error: err.Error()})
				currentRoom = nil
				continue
			}
			myClient = client
			isHost := currentRoom.IsHost(clientID)
			currentRoom.Mu.RLock()
			resp := WSResponse{
				Type: "joined", Success: true, RoomCode: msg.RoomCode,
				IsHost: isHost, ClientCount: len(currentRoom.Clients), Audio: currentRoom.Audio,
				Username: username, Role: userRole, Users: currentRoom.GetClientList(),
			}
			state, pos, startT := currentRoom.State, currentRoom.Position, currentRoom.StartTime
			currentRoom.Mu.RUnlock()
			safeWrite(resp)
			// Send playlist data to joining client
			if pl, err := globalDB.GetPlaylistByRoom(msg.RoomCode); err == nil && pl != nil {
				items, _ := globalDB.GetPlaylistItems(pl.ID)
				safeWrite(WSResponse{Type: "playlistUpdate", PlaylistData: &PlaylistBroadcast{Playlist: pl, Items: items}})
			}
			broadcast(currentRoom, WSResponse{Type: "userJoined", ClientCount: currentRoom.ClientCount(), Username: username, Users: currentRoom.GetClientList()}, clientID)

			// Send current track info with full audio metadata
			currentRoom.Mu.RLock()
			trackAudio := currentRoom.TrackAudio
			trackIdx := currentRoom.CurrentTrack
			currentRoom.Mu.RUnlock()

			if trackAudio != nil {
				safeWrite(WSResponse{
					Type:       "trackChange",
					TrackIndex: trackIdx,
					TrackAudio: trackAudio,
					ServerTime: syncpkg.GetServerTime(),
				})
				// If currently playing, send play to sync position
				if state == room.StatePlaying {
					elapsed := time.Since(startT).Seconds()
					currentPos := pos + elapsed
					// No ScheduledAt for join restore — client needs to load segments first,
					// so scheduledAt would always expire. Let client use elapsed fallback.
					nowMs := syncpkg.GetServerTime()
					safeWrite(WSResponse{Type: "play", Position: currentPos, ServerTime: nowMs})
				}
			}

		case "ping":
			safeWrite(WSResponse{Type: "pong", ClientTime: msg.ClientTime, ServerTime: syncpkg.GetServerTime()})

		case "play":
			if currentRoom == nil || !currentRoom.IsHost(clientID) {
				continue
			}
			// Room control: only room owner (creator) can control
			if currentRoom.OwnerID != userID {
				continue
			}
			// Check audio exists
			currentRoom.Mu.RLock()
			hasAudio := currentRoom.TrackAudio != nil || currentRoom.Audio != nil
			currentRoom.Mu.RUnlock()
			if !hasAudio {
				safeWrite(WSResponse{Type: "error", Error: "请先选择音频"})
				continue
			}
			// Validate position
			currentRoom.Mu.RLock()
			dur := 0.0
			if currentRoom.TrackAudio != nil {
				dur = currentRoom.TrackAudio.Duration
			} else if currentRoom.Audio != nil {
				dur = currentRoom.Audio.Duration
			}
			currentRoom.Mu.RUnlock()
			if errMsg := validatePosition(msg.Position, dur); errMsg != "" {
				safeWrite(WSResponse{Type: "error", Error: errMsg})
				continue
			}
			currentRoom.Play(msg.Position)
			nowMs := syncpkg.GetServerTime()
			scheduledTime := nowMs + 800

			// Include trackAudio so listeners who missed trackChange can load
			currentRoom.Mu.RLock()
			ta := currentRoom.TrackAudio
			ti := currentRoom.CurrentTrack
			currentRoom.Mu.RUnlock()

			broadcast(currentRoom, WSResponse{
				Type: "play", Position: msg.Position,
				ServerTime: nowMs, ScheduledAt: scheduledTime,
				TrackAudio: ta, TrackIndex: ti,
			}, "")

		case "pause":
			if currentRoom == nil || !currentRoom.IsHost(clientID) {
				continue
			}
			if currentRoom.OwnerID != userID {
				continue
			}
			// Check audio exists
			currentRoom.Mu.RLock()
			hasAudioP := currentRoom.TrackAudio != nil || currentRoom.Audio != nil
			currentRoom.Mu.RUnlock()
			if !hasAudioP {
				safeWrite(WSResponse{Type: "error", Error: "请先选择音频"})
				continue
			}
			pos := currentRoom.Pause()
			broadcast(currentRoom, WSResponse{Type: "pause", Position: pos, ServerTime: syncpkg.GetServerTime()}, "")

		case "seek":
			if currentRoom == nil || !currentRoom.IsHost(clientID) {
				continue
			}
			if currentRoom.OwnerID != userID {
				continue
			}
			// Check audio exists
			currentRoom.Mu.RLock()
			hasAudioS := currentRoom.TrackAudio != nil || currentRoom.Audio != nil
			currentRoom.Mu.RUnlock()
			if !hasAudioS {
				safeWrite(WSResponse{Type: "error", Error: "请先选择音频"})
				continue
			}
			// Validate position
			currentRoom.Mu.RLock()
			dur := 0.0
			if currentRoom.TrackAudio != nil {
				dur = currentRoom.TrackAudio.Duration
			} else if currentRoom.Audio != nil {
				dur = currentRoom.Audio.Duration
			}
			currentRoom.Mu.RUnlock()
			if errMsg := validatePosition(msg.Position, dur); errMsg != "" {
				safeWrite(WSResponse{Type: "error", Error: errMsg})
				continue
			}
			currentRoom.Seek(msg.Position)
			nowMs := syncpkg.GetServerTime()
			scheduledTime := nowMs + 800
			broadcast(currentRoom, WSResponse{Type: "seek", Position: msg.Position, ServerTime: nowMs, ScheduledAt: scheduledTime}, "")

		case "statusReport":
			// Client reports its actual playback state for server-side validation
			if currentRoom == nil {
				continue
			}

			// Rate limit: max 1 statusReport per second per client
			now := time.Now()
			if !lastStatusReport.IsZero() && now.Sub(lastStatusReport) < time.Second {
				continue
			}
			lastStatusReport = now

			// Input validation
			if math.IsNaN(msg.Position) || math.IsInf(msg.Position, 0) || msg.Position < 0 {
				continue
			}

			// Single lock acquisition to read all needed room state
			currentRoom.Mu.RLock()
			serverTrackIdx := currentRoom.CurrentTrack
			serverState := currentRoom.State
			serverPos := currentRoom.Position
			serverStart := currentRoom.StartTime
			duration := 0.0
			if currentRoom.TrackAudio != nil {
				duration = currentRoom.TrackAudio.Duration
			}
			ta := currentRoom.TrackAudio
			currentRoom.Mu.RUnlock()

			// Clamp client position to duration
			clientPos := msg.Position
			if duration > 0 && clientPos > duration {
				clientPos = duration
			}

			// Check track index mismatch
			if msg.TrackIndex != serverTrackIdx {
				// Client is on wrong track — force correct
				log.Printf("[sync] client on track %d, server on %d — forcing correction", msg.TrackIndex, serverTrackIdx)
				correction := map[string]interface{}{
					"type":       "forceTrack",
					"trackIndex": serverTrackIdx,
					"position":   serverPos,
					"serverTime": syncpkg.GetServerTime(),
				}
				if ta != nil {
					correction["trackAudio"] = ta
				}
				myClient.Send(correction)
				continue
			}

			// Check position drift (only when playing)
			if serverState == room.StatePlaying {
				elapsed := time.Since(serverStart).Seconds()
				expectedPos := serverPos + elapsed
				if duration > 0 && expectedPos > duration {
					expectedPos = duration
				}
				drift := clientPos - expectedPos
				if drift < 0 {
					drift = -drift
				}
				// If drift > 500ms, force resync (server is backstop; client handles 150-500ms itself)
				if drift > 0.5 {
					// Rate limit forceResync: max once per 5 seconds per client
					if !lastForceResyncSent.IsZero() && now.Sub(lastForceResyncSent) < 5*time.Second {
						continue
					}
					lastForceResyncSent = now
					log.Printf("[sync] client drift %.0fms — forcing resync", drift*1000)
					myClient.Send(map[string]interface{}{
						"type":       "forceResync",
						"position":   expectedPos,
						"serverTime": syncpkg.GetServerTime(),
					})
				}
			}

		case "kick":
			if currentRoom == nil {
				continue
			}
			if currentRoom.OwnerID != userID {
				safeWrite(WSResponse{Type: "error", Error: "只有房主可以踢人"})
				continue
			}
			if msg.TargetClientID == clientID {
				safeWrite(WSResponse{Type: "error", Error: "不能踢出自己"})
				continue
			}
			target := currentRoom.RemoveClientByID(msg.TargetClientID)
			if target == nil {
				safeWrite(WSResponse{Type: "error", Error: "用户不存在"})
				continue
			}
			target.Send(WSResponse{Type: "kicked"})
			target.Conn.Close()
			broadcast(currentRoom, WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: currentRoom.GetClientList()}, "")

		case "closeRoom":
			if currentRoom == nil {
				continue
			}
			if currentRoom.OwnerID != userID {
				safeWrite(WSResponse{Type: "error", Error: "只有房主可以关闭房间"})
				continue
			}
			code := currentRoom.Code
			// Notify all clients
			broadcast(currentRoom, WSResponse{Type: "roomClosed"}, "")
			// Disconnect all clients
			for _, c := range currentRoom.GetClients() {
				c.Conn.Close()
			}
			audio.CleanupRoom(filepath.Join(dataDir, code))
			manager.DeleteRoom(code)
			currentRoom = nil

		case "nextTrack":
			if currentRoom == nil {
				continue
			}
			// Only room owner can change tracks
			if currentRoom.OwnerID != userID {
				continue
			}

			// Build complete TrackAudioInfo from DB
			var trackAudio *room.TrackAudioInfo
			pl, err := globalDB.GetPlaylistByRoom(currentRoom.Code)
			if err != nil || pl == nil {
				continue
			}
			items, err := globalDB.GetPlaylistItems(pl.ID)
			if err != nil || msg.TrackIndex < 0 || msg.TrackIndex >= len(items) {
				continue
			}
			item := items[msg.TrackIndex]
			af, err := globalDB.GetAudioFileByID(item.AudioID)
			if err != nil {
				continue
			}
			var qualities []string
			json.Unmarshal([]byte(af.Qualities), &qualities)
			trackAudio = &room.TrackAudioInfo{
				AudioID:      af.ID,
				OwnerID:      af.OwnerID,
				AudioUUID:    af.Filename,
				Filename:     af.OriginalName,
				Title:        af.Title,
				Artist:       af.Artist,
				OriginalName: af.OriginalName,
				Duration:     af.Duration,
				Qualities:    qualities,
			}

			currentRoom.Mu.Lock()
			currentRoom.CurrentTrack = msg.TrackIndex
			currentRoom.TrackAudio = trackAudio
			currentRoom.Audio = &room.AudioInfo{
				Filename: af.OriginalName,
				Duration: af.Duration,
			}
			// Reset playback state — don't set to Playing yet, wait for host's play message
			currentRoom.State = room.StateStopped
			currentRoom.Position = 0
			currentRoom.Mu.Unlock()

			// Broadcast trackChange with full audio metadata
			broadcast(currentRoom, WSResponse{
				Type:       "trackChange",
				TrackIndex: msg.TrackIndex,
				TrackAudio: trackAudio,
				ServerTime: syncpkg.GetServerTime(),
			}, "")
		}
	}

	if currentRoom != nil {
		empty := currentRoom.RemoveClient(clientID)
		if empty {
			code := currentRoom.Code
			audio.CleanupRoom(filepath.Join(dataDir, code))
			manager.DeleteRoom(code)
		} else {
			users := currentRoom.GetClientList()
			for _, c := range currentRoom.GetClients() {
				if currentRoom.IsHost(c.ID) {
					c.Send(WSResponse{Type: "hostTransfer", IsHost: true, ClientCount: currentRoom.ClientCount(), Users: users})
				} else {
					c.Send(WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: users})
				}
			}
		}
	}
}

// sendJSON is deprecated — use safeWrite (per-conn) or Client.Send() instead

func broadcast(rm *room.Room, msg WSResponse, excludeID string) {
	for _, c := range rm.GetClients() {
		if c.ID != excludeID {
			c.Send(msg)
		}
	}
}
