package db

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/bcrypt"
)

// AudioFile represents a file in a user's audio library
type AudioFile struct {
	ID              int64     `json:"id"`
	OwnerID         int64     `json:"owner_id"`
	Filename        string    `json:"filename"`
	OriginalName    string    `json:"original_name"`
	Title           string    `json:"title"`
	Artist          string    `json:"artist"`
	Duration        float64   `json:"duration"`
	Size            int64     `json:"size"`
	OriginalFormat  string    `json:"original_format"`
	OriginalBitrate int       `json:"original_bitrate"`
	Qualities       string    `json:"qualities"`
	CreatedAt       time.Time `json:"created_at"`
	OwnerName       string    `json:"owner_name,omitempty"`
}

// LibraryShare represents a library sharing relationship
type LibraryShare struct {
	ID           int64     `json:"id"`
	OwnerID      int64     `json:"owner_id"`
	SharedWithID int64     `json:"shared_with_id"`
	CreatedAt    time.Time `json:"created_at"`
	OwnerName    string    `json:"owner_name,omitempty"`
	SharedName   string    `json:"shared_name,omitempty"`
	OwnerUID     int64     `json:"owner_uid,omitempty"`
	SharedUID    int64     `json:"shared_uid,omitempty"`
}

// Playlist represents a room's playlist
type Playlist struct {
	ID           int64     `json:"id"`
	RoomCode     string    `json:"room_code"`
	CreatedBy    int64     `json:"created_by"`
	PlayMode     string    `json:"play_mode"`
	CurrentIndex int       `json:"current_index"`
	CreatedAt    time.Time `json:"created_at"`
}

// PlaylistItem represents an item in a playlist with audio info
type PlaylistItem struct {
	ID       int64  `json:"id"`
	PlaylistID int64 `json:"playlist_id"`
	AudioID  int64  `json:"audio_id"`
	Position int    `json:"position"`
	// Joined from audio_files
	Title        string  `json:"title"`
	Artist       string  `json:"artist"`
	Duration     float64 `json:"duration"`
	Filename     string  `json:"filename"`
	OriginalName string  `json:"original_name"`
	OwnerID      int64   `json:"owner_id"`
	Qualities    string  `json:"qualities"`
}

type User struct {
	ID              int64     `json:"id"`
	UID             int64     `json:"uid"`
	SUID            int64     `json:"suid,omitempty"`
	Username        string    `json:"username"`
	PasswordHash    string    `json:"-"`
	Role            string    `json:"role"`
	PasswordVersion int64     `json:"password_version"`
	SessionVersion  int64     `json:"session_version"`
	CreatedAt       time.Time `json:"created_at"`
}

type DB struct {
	conn *sql.DB
}

func Open(path string) (*DB, error) {
	conn, err := sql.Open("sqlite3", path+"?_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	d := &DB{conn: conn}
	if err := d.init(); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *DB) Close() error { return d.conn.Close() }

func (d *DB) nextUID() (int64, error) {
	var uid int64
	err := d.conn.QueryRow("SELECT COALESCE(MAX(uid),0) FROM users").Scan(&uid)
	if err != nil {
		return 0, err
	}
	return uid + 1, nil
}

func (d *DB) nextSUID() (int64, error) {
	var suid int64
	err := d.conn.QueryRow("SELECT COALESCE(MAX(suid),0) FROM users WHERE suid > 0").Scan(&suid)
	if err != nil {
		return 0, err
	}
	return suid + 1, nil
}

func (d *DB) init() error {
	// Check if table exists and needs migration
	var tableExists int
	d.conn.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'").Scan(&tableExists)

	if tableExists == 0 {
		_, err := d.conn.Exec(`CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uid INTEGER UNIQUE NOT NULL,
			suid INTEGER NOT NULL DEFAULT 0,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'user',
			password_version INTEGER NOT NULL DEFAULT 1,
			session_version INTEGER NOT NULL DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`)
		if err != nil {
			return fmt.Errorf("create table: %w", err)
		}
	} else {
		// Migrate: check if uid column is TEXT type and migrate to INTEGER
		var colType string
		rows, err := d.conn.Query("PRAGMA table_info(users)")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var cid int
				var name, typ string
				var notNull int
				var dfltValue sql.NullString
				var pk int
				rows.Scan(&cid, &name, &typ, &notNull, &dfltValue, &pk)
				if name == "uid" {
					colType = typ
				}
			}
		}

		if colType == "TEXT" || colType == "text" {
			log.Println("Migrating uid column from TEXT to INTEGER...")
			tx, err := d.conn.Begin()
			if err != nil {
				return fmt.Errorf("begin migration: %w", err)
			}
			stmts := []string{
				`CREATE TABLE users_new (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					uid INTEGER UNIQUE NOT NULL,
					username TEXT UNIQUE NOT NULL,
					password_hash TEXT NOT NULL,
					role TEXT NOT NULL DEFAULT 'user',
					password_version INTEGER NOT NULL DEFAULT 1,
					created_at DATETIME DEFAULT CURRENT_TIMESTAMP
				)`,
			}
			for _, s := range stmts {
				if _, err := tx.Exec(s); err != nil {
					tx.Rollback()
					return fmt.Errorf("migration: %w", err)
				}
			}

			// Re-assign UIDs: owner/admin get 100+, users get 10001+
			oldRows, err := tx.Query("SELECT id, username, password_hash, role, password_version, created_at FROM users ORDER BY id")
			if err != nil {
				tx.Rollback()
				return fmt.Errorf("migration read: %w", err)
			}
			type oldUser struct {
				id              int64
				username        string
				passwordHash    string
				role            string
				passwordVersion int64
				createdAt       time.Time
			}
			var admins, users []oldUser
			for oldRows.Next() {
				var u oldUser
				oldRows.Scan(&u.id, &u.username, &u.passwordHash, &u.role, &u.passwordVersion, &u.createdAt)
				if u.role == "owner" || u.role == "admin" {
					admins = append(admins, u)
				} else {
					users = append(users, u)
				}
			}
			oldRows.Close()

			adminUID := int64(100)
			for _, u := range admins {
				_, err := tx.Exec("INSERT INTO users_new(uid,username,password_hash,role,password_version,created_at) VALUES(?,?,?,?,?,?)",
					adminUID, u.username, u.passwordHash, u.role, u.passwordVersion, u.createdAt)
				if err != nil {
					tx.Rollback()
					return fmt.Errorf("migration insert admin: %w", err)
				}
				adminUID++
			}
			userUID := int64(10001)
			for _, u := range users {
				_, err := tx.Exec("INSERT INTO users_new(uid,username,password_hash,role,password_version,created_at) VALUES(?,?,?,?,?,?)",
					userUID, u.username, u.passwordHash, u.role, u.passwordVersion, u.createdAt)
				if err != nil {
					tx.Rollback()
					return fmt.Errorf("migration insert user: %w", err)
				}
				userUID++
			}

			if _, err := tx.Exec("DROP TABLE users"); err != nil {
				tx.Rollback()
				return fmt.Errorf("migration drop: %w", err)
			}
			if _, err := tx.Exec("ALTER TABLE users_new RENAME TO users"); err != nil {
				tx.Rollback()
				return fmt.Errorf("migration rename: %w", err)
			}
			if err := tx.Commit(); err != nil {
				return fmt.Errorf("migration commit: %w", err)
			}
			log.Println("UID migration complete")
		} else {
			// Ensure columns exist
			d.conn.Exec(`ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 1`)
			d.conn.Exec(`ALTER TABLE users ADD COLUMN suid INTEGER NOT NULL DEFAULT 0`)
			d.conn.Exec(`ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1`)
		}
	}

	// Create audio library tables
	d.conn.Exec(`CREATE TABLE IF NOT EXISTS audio_files (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		owner_id INTEGER NOT NULL,
		filename TEXT NOT NULL,
		original_name TEXT NOT NULL,
		title TEXT NOT NULL,
		artist TEXT DEFAULT '',
		duration REAL NOT NULL DEFAULT 0,
		size INTEGER NOT NULL DEFAULT 0,
		original_format TEXT DEFAULT '',
		original_bitrate INTEGER DEFAULT 0,
		qualities TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY(owner_id) REFERENCES users(id)
	)`)
	// Migrate: add new columns if missing
	d.conn.Exec(`ALTER TABLE audio_files ADD COLUMN original_format TEXT DEFAULT ''`)
	d.conn.Exec(`ALTER TABLE audio_files ADD COLUMN original_bitrate INTEGER DEFAULT 0`)
	d.conn.Exec(`ALTER TABLE audio_files ADD COLUMN qualities TEXT DEFAULT ''`)
	d.conn.Exec(`CREATE TABLE IF NOT EXISTS library_shares (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		owner_id INTEGER NOT NULL,
		shared_with_id INTEGER NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(owner_id, shared_with_id),
		FOREIGN KEY(owner_id) REFERENCES users(id),
		FOREIGN KEY(shared_with_id) REFERENCES users(id)
	)`)
	d.conn.Exec(`CREATE TABLE IF NOT EXISTS playlists (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		room_code TEXT NOT NULL,
		created_by INTEGER NOT NULL,
		play_mode TEXT NOT NULL DEFAULT 'sequential',
		current_index INTEGER NOT NULL DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	d.conn.Exec(`CREATE TABLE IF NOT EXISTS playlist_items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		playlist_id INTEGER NOT NULL,
		audio_id INTEGER NOT NULL,
		position INTEGER NOT NULL,
		FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
		FOREIGN KEY(audio_id) REFERENCES audio_files(id)
	)`)

	// Seed owner account
	ownerUsername := os.Getenv("OWNER_USERNAME")
	if ownerUsername == "" {
		ownerUsername = "admin"
	}
	ownerPassword := os.Getenv("OWNER_PASSWORD")
	if ownerPassword == "" {
		ownerPassword = "admin123"
	}

	var ownerCount int
	d.conn.QueryRow("SELECT COUNT(*) FROM users WHERE role='owner'").Scan(&ownerCount)
	if ownerCount == 0 {
		var existingID int64
		err := d.conn.QueryRow("SELECT id FROM users WHERE username=?", ownerUsername).Scan(&existingID)
		if err == nil {
			d.conn.Exec("UPDATE users SET role='owner', suid=1 WHERE id=?", existingID)
			log.Printf("Upgraded existing user '%s' to owner with suid=1", ownerUsername)
		} else {
			hash, _ := bcrypt.GenerateFromPassword([]byte(ownerPassword), 12)
			_, err := d.conn.Exec("INSERT INTO users(uid,suid,username,password_hash,role) VALUES(?,?,?,?,'owner')", 1, 1, ownerUsername, string(hash))
			if err != nil {
				return fmt.Errorf("seed owner: %w", err)
			}
			log.Printf("Default owner account created (%s) uid=1 suid=1 - 请尽快修改默认密码", ownerUsername)
		}
	}
	return nil
}

func (d *DB) CreateUser(username, password, role string) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return nil, err
	}
	uid, err := d.nextUID()
	if err != nil {
		return nil, fmt.Errorf("generate uid: %w", err)
	}
	var suid int64
	if role == "owner" || role == "admin" {
		suid, err = d.nextSUID()
		if err != nil {
			return nil, fmt.Errorf("generate suid: %w", err)
		}
	}
	res, err := d.conn.Exec("INSERT INTO users(uid,suid,username,password_hash,role) VALUES(?,?,?,?,?)", uid, suid, username, string(hash), role)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &User{ID: id, UID: uid, SUID: suid, Username: username, Role: role, PasswordVersion: 1, CreatedAt: time.Now()}, nil
}

func (d *DB) GetUserByUsername(username string) (*User, error) {
	u := &User{}
	err := d.conn.QueryRow("SELECT id,uid,suid,username,password_hash,role,password_version,session_version,created_at FROM users WHERE username=?", username).
		Scan(&u.ID, &u.UID, &u.SUID, &u.Username, &u.PasswordHash, &u.Role, &u.PasswordVersion, &u.SessionVersion, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (d *DB) GetUserByID(id int64) (*User, error) {
	u := &User{}
	err := d.conn.QueryRow("SELECT id,uid,suid,username,password_hash,role,password_version,session_version,created_at FROM users WHERE id=?", id).
		Scan(&u.ID, &u.UID, &u.SUID, &u.Username, &u.PasswordHash, &u.Role, &u.PasswordVersion, &u.SessionVersion, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (d *DB) GetUserByUID(uid int64) (*User, error) {
	u := &User{}
	err := d.conn.QueryRow("SELECT id,uid,suid,username,password_hash,role,password_version,session_version,created_at FROM users WHERE uid=?", uid).
		Scan(&u.ID, &u.UID, &u.SUID, &u.Username, &u.PasswordHash, &u.Role, &u.PasswordVersion, &u.SessionVersion, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (d *DB) GetUserRoleAndVersion(id int64) (role string, pwVersion int64, sessVersion int64, err error) {
	err = d.conn.QueryRow("SELECT role, password_version, session_version FROM users WHERE id=?", id).Scan(&role, &pwVersion, &sessVersion)
	return
}

func (d *DB) BumpSessionVersion(id int64) (int64, error) {
	_, err := d.conn.Exec("UPDATE users SET session_version=session_version+1 WHERE id=?", id)
	if err != nil {
		return 0, err
	}
	var v int64
	d.conn.QueryRow("SELECT session_version FROM users WHERE id=?", id).Scan(&v)
	return v, nil
}

func (d *DB) UpdatePassword(id int64, newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return err
	}
	_, err = d.conn.Exec("UPDATE users SET password_hash=?, password_version=password_version+1 WHERE id=?", string(hash), id)
	return err
}

func (d *DB) UpdateUsername(id int64, newUsername string) error {
	_, err := d.conn.Exec("UPDATE users SET username=? WHERE id=?", newUsername, id)
	return err
}

func (d *DB) UpdateUserRole(id int64, role string) error {
	var suid int64
	if role == "owner" || role == "admin" {
		// Check if user already has a suid
		d.conn.QueryRow("SELECT suid FROM users WHERE id=?", id).Scan(&suid)
		if suid == 0 {
			suid, _ = d.nextSUID()
		}
	}
	_, err := d.conn.Exec("UPDATE users SET role=?, suid=? WHERE id=?", role, suid, id)
	return err
}

func (d *DB) DeleteUser(id int64) error {
	_, err := d.conn.Exec("DELETE FROM users WHERE id=?", id)
	return err
}

func (d *DB) ListUsersPaged(page, pageSize int) ([]*User, int, error) {
	var total int
	d.conn.QueryRow("SELECT COUNT(*) FROM users").Scan(&total)

	offset := (page - 1) * pageSize
	rows, err := d.conn.Query("SELECT id,uid,suid,username,role,password_version,session_version,created_at FROM users ORDER BY uid LIMIT ? OFFSET ?", pageSize, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var users []*User
	for rows.Next() {
		u := &User{}
		rows.Scan(&u.ID, &u.UID, &u.SUID, &u.Username, &u.Role, &u.PasswordVersion, &u.SessionVersion, &u.CreatedAt)
		users = append(users, u)
	}
	return users, total, nil
}

func (d *DB) ListUsers() ([]*User, error) {
	rows, err := d.conn.Query("SELECT id,uid,suid,username,role,password_version,session_version,created_at FROM users ORDER BY uid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []*User
	for rows.Next() {
		u := &User{}
		rows.Scan(&u.ID, &u.UID, &u.SUID, &u.Username, &u.Role, &u.PasswordVersion, &u.SessionVersion, &u.CreatedAt)
		users = append(users, u)
	}
	return users, nil
}

// --- Audio Library CRUD ---

func (d *DB) AddAudioFile(ownerID int64, filename, originalName, title, artist string, duration float64, size int64, originalFormat string, originalBitrate int, qualities string) (*AudioFile, error) {
	res, err := d.conn.Exec("INSERT INTO audio_files(owner_id,filename,original_name,title,artist,duration,size,original_format,original_bitrate,qualities) VALUES(?,?,?,?,?,?,?,?,?,?)",
		ownerID, filename, originalName, title, artist, duration, size, originalFormat, originalBitrate, qualities)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &AudioFile{ID: id, OwnerID: ownerID, Filename: filename, OriginalName: originalName, Title: title, Artist: artist, Duration: duration, Size: size, OriginalFormat: originalFormat, OriginalBitrate: originalBitrate, Qualities: qualities, CreatedAt: time.Now()}, nil
}

func (d *DB) GetAudioFilesByOwner(ownerID int64) ([]*AudioFile, error) {
	rows, err := d.conn.Query("SELECT id,owner_id,filename,original_name,title,artist,duration,size,original_format,original_bitrate,qualities,created_at FROM audio_files WHERE owner_id=? ORDER BY created_at DESC", ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files []*AudioFile
	for rows.Next() {
		f := &AudioFile{}
		rows.Scan(&f.ID, &f.OwnerID, &f.Filename, &f.OriginalName, &f.Title, &f.Artist, &f.Duration, &f.Size, &f.OriginalFormat, &f.OriginalBitrate, &f.Qualities, &f.CreatedAt)
		files = append(files, f)
	}
	return files, nil
}

func (d *DB) GetAudioFileByID(id int64) (*AudioFile, error) {
	f := &AudioFile{}
	err := d.conn.QueryRow("SELECT id,owner_id,filename,original_name,title,artist,duration,size,original_format,original_bitrate,qualities,created_at FROM audio_files WHERE id=?", id).
		Scan(&f.ID, &f.OwnerID, &f.Filename, &f.OriginalName, &f.Title, &f.Artist, &f.Duration, &f.Size, &f.OriginalFormat, &f.OriginalBitrate, &f.Qualities, &f.CreatedAt)
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (d *DB) DeleteAudioFile(id, ownerID int64) error {
	// Remove from any playlists first
	d.conn.Exec("DELETE FROM playlist_items WHERE audio_id=?", id)
	res, err := d.conn.Exec("DELETE FROM audio_files WHERE id=? AND owner_id=?", id, ownerID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("not found or not owner")
	}
	return nil
}

// --- Library Sharing ---

func (d *DB) ShareLibrary(ownerID, sharedWithID int64) error {
	_, err := d.conn.Exec("INSERT OR IGNORE INTO library_shares(owner_id,shared_with_id) VALUES(?,?)", ownerID, sharedWithID)
	return err
}

func (d *DB) UnshareLibrary(ownerID, sharedWithID int64) error {
	_, err := d.conn.Exec("DELETE FROM library_shares WHERE owner_id=? AND shared_with_id=?", ownerID, sharedWithID)
	return err
}

func (d *DB) GetSharedLibraries(userID int64) ([]*LibraryShare, error) {
	rows, err := d.conn.Query(`SELECT ls.id, ls.owner_id, ls.shared_with_id, ls.created_at, u.username, u.uid
		FROM library_shares ls JOIN users u ON u.id=ls.owner_id WHERE ls.shared_with_id=?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var shares []*LibraryShare
	for rows.Next() {
		s := &LibraryShare{}
		rows.Scan(&s.ID, &s.OwnerID, &s.SharedWithID, &s.CreatedAt, &s.OwnerName, &s.OwnerUID)
		shares = append(shares, s)
	}
	return shares, nil
}

func (d *DB) GetMyShares(ownerID int64) ([]*LibraryShare, error) {
	rows, err := d.conn.Query(`SELECT ls.id, ls.owner_id, ls.shared_with_id, ls.created_at, u.username, u.uid
		FROM library_shares ls JOIN users u ON u.id=ls.shared_with_id WHERE ls.owner_id=?`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var shares []*LibraryShare
	for rows.Next() {
		s := &LibraryShare{}
		rows.Scan(&s.ID, &s.OwnerID, &s.SharedWithID, &s.CreatedAt, &s.SharedName, &s.SharedUID)
		shares = append(shares, s)
	}
	return shares, nil
}

func (d *DB) GetAccessibleAudioFiles(userID int64) ([]*AudioFile, error) {
	rows, err := d.conn.Query(`SELECT a.id,a.owner_id,a.filename,a.original_name,a.title,a.artist,a.duration,a.size,a.original_format,a.original_bitrate,a.qualities,a.created_at,u.username
		FROM audio_files a JOIN users u ON u.id=a.owner_id
		WHERE a.owner_id=? OR a.owner_id IN (SELECT owner_id FROM library_shares WHERE shared_with_id=?)
		ORDER BY a.created_at DESC`, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files []*AudioFile
	for rows.Next() {
		f := &AudioFile{}
		rows.Scan(&f.ID, &f.OwnerID, &f.Filename, &f.OriginalName, &f.Title, &f.Artist, &f.Duration, &f.Size, &f.OriginalFormat, &f.OriginalBitrate, &f.Qualities, &f.CreatedAt, &f.OwnerName)
		files = append(files, f)
	}
	return files, nil
}

func (d *DB) CanAccessAudioFile(userID, audioID int64) (bool, error) {
	var count int
	err := d.conn.QueryRow(`SELECT COUNT(*) FROM audio_files WHERE id=? AND (owner_id=? OR owner_id IN (SELECT owner_id FROM library_shares WHERE shared_with_id=?))`,
		audioID, userID, userID).Scan(&count)
	return count > 0, err
}

// --- Playlist CRUD ---

func (d *DB) CreatePlaylist(roomCode string, createdBy int64) (*Playlist, error) {
	res, err := d.conn.Exec("INSERT INTO playlists(room_code,created_by) VALUES(?,?)", roomCode, createdBy)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Playlist{ID: id, RoomCode: roomCode, CreatedBy: createdBy, PlayMode: "sequential", CurrentIndex: 0, CreatedAt: time.Now()}, nil
}

func (d *DB) GetPlaylistByRoom(roomCode string) (*Playlist, error) {
	p := &Playlist{}
	err := d.conn.QueryRow("SELECT id,room_code,created_by,play_mode,current_index,created_at FROM playlists WHERE room_code=?", roomCode).
		Scan(&p.ID, &p.RoomCode, &p.CreatedBy, &p.PlayMode, &p.CurrentIndex, &p.CreatedAt)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (d *DB) AddPlaylistItem(playlistID, audioID int64, position int) (*PlaylistItem, error) {
	res, err := d.conn.Exec("INSERT INTO playlist_items(playlist_id,audio_id,position) VALUES(?,?,?)", playlistID, audioID, position)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &PlaylistItem{ID: id, PlaylistID: playlistID, AudioID: audioID, Position: position}, nil
}

func (d *DB) RemovePlaylistItem(playlistID, itemID int64) error {
	_, err := d.conn.Exec("DELETE FROM playlist_items WHERE id=? AND playlist_id=?", itemID, playlistID)
	return err
}

func (d *DB) GetPlaylistItems(playlistID int64) ([]*PlaylistItem, error) {
	rows, err := d.conn.Query(`SELECT pi.id,pi.playlist_id,pi.audio_id,pi.position,a.title,a.artist,a.duration,a.filename,a.original_name,a.owner_id,a.qualities
		FROM playlist_items pi JOIN audio_files a ON a.id=pi.audio_id WHERE pi.playlist_id=? ORDER BY pi.position`, playlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []*PlaylistItem
	for rows.Next() {
		i := &PlaylistItem{}
		rows.Scan(&i.ID, &i.PlaylistID, &i.AudioID, &i.Position, &i.Title, &i.Artist, &i.Duration, &i.Filename, &i.OriginalName, &i.OwnerID, &i.Qualities)
		items = append(items, i)
	}
	return items, nil
}

func (d *DB) UpdatePlayMode(playlistID int64, mode string) error {
	_, err := d.conn.Exec("UPDATE playlists SET play_mode=? WHERE id=?", mode, playlistID)
	return err
}

func (d *DB) UpdateCurrentIndex(playlistID int64, index int) error {
	_, err := d.conn.Exec("UPDATE playlists SET current_index=? WHERE id=?", index, playlistID)
	return err
}

func (d *DB) GetNextPlaylistPosition(playlistID int64) (int, error) {
	var pos int
	err := d.conn.QueryRow("SELECT COALESCE(MAX(position),0)+1 FROM playlist_items WHERE playlist_id=?", playlistID).Scan(&pos)
	return pos, err
}

func (d *DB) ReorderPlaylistItems(playlistID int64, itemIDs []int64) error {
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	for i, id := range itemIDs {
		if _, err := tx.Exec("UPDATE playlist_items SET position=? WHERE id=? AND playlist_id=?", i, id, playlistID); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}
