package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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
		CheckOrigin: func(r *http.Request) bool { return true },
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
	Type         string             `json:"type"`
	Success      bool               `json:"success,omitempty"`
	RoomCode     string             `json:"roomCode,omitempty"`
	IsHost       bool               `json:"isHost,omitempty"`
	ClientCount  int                `json:"clientCount,omitempty"`
	Audio        *room.AudioInfo    `json:"audio,omitempty"`
	State        string             `json:"state,omitempty"`
	Position     float64            `json:"position,omitempty"`
	ServerTime   int64              `json:"serverTime,omitempty"`
	ClientTime   int64              `json:"clientTime,omitempty"`
	ScheduledAt  int64              `json:"scheduledAt,omitempty"`
	Error        string             `json:"error,omitempty"`
	Username     string             `json:"username,omitempty"`
	Role         string             `json:"role,omitempty"`
	Users        []room.ClientInfo  `json:"users,omitempty"`
	PlaylistData *PlaylistBroadcast `json:"playlistData,omitempty"`
	TrackIndex   int                `json:"trackIndex"`
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
	libHandlers := &library.LibraryHandlers{DB: database, DataDir: "./data"}
	libHandlers.RegisterRoutes(mux)

	// Playlist handlers
	plHandlers := &library.PlaylistHandlers{
		DB:      database,
		DataDir: "./data",
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
	mux.HandleFunc("/api/upload", handleUpload)
	mux.HandleFunc("/api/segments/", handleSegments)

	// Admin page (owner only)
	mux.HandleFunc("/admin", func(w http.ResponseWriter, r *http.Request) {
		userInfo := auth.ExtractUserFromRequest(r)
		if userInfo == nil || userInfo.Role != "owner" {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		http.ServeFile(w, r, "./web/static/admin.html")
	})

	mux.Handle("/", http.FileServer(http.Dir("./web/static")))

	log.Println("ListenTogether server starting on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

func generateCode() string {
	b := make([]byte, 3)
	rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

func generateClientID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	userInfo := auth.ExtractUserFromRequest(r)
	username := ""
	userRole := ""
	var userID int64
	if userInfo != nil {
		username = userInfo.Username
		userRole = userInfo.Role
		userID = userInfo.UserID
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	clientID := generateClientID()
	var currentRoom *room.Room

	for {
		var msg WSMessage
		if err := conn.ReadJSON(&msg); err != nil {
			break
		}

		switch msg.Type {
		case "create":
			// Permission check: only admin and owner can create rooms
			if userRole != "admin" && userRole != "owner" {
				sendJSON(conn, WSResponse{Type: "error", Error: "没有创建房间的权限"})
				continue
			}
			code := generateCode()
			currentRoom = manager.CreateRoom(code)
			currentRoom.OwnerID = userID
			currentRoom.OwnerName = username
			client := &room.Client{ID: clientID, Username: username, Conn: conn, UID: userID, JoinedAt: time.Now()}
			currentRoom.AddClient(client)
			sendJSON(conn, WSResponse{Type: "created", Success: true, RoomCode: code, IsHost: true, Username: username, Role: userRole, Users: currentRoom.GetClientList()})

		case "join":
			currentRoom = manager.GetRoom(msg.RoomCode)
			if currentRoom == nil {
				sendJSON(conn, WSResponse{Type: "error", Error: "Room not found"})
				continue
			}
			client := &room.Client{ID: clientID, Username: username, Conn: conn, UID: userID, JoinedAt: time.Now()}
			currentRoom.AddClient(client)
			isHost := currentRoom.IsHost(clientID)
			currentRoom.Mu.RLock()
			resp := WSResponse{
				Type: "joined", Success: true, RoomCode: msg.RoomCode,
				IsHost: isHost, ClientCount: len(currentRoom.Clients), Audio: currentRoom.Audio,
				Username: username, Role: userRole, Users: currentRoom.GetClientList(),
			}
			state, pos, startT := currentRoom.State, currentRoom.Position, currentRoom.StartTime
			currentRoom.Mu.RUnlock()
			sendJSON(conn, resp)
			// Send playlist data to joining client
			if pl, err := globalDB.GetPlaylistByRoom(msg.RoomCode); err == nil && pl != nil {
				items, _ := globalDB.GetPlaylistItems(pl.ID)
				sendJSON(conn, WSResponse{Type: "playlistUpdate", PlaylistData: &PlaylistBroadcast{Playlist: pl, Items: items}})
			}
			broadcast(currentRoom, WSResponse{Type: "userJoined", ClientCount: currentRoom.ClientCount(), Username: username, Users: currentRoom.GetClientList()}, clientID)
			if state == room.StatePlaying && currentRoom.Audio != nil {
				elapsed := time.Since(startT).Seconds()
				currentPos := pos + elapsed
				scheduledTime := syncpkg.GetServerTime() + 500
				sendJSON(conn, WSResponse{Type: "nextTrack", TrackIndex: currentRoom.CurrentTrack, ServerTime: syncpkg.GetServerTime()})
				sendJSON(conn, WSResponse{Type: "play", Position: currentPos, ServerTime: syncpkg.GetServerTime(), ScheduledAt: scheduledTime})
			} else if currentRoom.Audio != nil {
				sendJSON(conn, WSResponse{Type: "nextTrack", TrackIndex: currentRoom.CurrentTrack, ServerTime: syncpkg.GetServerTime()})
			}

		case "ping":
			sendJSON(conn, WSResponse{Type: "pong", ClientTime: msg.ClientTime, ServerTime: syncpkg.GetServerTime()})

		case "play":
			if currentRoom == nil || !currentRoom.IsHost(clientID) {
				continue
			}
			// Room control: only room owner (creator) can control
			if currentRoom.OwnerID != userID {
				continue
			}
			currentRoom.Play(msg.Position)
			scheduledTime := syncpkg.GetServerTime() + 500
			broadcast(currentRoom, WSResponse{Type: "play", Position: msg.Position, ServerTime: syncpkg.GetServerTime(), ScheduledAt: scheduledTime}, "")

		case "pause":
			if currentRoom == nil || !currentRoom.IsHost(clientID) {
				continue
			}
			if currentRoom.OwnerID != userID {
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
			currentRoom.Seek(msg.Position)
			scheduledTime := syncpkg.GetServerTime() + 500
			broadcast(currentRoom, WSResponse{Type: "seek", Position: msg.Position, ServerTime: syncpkg.GetServerTime(), ScheduledAt: scheduledTime}, "")

		case "kick":
			if currentRoom == nil {
				continue
			}
			if currentRoom.OwnerID != userID {
				sendJSON(conn, WSResponse{Type: "error", Error: "只有房主可以踢人"})
				continue
			}
			if msg.TargetClientID == clientID {
				sendJSON(conn, WSResponse{Type: "error", Error: "不能踢出自己"})
				continue
			}
			target := currentRoom.RemoveClientByID(msg.TargetClientID)
			if target == nil {
				sendJSON(conn, WSResponse{Type: "error", Error: "用户不存在"})
				continue
			}
			sendJSON(target.Conn, WSResponse{Type: "kicked"})
			target.Conn.Close()
			broadcast(currentRoom, WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: currentRoom.GetClientList()}, "")

		case "nextTrack":
			if currentRoom == nil {
				continue
			}
			currentRoom.Mu.Lock()
			currentRoom.CurrentTrack = msg.TrackIndex
			currentRoom.State = room.StatePlaying
			currentRoom.Position = 0
			currentRoom.StartTime = time.Now()
			currentRoom.Mu.Unlock()
			broadcast(currentRoom, WSResponse{Type: "nextTrack", TrackIndex: msg.TrackIndex, ServerTime: syncpkg.GetServerTime()}, "")
		}
	}

	if currentRoom != nil {
		empty := currentRoom.RemoveClient(clientID)
		if empty {
			audio.CleanupRoom(filepath.Join(dataDir, currentRoom.Code))
			manager.DeleteRoom(currentRoom.Code)
		} else {
			users := currentRoom.GetClientList()
			for _, c := range currentRoom.GetClients() {
				if currentRoom.IsHost(c.ID) {
					sendJSON(c.Conn, WSResponse{Type: "hostTransfer", IsHost: true, ClientCount: currentRoom.ClientCount(), Users: users})
				} else {
					sendJSON(c.Conn, WSResponse{Type: "userLeft", ClientCount: currentRoom.ClientCount(), Users: users})
				}
			}
		}
	}
}

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	roomCode := r.URL.Query().Get("room")
	rm := manager.GetRoom(roomCode)
	if rm == nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	// Check upload permission: only room owner can upload
	userInfo := auth.ExtractUserFromRequest(r)
	if userInfo == nil || rm.OwnerID != userInfo.UserID {
		http.Error(w, "Forbidden: only room owner can upload", http.StatusForbidden)
		return
	}

	log.Printf("Upload request for room: %s", roomCode)
	r.ParseMultipartForm(100 << 20)
	file, header, err := r.FormFile("audio")
	if err != nil {
		log.Printf("Failed to read file: %v", err)
		http.Error(w, "Failed to read file", http.StatusBadRequest)
		return
	}
	defer file.Close()
	log.Printf("Received file: %s, size: %d", header.Filename, header.Size)

	roomDir := filepath.Join(dataDir, roomCode)
	os.RemoveAll(roomDir)
	os.MkdirAll(roomDir, 0755)

	tmpFile := filepath.Join(roomDir, "input"+filepath.Ext(header.Filename))
	out, _ := os.Create(tmpFile)
	io.Copy(out, file)
	out.Close()

	log.Printf("Processing audio: %s", tmpFile)
	manifest, err := audio.ProcessAudio(tmpFile, roomDir, header.Filename)
	os.Remove(tmpFile)
	if err != nil {
		log.Printf("Audio processing failed: %v", err)
		http.Error(w, fmt.Sprintf("Processing failed: %v", err), http.StatusInternalServerError)
		return
	}
	log.Printf("Audio processed: %d segments, %.1fs duration", manifest.SegmentCount, manifest.Duration)

	audioInfo := &room.AudioInfo{
		Filename: manifest.Filename, Duration: manifest.Duration,
		SegmentCount: manifest.SegmentCount, SegmentTime: manifest.SegmentTime, Segments: manifest.Segments,
	}
	rm.SetAudio(audioInfo)
	broadcast(rm, WSResponse{Type: "audioReady", Audio: audioInfo}, "")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(audioInfo)
}

func handleSegments(w http.ResponseWriter, r *http.Request) {
	// Auth check: must be logged in
	userInfo := auth.ExtractUserFromRequest(r)
	if userInfo == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/segments/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	filePath := filepath.Join(dataDir, parts[0], parts[1])
	w.Header().Set("Cache-Control", "public, max-age=31536000")
	w.Header().Set("Content-Type", "audio/mp4")
	http.ServeFile(w, r, filePath)
}

func sendJSON(conn *websocket.Conn, v interface{}) {
	conn.WriteJSON(v)
}

func broadcast(rm *room.Room, msg WSResponse, excludeID string) {
	for _, c := range rm.GetClients() {
		if c.ID != excludeID {
			c.Conn.WriteJSON(msg)
		}
	}
}
