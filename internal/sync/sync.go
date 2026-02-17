package sync

import (
	"time"
)

// GetServerTime returns current server time in milliseconds
func GetServerTime() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}

// PingResponse represents the response to a ping request
type PingResponse struct {
	Type       string `json:"type"`
	ClientTime int64  `json:"clientTime"`
	ServerTime int64  `json:"serverTime"`
}

// NewPingResponse creates a ping response with current server time
func NewPingResponse(clientTime int64) PingResponse {
	return PingResponse{
		Type:       "pong",
		ClientTime: clientTime,
		ServerTime: GetServerTime(),
	}
}

// ScheduledTime calculates when to start playback
// Adds buffer to ensure all clients receive the message
func ScheduledTime(bufferMs int64) int64 {
	return GetServerTime() + bufferMs
}
