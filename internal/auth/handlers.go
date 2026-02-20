package auth

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xingzihai/listen-together/internal/db"
	"github.com/xingzihai/listen-together/internal/room"
)

var usernameRegex = regexp.MustCompile(`^[a-zA-Z0-9_]{3,20}$`)

type AuthHandlers struct {
	DB      *db.DB
	Manager *room.Manager
}

type authRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

const maxRateLimitEntries = 10000

// --- Rate limiter ---
type rateLimiter struct {
	mu      sync.Mutex
	records map[string][]time.Time
}

var regLimiter = &rateLimiter{records: make(map[string][]time.Time)}
var loginLimiter = &rateLimiter{records: make(map[string][]time.Time)}
var usernameLoginLimiter = &rateLimiter{records: make(map[string][]time.Time)}

func (rl *rateLimiter) allow(ip string, maxCount int, window time.Duration) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-window)
	// Clean old entries
	var valid []time.Time
	for _, t := range rl.records[ip] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	if len(valid) >= maxCount {
		rl.records[ip] = valid
		return false
	}
	// Enforce max entries limit
	if len(rl.records) >= maxRateLimitEntries {
		rl.cleanOldestEntries()
	}
	rl.records[ip] = append(valid, now)
	return true
}

func (rl *rateLimiter) cleanOldestEntries() {
	// Remove 10% of entries (oldest by last access)
	toRemove := len(rl.records) / 10
	if toRemove < 1 {
		toRemove = 1
	}
	type entry struct {
		ip   string
		last time.Time
	}
	entries := make([]entry, 0, len(rl.records))
	for ip, times := range rl.records {
		if len(times) > 0 {
			entries = append(entries, entry{ip, times[len(times)-1]})
		}
	}
	// Sort by oldest last access
	for i := 0; i < len(entries)-1; i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].last.Before(entries[i].last) {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
	for i := 0; i < toRemove && i < len(entries); i++ {
		delete(rl.records, entries[i].ip)
	}
}

// GetClientIP extracts the client IP from the request.
// Only trusts RemoteAddr to prevent X-Forwarded-For spoofing that bypasses rate limiting.
// If behind a trusted reverse proxy, configure TRUSTED_PROXIES env var (comma-separated CIDRs).
func GetClientIP(r *http.Request) string {
	remoteIP, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteIP = r.RemoteAddr
	}

	// If trusted proxies are configured, allow XFF from those sources
	if trusted := os.Getenv("TRUSTED_PROXIES"); trusted != "" {
		for _, proxy := range strings.Split(trusted, ",") {
			if strings.TrimSpace(proxy) == remoteIP {
				if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
					parts := strings.Split(fwd, ",")
					return strings.TrimSpace(parts[0])
				}
			}
		}
	}

	return remoteIP
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

func (h *AuthHandlers) Register(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", 405)
		return
	}
	// Rate limit: 5 per hour per IP
	ip := GetClientIP(r)
	if !regLimiter.allow(ip, 9999, time.Hour) { // TODO: restore to 5 after testing
		jsonError(w, "注册过于频繁，请稍后再试", 429)
		return
	}
	var req authRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}
	if !usernameRegex.MatchString(req.Username) {
		jsonError(w, "用户名需要3-20个字符，只能包含字母、数字和下划线", 400)
		return
	}
	req.Username = strings.ToLower(req.Username)
	if len(req.Password) < 6 {
		jsonError(w, "密码至少6个字符", 400)
		return
	}
	if len([]byte(req.Password)) > 72 {
		jsonError(w, "密码过长（最多72字节）", 400)
		return
	}
	user, err := h.DB.CreateUser(req.Username, req.Password, "user")
	if err != nil {
		jsonError(w, "注册失败，用户名可能已存在", 400)
		return
	}
	token, _ := GenerateToken(user.ID, user.Username, user.Role, user.PasswordVersion, user.SessionVersion)
	setTokenCookieWithRequest(w, r, token)
	jsonOK(w, map[string]interface{}{"user": user})
}

func (h *AuthHandlers) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", 405)
		return
	}
	// Decode request body first (body can only be read once)
	var req authRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}
	// Rate limit: 5 per minute per IP
	ip := GetClientIP(r)
	if !loginLimiter.allow(ip, 9999, time.Minute) { // TODO: restore to 5 after testing
		jsonError(w, "登录尝试过于频繁，请稍后再试", 429)
		return
	}
	// Rate limit: 5 per minute per username (prevents brute force on single account via multiple IPs)
	username := strings.ToLower(req.Username)
	if username != "" && !usernameLoginLimiter.allow(username, 9999, time.Minute) { // TODO: restore to 5 after testing
		jsonError(w, "该账户登录尝试过于频繁，请稍后再试", 429)
		return
	}
	user, err := h.DB.GetUserByUsername(req.Username)
	if err != nil || !CheckPassword(user.PasswordHash, req.Password) {
		jsonError(w, "用户名或密码错误", 401)
		return
	}
	// Don't bump session_version on normal login — it breaks multi-tab usage
	// session_version is only bumped on password change
	sessVer := user.SessionVersion
	GlobalRoleCache.Invalidate(user.ID)
	token, _ := GenerateToken(user.ID, user.Username, user.Role, user.PasswordVersion, sessVer)
	setTokenCookieWithRequest(w, r, token)
	// Check if owner with default password
	needChangePassword := user.Role == "owner" && CheckPassword(user.PasswordHash, "admin123")
	jsonOK(w, map[string]interface{}{"user": user, "needChangePassword": needChangePassword})
}

func (h *AuthHandlers) Logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", 405)
		return
	}
	// Try to extract user from cookie token and invalidate server-side session.
	// Logout route doesn't use AuthMiddleware, so we parse manually.
	// If token is missing/invalid, we still clear the cookie and return ok.
	if cookie, err := r.Cookie("token"); err == nil {
		if claims, err := ValidateToken(cookie.Value); err == nil {
			h.DB.BumpSessionVersion(claims.UserID)
			GlobalRoleCache.Invalidate(claims.UserID)
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name: "token", Value: "", Path: "/",
		HttpOnly: true, Secure: isSecureRequest(r), SameSite: http.SameSiteStrictMode,
		MaxAge: -1, Expires: time.Unix(0, 0),
	})
	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *AuthHandlers) Me(w http.ResponseWriter, r *http.Request) {
	user := GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}
	resp := map[string]interface{}{
		"id": user.UserID, "username": user.Username, "role": user.Role,
	}
	if dbUser, err := h.DB.GetUserByID(user.UserID); err == nil {
		resp["created_at"] = dbUser.CreatedAt
		resp["uid"] = dbUser.UID
		if dbUser.SUID > 0 {
			resp["suid"] = dbUser.SUID
		}
	}
	jsonOK(w, resp)
}

func (h *AuthHandlers) ChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}
	var req authRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}
	if len(req.NewPassword) < 6 {
		jsonError(w, "新密码至少6个字符", 400)
		return
	}
	if len([]byte(req.NewPassword)) > 72 {
		jsonError(w, "新密码过长（最多72字节）", 400)
		return
	}
	dbUser, err := h.DB.GetUserByID(user.UserID)
	if err != nil || !CheckPassword(dbUser.PasswordHash, req.OldPassword) {
		jsonError(w, "原密码错误", 401)
		return
	}
	if err := h.DB.UpdatePassword(user.UserID, req.NewPassword); err != nil {
		jsonError(w, "修改失败", 500)
		return
	}
	// Invalidate cache so old tokens fail on next request
	GlobalRoleCache.Invalidate(user.UserID)
	// Re-fetch user to get new password_version
	updatedUser, err := h.DB.GetUserByID(user.UserID)
	if err != nil {
		jsonError(w, "修改失败", 500)
		return
	}
	token, _ := GenerateToken(user.UserID, user.Username, user.Role, updatedUser.PasswordVersion, updatedUser.SessionVersion)
	setTokenCookieWithRequest(w, r, token)
	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *AuthHandlers) ChangeUsername(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := GetUser(r)
	if user == nil {
		jsonError(w, "unauthorized", 401)
		return
	}
	var req struct {
		NewUsername string `json:"new_username"`
		Password   string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}
	if !usernameRegex.MatchString(req.NewUsername) {
		jsonError(w, "用户名需要3-20个字符，只能包含字母、数字和下划线", 400)
		return
	}
	req.NewUsername = strings.ToLower(req.NewUsername)
	dbUser, err := h.DB.GetUserByID(user.UserID)
	if err != nil || !CheckPassword(dbUser.PasswordHash, req.Password) {
		jsonError(w, "密码错误", 401)
		return
	}
	// Check if new username is taken
	if existing, _ := h.DB.GetUserByUsername(req.NewUsername); existing != nil && existing.ID != user.UserID {
		jsonError(w, "用户名已被占用", 400)
		return
	}
	if err := h.DB.UpdateUsername(user.UserID, req.NewUsername); err != nil {
		jsonError(w, "修改失败", 500)
		return
	}
	GlobalRoleCache.Invalidate(user.UserID)
	token, _ := GenerateToken(user.UserID, req.NewUsername, user.Role, dbUser.PasswordVersion, dbUser.SessionVersion)
	setTokenCookieWithRequest(w, r, token)
	jsonOK(w, map[string]interface{}{"message": "ok", "username": req.NewUsername})
}

// --- Admin APIs (owner only) ---

func (h *AuthHandlers) AdminListUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := GetUser(r)
	if user == nil || user.Role != "owner" {
		jsonError(w, "forbidden", 403)
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	users, total, err := h.DB.ListUsersPaged(page, pageSize)
	if err != nil {
		jsonError(w, "查询失败", 500)
		return
	}
	jsonOK(w, map[string]interface{}{
		"users": users, "total": total, "page": page, "pageSize": pageSize,
	})
}

type roleRequest struct {
	Role string `json:"role"`
}

func (h *AuthHandlers) AdminUpdateRole(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := GetUser(r)
	if user == nil || user.Role != "owner" {
		jsonError(w, "forbidden", 403)
		return
	}
	// Extract UID from path: /api/admin/users/{uid}/role
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/admin/users/"), "/")
	if len(parts) != 2 || parts[1] != "role" {
		jsonError(w, "invalid path", 400)
		return
	}
	targetUID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		jsonError(w, "invalid uid", 400)
		return
	}
	var req roleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}
	if req.Role != "admin" && req.Role != "user" {
		jsonError(w, "角色只能是 admin 或 user", 400)
		return
	}
	target, err := h.DB.GetUserByUID(targetUID)
	if err != nil {
		jsonError(w, "用户不存在", 404)
		return
	}
	if target.Role == "owner" {
		jsonError(w, "不能修改 owner 的角色", 403)
		return
	}
	oldRole := target.Role
	if err := h.DB.UpdateUserRole(target.ID, req.Role); err != nil {
		jsonError(w, "修改失败", 500)
		return
	}
	// Invalidate cache so old tokens with stale role fail
	GlobalRoleCache.Invalidate(target.ID)
	// If admin demoted to user, close their rooms and notify via WebSocket
	if oldRole == "admin" && req.Role == "user" {
		if h.Manager != nil {
			h.Manager.CloseRoomsByOwnerID(target.ID)
			h.Manager.SendToUserByUsername(target.Username, map[string]interface{}{
				"type": "roleChanged",
				"role": "user",
			})
		}
	}
	// If user promoted to admin, notify via WebSocket
	if oldRole == "user" && req.Role == "admin" {
		if h.Manager != nil {
			h.Manager.SendToUserByUsername(target.Username, map[string]interface{}{
				"type": "roleChanged",
				"role": "admin",
			})
		}
	}
	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *AuthHandlers) AdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, "method not allowed", 405)
		return
	}
	user := GetUser(r)
	if user == nil || user.Role != "owner" {
		jsonError(w, "forbidden", 403)
		return
	}
	// Extract UID from path: /api/admin/users/{uid}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/admin/users/")
	targetUID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid uid", 400)
		return
	}
	target, err := h.DB.GetUserByUID(targetUID)
	if err != nil {
		jsonError(w, "用户不存在", 404)
		return
	}
	if target.Role == "owner" {
		jsonError(w, "不能删除 owner", 403)
		return
	}
	if h.Manager != nil {
		h.Manager.CloseRoomsByOwnerID(target.ID)
	}
	deletedFiles, err := h.DB.DeleteUser(target.ID)
	if err != nil {
		jsonError(w, "删除失败", 500)
		return
	}
	// Clean up audio files from disk
	for _, fn := range deletedFiles {
		audioDir := os.Getenv("AUDIO_DIR")
		if audioDir == "" {
			audioDir = "audio_files"
		}
		os.RemoveAll(filepath.Join(audioDir, fn))
	}
	GlobalRoleCache.Invalidate(target.ID)
	jsonOK(w, map[string]string{"message": "ok"})
}

func (h *AuthHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/auth/register", h.Register)
	mux.HandleFunc("/api/auth/login", h.Login)
	mux.HandleFunc("/api/auth/logout", h.Logout)
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		AuthMiddleware(http.HandlerFunc(h.Me)).ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/auth/password", func(w http.ResponseWriter, r *http.Request) {
		AuthMiddleware(http.HandlerFunc(h.ChangePassword)).ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/auth/username", func(w http.ResponseWriter, r *http.Request) {
		AuthMiddleware(http.HandlerFunc(h.ChangeUsername)).ServeHTTP(w, r)
	})
	// Admin routes (owner only)
	mux.HandleFunc("/api/admin/users", func(w http.ResponseWriter, r *http.Request) {
		AuthMiddleware(http.HandlerFunc(h.AdminListUsers)).ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/admin/users/", func(w http.ResponseWriter, r *http.Request) {
		AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Route to update role or delete based on method and path
			if r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/role") {
				h.AdminUpdateRole(w, r)
			} else if r.Method == http.MethodDelete {
				h.AdminDeleteUser(w, r)
			} else {
				jsonError(w, "method not allowed", 405)
			}
		})).ServeHTTP(w, r)
	})
}
