package auth

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/xingzihai/listen-together/internal/db"
	"golang.org/x/crypto/bcrypt"
)

type contextKey string

const UserContextKey contextKey = "user"

type Claims struct {
	UserID          int64  `json:"user_id"`
	Username        string `json:"username"`
	Role            string `json:"role"`
	PasswordVersion int64  `json:"pw_ver"`
	SessionVersion  int64  `json:"sess_ver"`
	jwt.RegisteredClaims
}

type UserInfo struct {
	UserID   int64
	Username string
	Role     string
}

var jwtSecret []byte

// --- Role Cache ---

type cachedEntry struct {
	Role            string
	PasswordVersion int64
	SessionVersion  int64
	ExpiresAt       time.Time
}

type RoleCache struct {
	mu    sync.RWMutex
	items map[int64]cachedEntry
}

func NewRoleCache() *RoleCache {
	return &RoleCache{items: make(map[int64]cachedEntry)}
}

func (c *RoleCache) Get(userID int64) (role string, pwVer int64, sessVer int64, ok bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, exists := c.items[userID]
	if !exists || time.Now().After(e.ExpiresAt) {
		return "", 0, 0, false
	}
	return e.Role, e.PasswordVersion, e.SessionVersion, true
}

func (c *RoleCache) Set(userID int64, role string, pwVer int64, sessVer int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[userID] = cachedEntry{
		Role:            role,
		PasswordVersion: pwVer,
		SessionVersion:  sessVer,
		ExpiresAt:       time.Now().Add(5 * time.Second),
	}
}

func (c *RoleCache) Invalidate(userID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.items, userID)
}

// Global role cache instance
var GlobalRoleCache = NewRoleCache()

// Database reference for middleware validation
var authDB *db.DB

func SetDB(d *db.DB) {
	authDB = d
}

func InitJWT() {
	// 1. Try JWT_SECRET env var
	if secret := os.Getenv("JWT_SECRET"); secret != "" {
		jwtSecret = []byte(secret)
		log.Printf("[JWT] Secret loaded from environment variable")
		padSecretIfNeeded()
		return
	}

	// 2. Determine data directory (same as SQLite DB location)
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	secretFile := filepath.Join(dataDir, ".jwt_secret")

	// 3. Try reading from persisted file
	if data, err := os.ReadFile(secretFile); err == nil && len(data) > 0 {
		jwtSecret = data
		log.Printf("[JWT] Secret loaded from file: %s", secretFile)
		padSecretIfNeeded()
		return
	}

	// 4. Generate new secret and persist to file
	b := make([]byte, 32)
	rand.Read(b)
	jwtSecret = b

	// Ensure data directory exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Printf("[JWT] WARNING: failed to create data dir %s: %v (secret will not persist)", dataDir, err)
		log.Printf("[JWT] Secret generated (not persisted)")
		return
	}

	// Write secret file with 0600 permissions
	if err := os.WriteFile(secretFile, jwtSecret, 0600); err != nil {
		log.Printf("[JWT] WARNING: failed to write secret file %s: %v (secret will not persist)", secretFile, err)
		log.Printf("[JWT] Secret generated (not persisted)")
		return
	}

	log.Printf("[JWT] Secret generated and persisted to file: %s", secretFile)
}

func padSecretIfNeeded() {
	if len(jwtSecret) < 32 {
		log.Printf("[JWT] WARNING: secret is %d bytes, minimum recommended is 32. Padding with random bytes.", len(jwtSecret))
		pad := make([]byte, 32-len(jwtSecret))
		rand.Read(pad)
		jwtSecret = append(jwtSecret, pad...)
	}
}

func GenerateToken(userID int64, username, role string, pwVersion, sessVersion int64) (string, error) {
	claims := Claims{
		UserID:          userID,
		Username:        username,
		Role:            role,
		PasswordVersion: pwVersion,
		SessionVersion:  sessVersion,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jwtSecret)
}

func ValidateToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		return jwtSecret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, err
	}
	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}
	return nil, jwt.ErrSignatureInvalid
}

// validateClaimsAgainstDB checks role, password_version and session_version against DB/cache.
func validateClaimsAgainstDB(claims *Claims) (string, error) {
	if authDB == nil {
		return claims.Role, nil
	}
	if role, pwVer, sessVer, ok := GlobalRoleCache.Get(claims.UserID); ok {
		if pwVer != claims.PasswordVersion || sessVer != claims.SessionVersion || role != claims.Role {
			return "", jwt.ErrSignatureInvalid
		}
		return role, nil
	}
	role, pwVer, sessVer, err := authDB.GetUserRoleAndVersion(claims.UserID)
	if err != nil {
		return "", jwt.ErrSignatureInvalid
	}
	GlobalRoleCache.Set(claims.UserID, role, pwVer, sessVer)
	if pwVer != claims.PasswordVersion || sessVer != claims.SessionVersion || role != claims.Role {
		return "", jwt.ErrSignatureInvalid
	}
	return role, nil
}

const maxPasswordBytes = 72 // bcrypt silently truncates beyond this

func HashPassword(password string) (string, error) {
	if len([]byte(password)) > maxPasswordBytes {
		return "", fmt.Errorf("password too long (max %d bytes)", maxPasswordBytes)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	return string(hash), err
}

func CheckPassword(hash, password string) bool {
	if len([]byte(password)) > maxPasswordBytes {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// isSecureRequest determines if cookie should have Secure flag
func isSecureRequest(r *http.Request) bool {
	if os.Getenv("SECURE_COOKIE") == "true" {
		return true
	}
	if r != nil && r.Header.Get("X-Forwarded-Proto") == "https" {
		return true
	}
	return false
}

// setTokenCookie sets a secure auth cookie
func setTokenCookie(w http.ResponseWriter, token string) {
	setTokenCookieWithRequest(w, nil, token)
}

// setTokenCookieWithRequest sets cookie with request context for Secure flag
func setTokenCookieWithRequest(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   86400,
	})
}

// tryAutoRenew checks if token needs renewal (< 2h remaining) and issues a new one.
// It fetches the latest role/version from DB to prevent stale privilege in renewed tokens.
func tryAutoRenew(w http.ResponseWriter, r *http.Request, claims *Claims) {
	if claims.ExpiresAt == nil {
		return
	}
	remaining := time.Until(claims.ExpiresAt.Time)
	if remaining > 0 && remaining < 2*time.Hour {
		// Fetch fresh role and versions from DB to avoid renewing with stale privileges
		role, pwVer, sessVer := claims.Role, claims.PasswordVersion, claims.SessionVersion
		if authDB != nil {
			freshRole, freshPwVer, freshSessVer, err := authDB.GetUserRoleAndVersion(claims.UserID)
			if err != nil {
				// DB lookup failed; skip renewal, current request is unaffected
				return
			}
			role, pwVer, sessVer = freshRole, freshPwVer, freshSessVer
			GlobalRoleCache.Set(claims.UserID, role, pwVer, sessVer)
		}
		newToken, err := GenerateToken(claims.UserID, claims.Username, role, pwVer, sessVer)
		if err != nil {
			return
		}
		setTokenCookieWithRequest(w, r, newToken)
	}
}

// AuthMiddleware extracts JWT from cookie or Authorization header
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var tokenStr string
		if cookie, err := r.Cookie("token"); err == nil {
			tokenStr = cookie.Value
		}
		if tokenStr == "" {
			if auth := r.Header.Get("Authorization"); len(auth) > 7 && auth[:7] == "Bearer " {
				tokenStr = auth[7:]
			}
		}
		if tokenStr != "" {
			if claims, err := ValidateToken(tokenStr); err == nil {
				if _, err := validateClaimsAgainstDB(claims); err == nil {
					tryAutoRenew(w, r, claims)
					ctx := context.WithValue(r.Context(), UserContextKey, &UserInfo{
						UserID: claims.UserID, Username: claims.Username, Role: claims.Role,
					})
					r = r.WithContext(ctx)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAuth middleware - returns 401 if not authenticated
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var tokenStr string
		if cookie, err := r.Cookie("token"); err == nil {
			tokenStr = cookie.Value
		}
		if tokenStr == "" {
			if auth := r.Header.Get("Authorization"); len(auth) > 7 && auth[:7] == "Bearer " {
				tokenStr = auth[7:]
			}
		}
		if tokenStr == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		claims, err := ValidateToken(tokenStr)
		if err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if _, err := validateClaimsAgainstDB(claims); err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		tryAutoRenew(w, r, claims)
		ctx := context.WithValue(r.Context(), UserContextKey, &UserInfo{
			UserID: claims.UserID, Username: claims.Username, Role: claims.Role,
		})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func GetUser(r *http.Request) *UserInfo {
	if u, ok := r.Context().Value(UserContextKey).(*UserInfo); ok {
		return u
	}
	return nil
}

// ExtractUserFromRequest extracts user info from request (for WebSocket upgrade)
func ExtractUserFromRequest(r *http.Request) *UserInfo {
	var tokenStr string
	if cookie, err := r.Cookie("token"); err == nil {
		tokenStr = cookie.Value
	}
	if tokenStr == "" {
		if auth := r.Header.Get("Authorization"); len(auth) > 7 && auth[:7] == "Bearer " {
			tokenStr = auth[7:]
		}
	}
	if tokenStr == "" {
		return nil
	}
	claims, err := ValidateToken(tokenStr)
	if err != nil {
		return nil
	}
	if _, err := validateClaimsAgainstDB(claims); err != nil {
		return nil
	}
	return &UserInfo{UserID: claims.UserID, Username: claims.Username, Role: claims.Role}
}
