package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
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
	ExpiresAt       time.Time
}

type RoleCache struct {
	mu    sync.RWMutex
	items map[int64]cachedEntry
}

func NewRoleCache() *RoleCache {
	return &RoleCache{items: make(map[int64]cachedEntry)}
}

func (c *RoleCache) Get(userID int64) (role string, pwVer int64, ok bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, exists := c.items[userID]
	if !exists || time.Now().After(e.ExpiresAt) {
		return "", 0, false
	}
	return e.Role, e.PasswordVersion, true
}

func (c *RoleCache) Set(userID int64, role string, pwVer int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[userID] = cachedEntry{
		Role:            role,
		PasswordVersion: pwVer,
		ExpiresAt:       time.Now().Add(30 * time.Second),
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
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		b := make([]byte, 32)
		rand.Read(b)
		secret = hex.EncodeToString(b)
		log.Printf("JWT_SECRET not set, generated random secret")
	}
	jwtSecret = []byte(secret)
	// Warn and pad if secret is too short
	if len(jwtSecret) < 32 {
		log.Printf("WARNING: JWT_SECRET is %d bytes, minimum recommended is 32. Padding with random bytes.", len(jwtSecret))
		pad := make([]byte, 32-len(jwtSecret))
		rand.Read(pad)
		jwtSecret = append(jwtSecret, pad...)
	}
}

func GenerateToken(userID int64, username, role string, pwVersion int64) (string, error) {
	claims := Claims{
		UserID:          userID,
		Username:        username,
		Role:            role,
		PasswordVersion: pwVersion,
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

// validateClaimsAgainstDB checks role and password_version against DB/cache.
// Returns the current DB role (which may differ from claims) or error.
func validateClaimsAgainstDB(claims *Claims) (string, error) {
	if authDB == nil {
		return claims.Role, nil
	}
	// Check cache first
	if role, pwVer, ok := GlobalRoleCache.Get(claims.UserID); ok {
		if pwVer != claims.PasswordVersion || role != claims.Role {
			return "", jwt.ErrSignatureInvalid
		}
		return role, nil
	}
	// Cache miss — query DB
	role, pwVer, err := authDB.GetUserRoleAndVersion(claims.UserID)
	if err != nil {
		// User deleted or DB error
		return "", jwt.ErrSignatureInvalid
	}
	GlobalRoleCache.Set(claims.UserID, role, pwVer)
	if pwVer != claims.PasswordVersion || role != claims.Role {
		return "", jwt.ErrSignatureInvalid
	}
	return role, nil
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	return string(hash), err
}

func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// setTokenCookie sets a secure auth cookie
func setTokenCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   86400,
	})
}

// tryAutoRenew checks if token needs renewal (< 2h remaining) and issues a new one
func tryAutoRenew(w http.ResponseWriter, claims *Claims) {
	if claims.ExpiresAt == nil {
		return
	}
	remaining := time.Until(claims.ExpiresAt.Time)
	if remaining > 0 && remaining < 2*time.Hour {
		newToken, err := GenerateToken(claims.UserID, claims.Username, claims.Role, claims.PasswordVersion)
		if err != nil {
			return
		}
		setTokenCookie(w, newToken)
		w.Header().Set("X-New-Token", newToken)
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
					tryAutoRenew(w, claims)
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
