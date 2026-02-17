package room

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type PlayState int

const (
	StateStopped PlayState = iota
	StatePlaying
	StatePaused
)

type Client struct {
	ID       string
	Username string
	Conn     *websocket.Conn
	IsHost   bool
	JoinedAt time.Time
	UID      int64
}

type ClientInfo struct {
	ClientID string `json:"clientID"`
	Username string `json:"username"`
	UID      int64  `json:"uid"`
	IsHost   bool   `json:"isHost"`
}

type AudioInfo struct {
	Filename     string   `json:"filename"`
	Duration     float64  `json:"duration"`
	SegmentCount int      `json:"segmentCount"`
	SegmentTime  float64  `json:"segmentTime"`
	Segments     []string `json:"segments"`
}

type Room struct {
	Code       string
	Host       *Client
	Clients    map[string]*Client
	Audio        *AudioInfo
	State        PlayState
	Position     float64
	StartTime    time.Time
	LastActive   time.Time
	OwnerID      int64
	OwnerName    string
	CurrentTrack int
	Mu         sync.RWMutex
}

type Manager struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

func NewManager() *Manager {
	m := &Manager{
		rooms: make(map[string]*Room),
	}
	go m.cleanupLoop()
	return m
}

func (m *Manager) CreateRoom(code string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()

	room := &Room{
		Code:       code,
		Clients:    make(map[string]*Client),
		State:      StateStopped,
		LastActive: time.Now(),
	}
	m.rooms[code] = room
	return room
}

func (m *Manager) GetRoom(code string) *Room {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.rooms[code]
}

func (m *Manager) DeleteRoom(code string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rooms, code)
}

// CloseRoomsByOwnerID finds all rooms owned by the given user ID,
// broadcasts a room closed message, and removes them.
// Returns the list of room codes that were closed.
func (m *Manager) CloseRoomsByOwnerID(ownerID int64) []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	var closed []string
	for code, rm := range m.rooms {
		rm.Mu.RLock()
		isOwner := rm.OwnerID == ownerID
		rm.Mu.RUnlock()
		if isOwner {
			// Notify all clients
			rm.Mu.RLock()
			for _, c := range rm.Clients {
				c.Conn.WriteJSON(map[string]interface{}{
					"type":  "roomClosed",
					"error": "房间已被关闭（房主权限变更）",
				})
			}
			rm.Mu.RUnlock()
			delete(m.rooms, code)
			closed = append(closed, code)
		}
	}
	return closed
}

// SendToUserByID sends a message to all WebSocket connections belonging to a user ID.
// Since we don't track user IDs on clients, we match by username.
func (m *Manager) SendToUserByUsername(username string, msg interface{}) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, rm := range m.rooms {
		rm.Mu.RLock()
		for _, c := range rm.Clients {
			if c.Username == username {
				c.Conn.WriteJSON(msg)
			}
		}
		rm.Mu.RUnlock()
	}
}

func (m *Manager) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		m.mu.Lock()
		now := time.Now()
		for code, room := range m.rooms {
			room.Mu.RLock()
			inactive := now.Sub(room.LastActive) > 30*time.Minute
			room.Mu.RUnlock()
			if inactive {
				delete(m.rooms, code)
			}
		}
		m.mu.Unlock()
	}
}

func (r *Room) AddClient(client *Client) {
	r.Mu.Lock()
	defer r.Mu.Unlock()

	r.Clients[client.ID] = client
	if r.Host == nil {
		r.Host = client
		client.IsHost = true
	}
	r.LastActive = time.Now()
}

func (r *Room) RemoveClient(clientID string) bool {
	r.Mu.Lock()
	defer r.Mu.Unlock()

	delete(r.Clients, clientID)
	r.LastActive = time.Now()

	if r.Host != nil && r.Host.ID == clientID {
		r.Host = nil
		for _, c := range r.Clients {
			r.Host = c
			c.IsHost = true
			break
		}
	}

	return len(r.Clients) == 0
}

func (r *Room) GetClients() []*Client {
	r.Mu.RLock()
	defer r.Mu.RUnlock()

	clients := make([]*Client, 0, len(r.Clients))
	for _, c := range r.Clients {
		clients = append(clients, c)
	}
	return clients
}

func (r *Room) ClientCount() int {
	r.Mu.RLock()
	defer r.Mu.RUnlock()
	return len(r.Clients)
}

func (r *Room) SetAudio(audio *AudioInfo) {
	r.Mu.Lock()
	defer r.Mu.Unlock()
	r.Audio = audio
	r.State = StateStopped
	r.Position = 0
	r.LastActive = time.Now()
}

func (r *Room) Play(position float64) {
	r.Mu.Lock()
	defer r.Mu.Unlock()
	r.State = StatePlaying
	r.Position = position
	r.StartTime = time.Now()
	r.LastActive = time.Now()
}

func (r *Room) Pause() float64 {
	r.Mu.Lock()
	defer r.Mu.Unlock()

	if r.State == StatePlaying {
		elapsed := time.Since(r.StartTime).Seconds()
		r.Position += elapsed
	}
	r.State = StatePaused
	r.LastActive = time.Now()
	return r.Position
}

func (r *Room) Seek(position float64) {
	r.Mu.Lock()
	defer r.Mu.Unlock()
	r.Position = position
	if r.State == StatePlaying {
		r.StartTime = time.Now()
	}
	r.LastActive = time.Now()
}

func (r *Room) GetPlaybackState() (PlayState, float64, time.Time) {
	r.Mu.RLock()
	defer r.Mu.RUnlock()
	return r.State, r.Position, r.StartTime
}

func (r *Room) IsHost(clientID string) bool {
	r.Mu.RLock()
	defer r.Mu.RUnlock()
	return r.Host != nil && r.Host.ID == clientID
}

func (r *Room) GetClientList() []ClientInfo {
	r.Mu.RLock()
	defer r.Mu.RUnlock()
	list := make([]ClientInfo, 0, len(r.Clients))
	for _, c := range r.Clients {
		list = append(list, ClientInfo{
			ClientID: c.ID,
			Username: c.Username,
			UID:      c.UID,
			IsHost:   c.IsHost,
		})
	}
	return list
}

func (r *Room) RemoveClientByID(clientID string) *Client {
	r.Mu.Lock()
	defer r.Mu.Unlock()
	c, ok := r.Clients[clientID]
	if !ok {
		return nil
	}
	delete(r.Clients, clientID)
	r.LastActive = time.Now()
	if r.Host != nil && r.Host.ID == clientID {
		r.Host = nil
		for _, cc := range r.Clients {
			r.Host = cc
			cc.IsHost = true
			break
		}
	}
	return c
}
