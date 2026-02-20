package audio

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ffprobeTimeout = 30 * time.Second
	ffmpegTimeout  = 5 * time.Minute
)

const (
	SegmentDuration = 5 // seconds per segment
	AudioBitrate    = "128k"
)

type Manifest struct {
	Filename     string   `json:"filename"`
	Duration     float64  `json:"duration"`
	SegmentCount int      `json:"segmentCount"`
	SegmentTime  float64  `json:"segmentTime"`
	Segments     []string `json:"segments"`
}

// QualityInfo describes one quality tier in the multi-quality manifest.
type QualityInfo struct {
	Format   string   `json:"format"`
	Bitrate  int      `json:"bitrate"`
	Segments []string `json:"segments"`
}

// MultiQualityManifest is written as manifest.json inside the audio directory.
type MultiQualityManifest struct {
	mu          sync.Mutex              `json:"-"`
	Duration    float64                 `json:"duration"`
	SegmentTime int                     `json:"segment_time"`
	Qualities   map[string]*QualityInfo `json:"qualities"`
}

// qualityDef defines how to encode one quality tier.
type qualityDef struct {
	Name       string
	DirSuffix  string // e.g. "segments_high"
	Codec      string // "flac" or "aac"
	Bitrate    string // e.g. "256k", "" for flac
	Ext        string // file extension including dot
	SegFormat  string // segment_format value
}

var allQualities = []qualityDef{
	{Name: "lossless", DirSuffix: "segments_lossless", Codec: "flac", Bitrate: "", Ext: ".flac", SegFormat: "flac"},
	{Name: "high", DirSuffix: "segments_high", Codec: "flac", Bitrate: "", Ext: ".flac", SegFormat: "flac"},
	{Name: "medium", DirSuffix: "segments_medium", Codec: "flac", Bitrate: "", Ext: ".flac", SegFormat: "flac"},
	{Name: "low", DirSuffix: "segments_low", Codec: "flac", Bitrate: "", Ext: ".flac", SegFormat: "flac"},
}

// ProbeResult holds ffprobe detection results.
type ProbeResult struct {
	Bitrate       int    // in kbps
	Format        string // codec name e.g. "flac", "aac", "mp3"
	IsLossless    bool
}

// sanitizeInputPath ensures path doesn't start with - to prevent ffmpeg argument injection
func sanitizeInputPath(path string) string {
	if strings.HasPrefix(path, "-") {
		return "./" + path
	}
	return path
}

// ProbeAudio detects bitrate and format of an audio file.
func ProbeAudio(inputPath string) (*ProbeResult, error) {
	inputPath = sanitizeInputPath(inputPath)
	// Get bitrate
	ctxBr, cancelBr := context.WithTimeout(context.Background(), ffprobeTimeout)
	defer cancelBr()
	cmdBr := exec.CommandContext(ctxBr, "ffprobe", "-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "format=bit_rate",
		"-of", "default=noprint_wrappers=1:nokey=1",
		inputPath)
	brOut, _ := cmdBr.Output()
	bitrate := 0
	if s := strings.TrimSpace(string(brOut)); s != "" && s != "N/A" {
		if v, err := strconv.Atoi(s); err == nil {
			bitrate = v / 1000 // convert to kbps
		}
	}

	// Get codec name
	ctxCodec, cancelCodec := context.WithTimeout(context.Background(), ffprobeTimeout)
	defer cancelCodec()
	cmdCodec := exec.CommandContext(ctxCodec, "ffprobe", "-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=codec_name",
		"-of", "default=noprint_wrappers=1:nokey=1",
		inputPath)
	codecOut, _ := cmdCodec.Output()
	codec := strings.TrimSpace(string(codecOut))

	isLossless := false
	switch strings.ToLower(codec) {
	case "flac", "wav", "pcm_s16le", "pcm_s24le", "pcm_s32le", "alac", "wavpack":
		isLossless = true
	}

	return &ProbeResult{Bitrate: bitrate, Format: codec, IsLossless: isLossless}, nil
}

// determineQualities decides which quality tiers to generate.
func determineQualities(probe *ProbeResult) []qualityDef {
	if probe.Bitrate >= 900 || probe.IsLossless {
		return allQualities // all 4
	}
	if probe.Bitrate >= 200 {
		return allQualities[1:] // high/medium/low
	}
	if probe.Bitrate >= 100 {
		return allQualities[2:] // medium/low
	}
	return allQualities[3:] // low only
}

// QualityNames returns the list of quality tier names from a probe result.
func QualityNames(probe *ProbeResult) []string {
	defs := determineQualities(probe)
	names := make([]string, len(defs))
	for i, d := range defs {
		names[i] = d.Name
	}
	return names
}

// segmentOneQuality runs ffmpeg to segment into one quality tier.
func segmentOneQuality(inputPath, outputDir string, q qualityDef) ([]string, error) {
	inputPath = sanitizeInputPath(inputPath)
	dir := filepath.Join(outputDir, q.DirSuffix)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	pattern := filepath.Join(dir, "seg_%03d"+q.Ext)

	args := []string{"-i", inputPath, "-vn", "-c:a", "flac"}
	args = append(args, "-f", "segment", "-segment_time", strconv.Itoa(SegmentDuration))
	args = append(args, "-segment_format", "flac")
	args = append(args, "-y", pattern)

	ctxSeg, cancelSeg := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancelSeg()
	cmd := exec.CommandContext(ctxSeg, "ffmpeg", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg (%s) failed: %w, output: %s", q.Name, err, string(out))
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	pat := regexp.MustCompile(`^seg_\d{3}` + regexp.QuoteMeta(q.Ext) + `$`)
	var segs []string
	for _, e := range entries {
		if !e.IsDir() && pat.MatchString(e.Name()) {
			segs = append(segs, e.Name())
		}
	}
	return segs, nil
}

// ProcessAudioMultiQuality generates multi-quality segments.
// It synchronously generates the "medium" tier first, then spawns background goroutines for the rest.
// Returns the manifest (with at least medium populated) and the list of quality names.
func ProcessAudioMultiQuality(inputPath, outputDir, filename string) (*MultiQualityManifest, *ProbeResult, error) {
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, nil, fmt.Errorf("mkdir: %w", err)
	}

	duration, err := getAudioDuration(inputPath)
	if err != nil {
		return nil, nil, fmt.Errorf("get duration: %w", err)
	}

	probe, err := ProbeAudio(inputPath)
	if err != nil {
		return nil, nil, fmt.Errorf("probe: %w", err)
	}

	defs := determineQualities(probe)

	manifest := &MultiQualityManifest{
		Duration:    duration,
		SegmentTime: SegmentDuration,
		Qualities:   make(map[string]*QualityInfo),
	}

	// Find the "medium" tier (or the first available) to process synchronously.
	syncIdx := 0
	for i, d := range defs {
		if d.Name == "medium" {
			syncIdx = i
			break
		}
	}

	// Process the sync tier first
	segs, err := segmentOneQuality(inputPath, outputDir, defs[syncIdx])
	if err != nil {
		return nil, nil, fmt.Errorf("segment %s: %w", defs[syncIdx].Name, err)
	}
	manifest.Qualities[defs[syncIdx].Name] = &QualityInfo{
		Format:   defs[syncIdx].Codec,
		Bitrate:  parseBitrateInt(defs[syncIdx].Bitrate),
		Segments: segs,
	}

	// Write initial manifest
	writeManifest(outputDir, manifest)

	// Process remaining tiers in background
	remaining := make([]qualityDef, 0, len(defs)-1)
	for i, d := range defs {
		if i != syncIdx {
			remaining = append(remaining, d)
		}
	}
	if len(remaining) > 0 {
		go func() {
			for _, q := range remaining {
				s, err := segmentOneQuality(inputPath, outputDir, q)
				if err != nil {
					log.Printf("background segment %s failed: %v", q.Name, err)
					continue
				}
				manifest.mu.Lock()
				manifest.Qualities[q.Name] = &QualityInfo{
					Format:   q.Codec,
					Bitrate:  parseBitrateInt(q.Bitrate),
					Segments: s,
				}
				manifest.mu.Unlock()
				writeManifest(outputDir, manifest)
				log.Printf("background segment %s done: %d segments", q.Name, len(s))
			}
		}()
	}

	return manifest, probe, nil
}

func parseBitrateInt(s string) int {
	s = strings.TrimSuffix(s, "k")
	v, _ := strconv.Atoi(s)
	return v
}

func writeManifest(outputDir string, m *MultiQualityManifest) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, _ := json.MarshalIndent(m, "", "  ")
	os.WriteFile(filepath.Join(outputDir, "manifest.json"), data, 0644)
}

// ProcessAudio converts and segments an audio file using ffmpeg (legacy, still used for room upload)
func ProcessAudio(inputPath, outputDir, filename string) (*Manifest, error) {
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create output directory: %w", err)
	}

	duration, err := getAudioDuration(inputPath)
	if err != nil {
		return nil, fmt.Errorf("failed to get audio duration: %w", err)
	}

	segmentPattern := filepath.Join(outputDir, "segment_%03d.m4a")
	ctxLegacy, cancelLegacy := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancelLegacy()
	cmd := exec.CommandContext(ctxLegacy, "ffmpeg",
		"-i", inputPath,
		"-vn",
		"-c:a", "aac",
		"-b:a", AudioBitrate,
		"-f", "segment",
		"-segment_time", strconv.Itoa(SegmentDuration),
		"-segment_format", "mp4",
		"-y",
		segmentPattern,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg failed: %w, output: %s", err, string(output))
	}

	segments, err := listSegments(outputDir)
	if err != nil {
		return nil, fmt.Errorf("failed to list segments: %w", err)
	}

	manifest := &Manifest{
		Filename:     filename,
		Duration:     duration,
		SegmentCount: len(segments),
		SegmentTime:  float64(SegmentDuration),
		Segments:     segments,
	}

	manifestPath := filepath.Join(outputDir, "manifest.json")
	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("failed to marshal manifest: %w", err)
	}

	if err := os.WriteFile(manifestPath, manifestData, 0644); err != nil {
		return nil, fmt.Errorf("failed to write manifest: %w", err)
	}

	return manifest, nil
}

func getAudioDuration(filePath string) (float64, error) {
	filePath = sanitizeInputPath(filePath)
	ctxDur, cancelDur := context.WithTimeout(context.Background(), ffprobeTimeout)
	defer cancelDur()
	cmd := exec.CommandContext(ctxDur, "ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		filePath,
	)

	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}

	duration, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil {
		return 0, err
	}

	return duration, nil
}

func listSegments(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	pattern := regexp.MustCompile(`^segment_\d{3}\.m4a$`)
	var segments []string

	for _, entry := range entries {
		if !entry.IsDir() && pattern.MatchString(entry.Name()) {
			segments = append(segments, entry.Name())
		}
	}

	return segments, nil
}

// AudioMetadata holds metadata extracted from audio file tags.
type AudioMetadata struct {
	Title    string
	Artist   string
	Album    string
	Genre    string
	Year     string
	Lyrics   string
	HasCover bool
}

// ffprobeTagsOutput represents the JSON output from ffprobe for tags.
type ffprobeTagsOutput struct {
	Format struct {
		Tags map[string]string `json:"tags"`
	} `json:"format"`
}

// ExtractMetadata extracts title, artist, album from audio file tags using ffprobe.
func ExtractMetadata(inputPath string) (*AudioMetadata, error) {
	inputPath = sanitizeInputPath(inputPath)
	ctx, cancel := context.WithTimeout(context.Background(), ffprobeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-show_entries", "format_tags=title,artist,album,genre,date,lyrics,LYRICS,UNSYNCEDLYRICS",
		"-of", "json",
		inputPath)

	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe metadata failed: %w", err)
	}

	var result ffprobeTagsOutput
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("parse ffprobe output: %w", err)
	}

	meta := &AudioMetadata{}
	tags := result.Format.Tags
	// Tags can be case-insensitive, check common variants
	for k, v := range tags {
		lower := strings.ToLower(k)
		switch lower {
		case "title":
			meta.Title = v
		case "artist":
			meta.Artist = v
		case "album":
			meta.Album = v
		case "genre":
			meta.Genre = v
		case "date", "year":
			if meta.Year == "" {
				meta.Year = v
			}
		default:
			if strings.Contains(lower, "lyric") || lower == "unsyncedlyrics" {
				if meta.Lyrics == "" {
					meta.Lyrics = v
				}
			}
		}
	}

	return meta, nil
}

// ffprobeLyricsOutput represents the JSON output from ffprobe for lyrics extraction.
type ffprobeLyricsOutput struct {
	Format struct {
		Tags map[string]string `json:"tags"`
	} `json:"format"`
	Streams []struct {
		Tags map[string]string `json:"tags"`
	} `json:"streams"`
}

// ExtractLyrics extracts lyrics from audio file using ffprobe, checking both format and stream tags.
func ExtractLyrics(inputPath string) (string, error) {
	inputPath = sanitizeInputPath(inputPath)
	ctx, cancel := context.WithTimeout(context.Background(), ffprobeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-show_entries", "stream_tags=lyrics,LYRICS",
		"-show_entries", "format_tags=lyrics,LYRICS,UNSYNCEDLYRICS",
		"-of", "json",
		inputPath)

	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("ffprobe lyrics failed: %w", err)
	}

	var result ffprobeLyricsOutput
	if err := json.Unmarshal(out, &result); err != nil {
		return "", fmt.Errorf("parse ffprobe lyrics output: %w", err)
	}

	// Check format tags first
	for k, v := range result.Format.Tags {
		lower := strings.ToLower(k)
		if strings.Contains(lower, "lyric") || lower == "unsyncedlyrics" {
			if v != "" {
				return v, nil
			}
		}
	}

	// Check stream tags
	for _, stream := range result.Streams {
		for k, v := range stream.Tags {
			lower := strings.ToLower(k)
			if strings.Contains(lower, "lyric") {
				if v != "" {
					return v, nil
				}
			}
		}
	}

	return "", nil
}

// ExtractCoverArt extracts embedded cover art from audio file to outputPath.
// Returns error if no cover art exists or extraction fails.
func ExtractCoverArt(inputPath, outputPath string) error {
	inputPath = sanitizeInputPath(inputPath)
	ctx, cancel := context.WithTimeout(context.Background(), ffprobeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", inputPath,
		"-an",
		"-vcodec", "mjpeg",
		"-vframes", "1",
		"-y",
		outputPath)

	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("extract cover failed: %w, output: %s", err, string(out))
	}

	// Verify the file was created and has content
	info, err := os.Stat(outputPath)
	if err != nil || info.Size() == 0 {
		os.Remove(outputPath)
		return fmt.Errorf("no cover art in file")
	}

	return nil
}

// LoadManifest loads a manifest from a room's audio directory
func LoadManifest(roomDir string) (*Manifest, error) {
	manifestPath := filepath.Join(roomDir, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}

	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}

	return &manifest, nil
}

// CleanupRoom removes all audio files for a room
func CleanupRoom(roomDir string) error {
	return os.RemoveAll(roomDir)
}
