package audio

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
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
	{Name: "high", DirSuffix: "segments_high", Codec: "aac", Bitrate: "256k", Ext: ".m4a", SegFormat: "mp4"},
	{Name: "medium", DirSuffix: "segments_medium", Codec: "aac", Bitrate: "128k", Ext: ".m4a", SegFormat: "mp4"},
	{Name: "low", DirSuffix: "segments_low", Codec: "aac", Bitrate: "64k", Ext: ".m4a", SegFormat: "mp4"},
}

// ProbeResult holds ffprobe detection results.
type ProbeResult struct {
	Bitrate       int    // in kbps
	Format        string // codec name e.g. "flac", "aac", "mp3"
	IsLossless    bool
}

// ProbeAudio detects bitrate and format of an audio file.
func ProbeAudio(inputPath string) (*ProbeResult, error) {
	// Get bitrate
	cmdBr := exec.Command("ffprobe", "-v", "error",
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
	cmdCodec := exec.Command("ffprobe", "-v", "error",
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
	dir := filepath.Join(outputDir, q.DirSuffix)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	pattern := filepath.Join(dir, "seg_%03d"+q.Ext)

	args := []string{"-i", inputPath, "-vn"}
	if q.Codec == "flac" {
		args = append(args, "-c:a", "flac")
	} else {
		args = append(args, "-c:a", "aac", "-b:a", q.Bitrate)
	}
	args = append(args, "-f", "segment", "-segment_time", strconv.Itoa(SegmentDuration))
	if q.SegFormat != "" {
		args = append(args, "-segment_format", q.SegFormat)
	}
	args = append(args, "-y", pattern)

	cmd := exec.Command("ffmpeg", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg (%s) failed: %w, output: %s", q.Name, err, string(out))
	}

	// List generated segments
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
				manifest.Qualities[q.Name] = &QualityInfo{
					Format:   q.Codec,
					Bitrate:  parseBitrateInt(q.Bitrate),
					Segments: s,
				}
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
	cmd := exec.Command("ffmpeg",
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
	cmd := exec.Command("ffprobe",
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
