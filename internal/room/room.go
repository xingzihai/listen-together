package room

import (
	"errors"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Configurable limits
const (
	MaxRooms          = 99999 // TODO: restore to 100 after testing
	MaxRoomsPerUser   = 99999 // TODO: restore to 3 after testing
	MaxClientsPerRoom = 99999 // TODO: restore to 50 after testing
)

var (
	ErrMaxRoomsReached    = errors.New("已达到全局房间上限")
	ErrUserMaxRooms       = errors.New("您已达到创建房间数量上限")
	ErrRoomFull           = errors.New("房间已满，无法加入")
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
	mu       sync.Mutex // protects Conn writes
}

// Send safely writes JSON to the client's WebSocket (gorilla doesn't support concurrent writes)
func (c *Client) Send(v interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Conn.WriteJSON(v)
}

// Lock/Unlock expose the write mutex for WriteControl (ping) calls
func (c *Client) Lock()   { c.mu.Lock() }
func (c *Client) Unlock() { c.mu.Unlock() }

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

// TrackAudioInfo is the complete audio metadata broadcast via trackChange.
// Clients use this directly without needing to fetch the file list API.
type TrackAudioInfo struct {
	AudioID      int64    `json:"audio_id"`
	OwnerID      int64    `json:"owner_id"`
	AudioUUID    string   `json:"audio_uuid"`
	Filename     string   `json:"filename"`
	Title        string   `json:"title"`
	Artist       string   `json:"artist"`
	OriginalName string   `json:"original_name"`
	Duration     float64  `json:"duration"`
	Qualities    []string `json:"qualities"`
}

type Room struct {
	Code       string
	Host       *Client
	Clients    map[string]*Client
	Audio        *AudioInfo
	TrackAudio   *TrackAudioInfo
	State        PlayState
	Position     float64
	StartTime    time.Time
	LastActive   time.Time
	OwnerID      int64
	OwnerName    string
	CurrentTrack   int
	LastResyncTime time.Time // Room-level resync cooldown
	Mu             sync.RWMutex
}

type Manager struct {
	rooms         map[string]*Room
	mu            sync.RWMutex
	pendingDelete map[string]*time.Timer // 延迟删除定时器
	pdMu          sync.Mutex
}

func NewManager() *Manager {
	m := &Manager{
		rooms:         make(map[string]*Room),
		pendingDelete: make(map[string]*time.Timer),
	}
	go m.cleanupLoop()
	return m
}

// ScheduleDelete 延迟删除房间（30秒后执行，期间有人加入则取消）
func (m *Manager) ScheduleDelete(code string, delay time.Duration, onDelete func()) {
	m.pdMu.Lock()
	defer m.pdMu.Unlock()
	// 如果已有定时器，先取消
	if t, ok := m.pendingDelete[code]; ok {
		t.Stop()
	}
	m.pendingDelete[code] = time.AfterFunc(delay, func() {
		m.pdMu.Lock()
		delete(m.pendingDelete, code)
		m.pdMu.Unlock()
		// 再次检查房间是否仍为空
		rm := m.GetRoom(code)
		if rm != nil && rm.ClientCount() == 0 {
			if onDelete != nil {
				onDelete()
			}
			m.DeleteRoom(code)
		}
	})
}

// CancelDelete 取消延迟删除（有人加入时调用）
func (m *Manager) CancelDelete(code string) {
	m.pdMu.Lock()
	defer m.pdMu.Unlock()
	if t, ok := m.pendingDelete[code]; ok {
		t.Stop()
		delete(m.pendingDelete, code)
	}
}

func (m *Manager) CreateRoom(code string, ownerID int64) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Global room limit
	if len(m.rooms) >= MaxRooms {
		return nil, ErrMaxRoomsReached
	}

	// Check for code collision
	if _, exists := m.rooms[code]; exists {
		return nil, errors.New("房间码冲突，请重试")
	}

	// Per-user room limit
	count := 0
	for _, r := range m.rooms {
		r.Mu.RLock()
		if r.OwnerID == ownerID {
			count++
		}
		r.Mu.RUnlock()
	}
	if count >= MaxRoomsPerUser {
		return nil, ErrUserMaxRooms
	}

	room := &Room{
		Code:       code,
		Clients:    make(map[string]*Client),
		State:      StateStopped,
		LastActive: time.Now(),
	}
	m.rooms[code] = room
	return room, nil
}

func (m *Manager) GetRoom(code string) *Room {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.rooms[code]
}

func (m *Manager) GetRooms() []*Room {
	m.mu.RLock()
	defer m.mu.RUnlock()
	rooms := make([]*Room, 0, len(m.rooms))
	for _, r := range m.rooms {
		rooms = append(rooms, r)
	}
	return rooms
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
	type closedRoom struct {
		code    string
		clients []*Client
	}
	var toClose []closedRoom

	m.mu.Lock()
	for code, rm := range m.rooms {
		rm.Mu.RLock()
		isOwner := rm.OwnerID == ownerID
		var clients []*Client
		if isOwner {
			clients = make([]*Client, 0, len(rm.Clients))
			for _, c := range rm.Clients {
				clients = append(clients, c)
			}
		}
		rm.Mu.RUnlock()
		if isOwner {
			toClose = append(toClose, closedRoom{code, clients})
			delete(m.rooms, code)
		}
	}
	m.mu.Unlock()

	var closed []string
	for _, cr := range toClose {
		for _, c := range cr.clients {
			c.Send(map[string]interface{}{
				"type":  "roomClosed",
				"error": "房间已被关闭（房主权限变更）",
			})
		}
		closed = append(closed, cr.code)
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
				c.Send(msg)
			}
		}
		rm.Mu.RUnlock()
	}
}

// IsUserInRoomWithAudio checks if a user is in any room that is currently playing
// the given audio file (by audio_id). Used for segment access control.
func (m *Manager) IsUserInRoomWithAudio(userID int64, audioID int64) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, rm := range m.rooms {
		rm.Mu.RLock()
		ta := rm.TrackAudio
		if ta != nil && ta.AudioID == audioID {
			for _, c := range rm.Clients {
				if c.UID == userID {
					rm.Mu.RUnlock()
					return true
				}
			}
		}
		rm.Mu.RUnlock()
	}
	return false
}

// IsCurrentTrackInRoom checks if audioID is the CURRENT track in the user's room.
func (m *Manager) IsCurrentTrackInRoom(userID int64, audioID int64) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, rm := range m.rooms {
		rm.Mu.RLock()
		inRoom := false
		for _, c := range rm.Clients {
			if c.UID == userID {
				inRoom = true
				break
			}
		}
		if inRoom {
			ta := rm.TrackAudio
			rm.Mu.RUnlock()
			return ta != nil && ta.AudioID == audioID
		}
		rm.Mu.RUnlock()
	}
	return false
}

func (m *Manager) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		// Phase 1: collect inactive rooms under lock
		type closedRoom struct {
			code    string
			clients []*Client
		}
		var toClose []closedRoom

		m.mu.Lock()
		now := time.Now()
		for code, room := range m.rooms {
			room.Mu.RLock()
			inactive := now.Sub(room.LastActive) > 30*time.Minute
			var clients []*Client
			if inactive {
				clients = make([]*Client, 0, len(room.Clients))
				for _, c := range room.Clients {
					clients = append(clients, c)
				}
			}
			room.Mu.RUnlock()
			if inactive {
				toClose = append(toClose, closedRoom{code, clients})
				delete(m.rooms, code)
			}
		}
		m.mu.Unlock()

		// Phase 2: notify clients outside all locks
		for _, cr := range toClose {
			for _, c := range cr.clients {
				c.Send(map[string]interface{}{
					"type":  "roomClosed",
					"error": "房间因长时间不活跃已关闭",
				})
			}
		}
	}
}

func (r *Room) AddClient(client *Client) error {
	r.Mu.Lock()
	defer r.Mu.Unlock()
	if len(r.Clients) >= MaxClientsPerRoom {
		return ErrRoomFull
	}
	// Deduplicate: remove old connection from same user (UID)
	if client.UID != 0 {
		for id, c := range r.Clients {
			if c.UID == client.UID && id != client.ID {
				delete(r.Clients, id)
				go c.Conn.Close() // close old connection in background
				break
			}
		}
	}
	r.Clients[client.ID] = client
	if r.Host == nil {
		r.Host = client
		client.IsHost = true
	}
	// Room owner always gets host
	if r.OwnerID != 0 && client.UID == r.OwnerID {
		if r.Host != nil && r.Host.ID != client.ID {
			r.Host.IsHost = false
		}
		r.Host = client
		client.IsHost = true
	}
	r.LastActive = time.Now()
	return nil
}

func (r *Room) RemoveClient(clientID string) bool {
	r.Mu.Lock()
	defer r.Mu.Unlock()

	// Check if departing client is the owner before removing
	wasOwner := false
	if c, ok := r.Clients[clientID]; ok && r.OwnerID != 0 && c.UID == r.OwnerID {
		wasOwner = true
	}

	delete(r.Clients, clientID)
	r.LastActive = time.Now()

	if r.Host != nil && r.Host.ID == clientID {
		r.Host = nil
		for _, c := range r.Clients {
			r.Host = c
			c.IsHost = true
			// Transfer ownership atomically within the same lock
			if wasOwner {
				r.OwnerID = c.UID
				r.OwnerName = c.Username
			}
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
	seen := make(map[int64]bool)
	list := make([]ClientInfo, 0, len(r.Clients))
	for _, c := range r.Clients {
		if seen[c.UID] {
			continue
		}
		seen[c.UID] = true
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
