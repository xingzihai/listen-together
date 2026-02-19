package library

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/xingzihai/listen-together/internal/audio"
	"github.com/xingzihai/listen-together/internal/auth"
	"github.com/xingzihai/listen-together/internal/db"
)

const maxUploadSize = 50 << 20 // 50MB

type LibraryHandlers struct {
	DB      *db.DB
	DataDir string
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (h *LibraryHandlers) requireAdmin(r *http.Request) *auth.UserInfo {
	u := auth.GetUser(r)
	if u == nil || (u.Role != "admin" && u.Role != "owner") {
		return nil
	}
	return u
}

func (h *LibraryHandlers) Upload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := h.requireAdmin(r)
	if user == nil {
		jsonError(w, "forbidden", 403)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		jsonError(w, "文件太大，最大50MB", 400)
		return
	}

	file, header, err := r.FormFile("audio")
	if err != nil {
		jsonError(w, "读取文件失败", 400)
		return
	}
	defer file.Close()

	ext := filepath.Ext(header.Filename)
	audioID := uuid.New().String()
	userDir := filepath.Join(h.DataDir, "library", strconv.FormatInt(user.UserID, 10))
	audioDir := filepath.Join(userDir, audioID)
	os.MkdirAll(audioDir, 0755)
	originalName := "original" + ext
	storedPath := filepath.Join(audioDir, originalName)

	out, err := os.Create(storedPath)
	if err != nil {
		jsonError(w, "保存文件失败", 500)
		return
	}
	written, err := io.Copy(out, file)
	out.Close()
	if err != nil {
		os.RemoveAll(audioDir)
		jsonError(w, "保存文件失败", 500)
		return
	}

	// Multi-quality segmentation
	manifest, probe, err := audio.ProcessAudioMultiQuality(storedPath, audioDir, header.Filename)
	if err != nil {
		os.RemoveAll(audioDir)
		jsonError(w, fmt.Sprintf("音频处理失败: %v", err), 500)
		return
	}

	qualityNames := audio.QualityNames(probe)
	qualitiesJSON, _ := json.Marshal(qualityNames)

	title := strings.TrimSuffix(header.Filename, ext)
	artist := r.FormValue("artist")

	af, err := h.DB.AddAudioFile(user.UserID, audioID, header.Filename, title, artist, manifest.Duration, written, probe.Format, probe.Bitrate, string(qualitiesJSON))
	if err != nil {
		os.RemoveAll(audioDir)
		jsonError(w, "保存记录失败", 500)
		return
	}
	jsonOK(w, af)
}

func getDuration(path string) float64 {
	cmd := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1", path)
	out, err := cmd.Output()
	if err != nil {
		return 0
	}
	d, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return d
}

func (h *LibraryHandlers) ListFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := auth.GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}

	accessible := r.URL.Query().Get("accessible") == "true"
	var files []*db.AudioFile
	var err error
	if accessible {
		files, err = h.DB.GetAccessibleAudioFiles(user.UserID)
	} else {
		files, err = h.DB.GetAudioFilesByOwner(user.UserID)
	}
	if err != nil {
		jsonError(w, "查询失败", 500)
		return
	}
	if files == nil {
		files = []*db.AudioFile{}
	}
	jsonOK(w, files)
}

func (h *LibraryHandlers) DeleteFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := h.requireAdmin(r)
	if user == nil {
		jsonError(w, "forbidden", 403)
		return
	}

	idStr := strings.TrimPrefix(r.URL.Path, "/api/library/files/")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid id", 400)
		return
	}

	af, err := h.DB.GetAudioFileByID(id)
	if err != nil {
		jsonError(w, "文件不存在", 404)
		return
	}
	if af.OwnerID != user.UserID {
		jsonError(w, "只能删除自己的文件", 403)
		return
	}

	if err := h.DB.DeleteAudioFile(id, user.UserID); err != nil {
		jsonError(w, "删除失败", 500)
		return
	}

	diskPath := filepath.Join(h.DataDir, "library", strconv.FormatInt(user.UserID, 10), af.Filename)
	os.RemoveAll(diskPath)

	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *LibraryHandlers) Share(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := h.requireAdmin(r)
	if user == nil {
		jsonError(w, "forbidden", 403)
		return
	}

	var req struct {
		SharedWithUID int64 `json:"shared_with_uid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}

	target, err := h.DB.GetUserByUID(req.SharedWithUID)
	if err != nil {
		jsonError(w, "用户不存在", 404)
		return
	}
	if target.Role != "admin" && target.Role != "owner" {
		jsonError(w, "只能共享给管理员", 400)
		return
	}
	if target.ID == user.UserID {
		jsonError(w, "不能共享给自己", 400)
		return
	}

	if err := h.DB.ShareLibrary(user.UserID, target.ID); err != nil {
		jsonError(w, "共享失败", 500)
		return
	}
	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *LibraryHandlers) Unshare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := h.requireAdmin(r)
	if user == nil {
		jsonError(w, "forbidden", 403)
		return
	}

	uidStr := strings.TrimPrefix(r.URL.Path, "/api/library/share/")
	uid, err := strconv.ParseInt(uidStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid uid", 400)
		return
	}

	target, err := h.DB.GetUserByUID(uid)
	if err != nil {
		jsonError(w, "用户不存在", 404)
		return
	}

	if err := h.DB.UnshareLibrary(user.UserID, target.ID); err != nil {
		jsonError(w, "取消共享失败", 500)
		return
	}
	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *LibraryHandlers) ListShares(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := h.requireAdmin(r)
	if user == nil {
		jsonError(w, "forbidden", 403)
		return
	}

	myShares, _ := h.DB.GetMyShares(user.UserID)
	sharedWithMe, _ := h.DB.GetSharedLibraries(user.UserID)
	if myShares == nil {
		myShares = []*db.LibraryShare{}
	}
	if sharedWithMe == nil {
		sharedWithMe = []*db.LibraryShare{}
	}

	jsonOK(w, map[string]interface{}{
		"my_shares":      myShares,
		"shared_with_me": sharedWithMe,
	})
}

// GetSegments returns the segment list for a specific quality of an audio file.
// GET /api/library/files/{id}/segments/{quality}/
func (h *LibraryHandlers) GetSegments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := auth.GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}

	// Parse: /api/library/files/{id}/segments/{quality}
	path := strings.TrimPrefix(r.URL.Path, "/api/library/files/")
	parts := strings.Split(strings.TrimSuffix(path, "/"), "/")
	if len(parts) < 3 || parts[1] != "segments" {
		jsonError(w, "invalid path", 400)
		return
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		jsonError(w, "invalid id", 400)
		return
	}
	quality := parts[2]

	// Any logged-in user can access segments (needed for room playback sync)

	af, err := h.DB.GetAudioFileByID(id)
	if err != nil {
		jsonError(w, "not found", 404)
		return
	}

	audioDir := filepath.Join(h.DataDir, "library", strconv.FormatInt(af.OwnerID, 10), af.Filename)
	manifestPath := filepath.Join(audioDir, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		jsonError(w, "manifest not found", 404)
		return
	}

	var manifest audio.MultiQualityManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		jsonError(w, "invalid manifest", 500)
		return
	}

	qi, ok := manifest.Qualities[quality]
	if !ok {
		jsonError(w, "quality not available", 404)
		return
	}

	jsonOK(w, map[string]interface{}{
		"quality":      quality,
		"format":       qi.Format,
		"bitrate":      qi.Bitrate,
		"segments":     qi.Segments,
		"duration":     manifest.Duration,
		"segment_time": manifest.SegmentTime,
		"owner_id":     af.OwnerID,
		"audio_uuid":   af.Filename,
	})
}

// ServeSegmentFile serves a segment file.
// GET /api/library/segments/{userID}/{audioID}/{quality}/{filename}
func (h *LibraryHandlers) ServeSegmentFile(w http.ResponseWriter, r *http.Request) {
	user := auth.GetUser(r)
	if user == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Parse: /api/library/segments/{userID}/{audioID}/{quality}/{filename}
	path := strings.TrimPrefix(r.URL.Path, "/api/library/segments/")
	parts := strings.Split(path, "/")
	if len(parts) != 4 {
		http.NotFound(w, r)
		return
	}
	
	// Sanitize all path components
	userID := filepath.Base(parts[0])
	audioID := filepath.Base(parts[1])
	quality := filepath.Base(parts[2])
	filename := filepath.Base(parts[3])

	// Validate quality name
	validQ := map[string]bool{"lossless": true, "high": true, "medium": true, "low": true}
	if !validQ[quality] {
		http.NotFound(w, r)
		return
	}

	// Prevent path traversal - reject any component with .. or /
	for _, comp := range []string{userID, audioID, quality, filename} {
		if strings.Contains(comp, "..") || strings.Contains(comp, "/") || strings.Contains(comp, "\\") {
			http.NotFound(w, r)
			return
		}
	}

	filePath := filepath.Join(h.DataDir, "library", userID, audioID, "segments_"+quality, filename)
	w.Header().Set("Cache-Control", "public, max-age=31536000")
	if quality == "lossless" {
		w.Header().Set("Content-Type", "audio/flac")
	} else {
		w.Header().Set("Content-Type", "audio/mp4")
	}
	http.ServeFile(w, r, filePath)
}

func (h *LibraryHandlers) RegisterRoutes(mux *http.ServeMux) {
	wrap := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			auth.AuthMiddleware(http.HandlerFunc(handler)).ServeHTTP(w, r)
		}
	}

	mux.HandleFunc("/api/library/upload", wrap(h.Upload))
	mux.HandleFunc("/api/library/files", wrap(h.ListFiles))
	mux.HandleFunc("/api/library/segments/", wrap(h.ServeSegmentFile))
	mux.HandleFunc("/api/library/files/", wrap(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.Contains(path, "/segments/") {
			h.GetSegments(w, r)
			return
		}
		h.DeleteFile(w, r)
	}))
	mux.HandleFunc("/api/library/share", wrap(h.Share))
	mux.HandleFunc("/api/library/share/", wrap(h.Unshare))
	mux.HandleFunc("/api/library/shares", wrap(h.ListShares))

	// Serve library page
	mux.HandleFunc("/library", func(w http.ResponseWriter, r *http.Request) {
		userInfo := auth.ExtractUserFromRequest(r)
		if userInfo == nil || (userInfo.Role != "admin" && userInfo.Role != "owner") {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		http.ServeFile(w, r, "./web/static/library.html")
	})
}

// --- Playlist Handlers ---

type PlaylistHandlers struct {
	DB      *db.DB
	DataDir string
	OnPlaylistUpdate func(roomCode string)
}

func (h *PlaylistHandlers) GetOrCreatePlaylist(w http.ResponseWriter, r *http.Request) {
	user := auth.GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}

	code := extractRoomCode(r.URL.Path)
	if code == "" {
		jsonError(w, "invalid room code", 400)
		return
	}

	if r.Method == http.MethodPost {
		// Create or get
		pl, err := h.DB.GetPlaylistByRoom(code)
		if err != nil {
			pl, err = h.DB.CreatePlaylist(code, user.UserID)
			if err != nil {
				jsonError(w, "创建播放列表失败", 500)
				return
			}
		}
		items, _ := h.DB.GetPlaylistItems(pl.ID)
		if items == nil {
			items = []*db.PlaylistItem{}
		}
		jsonOK(w, map[string]interface{}{"playlist": pl, "items": items})
		return
	}

	if r.Method == http.MethodGet {
		pl, err := h.DB.GetPlaylistByRoom(code)
		if err != nil {
			jsonOK(w, map[string]interface{}{"playlist": nil, "items": []interface{}{}})
			return
		}
		items, _ := h.DB.GetPlaylistItems(pl.ID)
		if items == nil {
			items = []*db.PlaylistItem{}
		}
		jsonOK(w, map[string]interface{}{"playlist": pl, "items": items})
		return
	}

	jsonError(w, "method not allowed", 405)
}

func (h *PlaylistHandlers) AddItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := auth.GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}

	code := extractRoomCodeFromAdd(r.URL.Path)

	var req struct {
		AudioID int64 `json:"audio_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}

	// Check access
	canAccess, _ := h.DB.CanAccessAudioFile(user.UserID, req.AudioID)
	if !canAccess {
		jsonError(w, "无权访问该音频文件", 403)
		return
	}

	pl, err := h.DB.GetPlaylistByRoom(code)
	if err != nil {
		pl, err = h.DB.CreatePlaylist(code, user.UserID)
		if err != nil {
			jsonError(w, "创建播放列表失败", 500)
			return
		}
	}

	pos, _ := h.DB.GetNextPlaylistPosition(pl.ID)

	af, err := h.DB.GetAudioFileByID(req.AudioID)
	if err != nil {
		jsonError(w, "音频文件不存在", 404)
		return
	}

	item, err := h.DB.AddPlaylistItem(pl.ID, req.AudioID, pos)
	if err != nil {
		jsonError(w, "添加失败", 500)
		return
	}
	item.Title = af.Title
	item.Artist = af.Artist
	item.Duration = af.Duration
	item.Filename = af.Filename
	item.OriginalName = af.OriginalName

	if h.OnPlaylistUpdate != nil {
		h.OnPlaylistUpdate(code)
	}

	jsonOK(w, item)
}

func (h *PlaylistHandlers) RemoveItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := auth.GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}

	// Path: /api/room/{code}/playlist/{item_id}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/room/"), "/")
	if len(parts) < 3 {
		jsonError(w, "invalid path", 400)
		return
	}
	code := parts[0]
	itemID, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		jsonError(w, "invalid item id", 400)
		return
	}

	pl, err := h.DB.GetPlaylistByRoom(code)
	if err != nil {
		jsonError(w, "播放列表不存在", 404)
		return
	}

	if err := h.DB.RemovePlaylistItem(pl.ID, itemID); err != nil {
		jsonError(w, "删除失败", 500)
		return
	}

	if h.OnPlaylistUpdate != nil {
		h.OnPlaylistUpdate(code)
	}

	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *PlaylistHandlers) UpdateMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := auth.GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}

	// Path: /api/room/{code}/playlist/mode
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/room/"), "/")
	code := parts[0]

	var req struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}
	if req.Mode != "sequential" && req.Mode != "shuffle" && req.Mode != "repeat_one" {
		jsonError(w, "无效的播放模式", 400)
		return
	}

	pl, err := h.DB.GetPlaylistByRoom(code)
	if err != nil {
		jsonError(w, "播放列表不存在", 404)
		return
	}

	if err := h.DB.UpdatePlayMode(pl.ID, req.Mode); err != nil {
		jsonError(w, "更新失败", 500)
		return
	}

	if h.OnPlaylistUpdate != nil {
		h.OnPlaylistUpdate(code)
	}

	jsonOK(w, map[string]string{"message": "ok", "mode": req.Mode})
}

func (h *PlaylistHandlers) Reorder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := auth.GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/room/"), "/")
	code := parts[0]

	var req struct {
		Items []int64 `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}

	pl, err := h.DB.GetPlaylistByRoom(code)
	if err != nil {
		jsonError(w, "播放列表不存在", 404)
		return
	}

	if err := h.DB.ReorderPlaylistItems(pl.ID, req.Items); err != nil {
		jsonError(w, "排序失败", 500)
		return
	}

	if h.OnPlaylistUpdate != nil {
		h.OnPlaylistUpdate(code)
	}

	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *PlaylistHandlers) RegisterRoutes(mux *http.ServeMux) {
	wrap := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			auth.AuthMiddleware(http.HandlerFunc(handler)).ServeHTTP(w, r)
		}
	}

	// We need to handle routing carefully since Go's ServeMux is prefix-based
	mux.HandleFunc("/api/room/", wrap(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// /api/room/{code}/playlist/add
		if strings.HasSuffix(path, "/playlist/add") {
			h.AddItem(w, r)
			return
		}
		// /api/room/{code}/playlist/mode
		if strings.HasSuffix(path, "/playlist/mode") {
			h.UpdateMode(w, r)
			return
		}
		// /api/room/{code}/playlist/reorder
		if strings.HasSuffix(path, "/playlist/reorder") {
			h.Reorder(w, r)
			return
		}
		// /api/room/{code}/playlist/{item_id} (DELETE)
		parts := strings.Split(strings.TrimPrefix(path, "/api/room/"), "/")
		if len(parts) >= 3 && parts[1] == "playlist" {
			if r.Method == http.MethodDelete {
				h.RemoveItem(w, r)
				return
			}
		}
		// /api/room/{code}/playlist (GET/POST)
		if len(parts) >= 2 && parts[1] == "playlist" {
			h.GetOrCreatePlaylist(w, r)
			return
		}
		jsonError(w, "not found", 404)
	}))
}

func extractRoomCode(path string) string {
	// /api/room/{code}/playlist
	parts := strings.Split(strings.TrimPrefix(path, "/api/room/"), "/")
	if len(parts) >= 1 {
		return parts[0]
	}
	return ""
}

func extractRoomCodeFromAdd(path string) string {
	// /api/room/{code}/playlist/add
	parts := strings.Split(strings.TrimPrefix(path, "/api/room/"), "/")
	if len(parts) >= 1 {
		return parts[0]
	}
	return ""
}
