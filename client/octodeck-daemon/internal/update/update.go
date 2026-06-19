package update

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
	state "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/state"
)

// Config aliases the daemon configuration type for convenience.
type Config = daemonconfig.Config

var daemonUpdateMu sync.Mutex

// RunUpdateCommand parses CLI arguments and runs an in-place daemon binary update.
func RunUpdateCommand(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	var configPath string
	var targetPath string
	var restart bool
	fs.StringVar(&configPath, "config", "", "path to config.json")
	fs.StringVar(&targetPath, "target", "", "path to octodeck-daemon binary to replace (default current executable)")
	fs.BoolVar(&restart, "restart", true, "restart octodeck-daemon user service after updating")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := daemonconfig.Load(configPath)
	if err != nil {
		return err
	}
	return UpdateBinary(cfg, targetPath, restart)
}

// UpdateBinary downloads a fresh daemon binary and replaces the target file.
func UpdateBinary(cfg *Config, targetPath string, restart bool) error {
	daemonUpdateMu.Lock()
	defer daemonUpdateMu.Unlock()
	_, err := updateBinaryLocked(cfg, targetPath, restart)
	return err
}

// UpdateBinaryGracefully waits for the pool to drain before performing an update.
func UpdateBinaryGracefully(ctx context.Context, cfg *Config, pool *state.RunPool, targetPath string, restart bool) error {
	daemonUpdateMu.Lock()
	defer daemonUpdateMu.Unlock()

	releaseDrain, err := WaitForPoolIdle(ctx, pool)
	if err != nil {
		return err
	}
	restartRequested := false
	defer func() {
		if !restartRequested && releaseDrain != nil {
			releaseDrain()
		}
	}()

	restartRequested, err = updateBinaryLocked(cfg, targetPath, restart)
	return err
}

// WaitForPoolIdle blocks until the runner pool has no active runs.
func WaitForPoolIdle(ctx context.Context, pool *state.RunPool) (func(), error) {
	if pool == nil {
		return func() {}, nil
	}
	pool.SetDraining(true)
	release := func() { pool.SetDraining(false) }

	if active := pool.ActiveCount(); active == 0 {
		return release, nil
	}
	log.Printf("octodeck-daemon: graceful update waiting for %d active run(s) to finish", pool.ActiveCount())
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	lastLog := time.Now()
	for {
		if active := pool.ActiveCount(); active == 0 {
			log.Printf("octodeck-daemon: active runs finished; continuing graceful update")
			return release, nil
		}
		select {
		case <-ctx.Done():
			release()
			return nil, fmt.Errorf("wait for active runs before daemon update: %w", ctx.Err())
		case <-ticker.C:
			if time.Since(lastLog) >= 30*time.Second {
				log.Printf("octodeck-daemon: graceful update still waiting for %d active run(s)", pool.ActiveCount())
				lastLog = time.Now()
			}
		}
	}
}

func updateBinaryLocked(cfg *Config, targetPath string, restart bool) (bool, error) {
	var err error
	if targetPath == "" {
		targetPath, err = os.Executable()
		if err != nil {
			return false, fmt.Errorf("resolve current executable: %w", err)
		}
	}
	targetPath, err = filepath.Abs(targetPath)
	if err != nil {
		return false, err
	}
	info, err := os.Stat(targetPath)
	mode := os.FileMode(0o755)
	if err == nil {
		mode = info.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("stat target binary: %w", err)
	}
	binURL := strings.TrimRight(cfg.Server, "/") +
		"/api/daemon/octodeck-daemon-bin/" + runtime.GOOS + "/" + runtime.GOARCH
	tmp := filepath.Join(filepath.Dir(targetPath), fmt.Sprintf(".octodeck-daemon.update.%d", os.Getpid()))
	if err := downloadFile(binURL, tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	if err := os.Rename(tmp, targetPath); err != nil {
		_ = os.Remove(tmp)
		return false, fmt.Errorf("replace target binary: %w", err)
	}
	fmt.Printf("octodeck-daemon: updated %s from %s\n", targetPath, binURL)
	if restart {
		if err := restartService(); err != nil {
			fmt.Fprintf(os.Stderr, "octodeck-daemon: updated but restart failed: %v\n", err)
			fmt.Fprintln(os.Stderr, "octodeck-daemon: please restart the daemon manually")
			return false, nil
		}
		fmt.Println("octodeck-daemon: restart requested")
		return true, nil
	}
	return false, nil
}

type daemonVersionResponse struct {
	Version string `json:"version"`
}

// VersionURL returns the daemon version-check endpoint for the configured server.
func VersionURL(server string) string {
	return strings.TrimRight(server, "/") + "/api/daemon/version"
}

// AutoUpdateEnabled reports whether the daemon should perform automatic updates.
func AutoUpdateEnabled(cfg *Config) bool {
	return cfg == nil || cfg.AutoUpdate == nil || *cfg.AutoUpdate
}

// Check queries the server for the latest daemon version and reports whether an update is available.
func Check(ctx context.Context, cfg *Config) (string, bool, error) {
	if cfg == nil {
		return "", false, errors.New("nil config")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, VersionURL(cfg.Server), nil)
	if err != nil {
		return "", false, err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", false, fmt.Errorf("daemon version check http %s", resp.Status)
	}
	var body daemonVersionResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", false, err
	}
	latest := strings.TrimSpace(body.Version)
	return latest, IsNewerVersion(latest, cfg.Version), nil
}

// RunAutoUpdate checks for an update and applies it gracefully when one is available.
func RunAutoUpdate(ctx context.Context, cfg *Config, pool *state.RunPool) error {
	if !AutoUpdateEnabled(cfg) {
		return nil
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	latest, available, err := Check(checkCtx, cfg)
	if err != nil {
		return fmt.Errorf("check daemon update: %w", err)
	}
	if !available {
		return nil
	}
	log.Printf("octodeck-daemon: auto update available current=%s latest=%s", cfg.Version, latest)
	if err := UpdateBinaryGracefully(ctx, cfg, pool, "", true); err != nil {
		return fmt.Errorf("auto update to %s: %w", latest, err)
	}
	return nil
}

func restartService() error {
	if runtime.GOOS == "darwin" {
		plist := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", "com.octodeck.octodeck-daemon.plist")
		if _, err := os.Stat(plist); err == nil {
			return exec.Command("launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/com.octodeck.octodeck-daemon", os.Getuid())).Run()
		}
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		service := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", "octodeck-daemon.service")
		if _, statErr := os.Stat(service); statErr == nil {
			return exec.Command("systemctl", "--user", "restart", "octodeck-daemon.service").Run()
		}
	}
	return fmt.Errorf("no launchctl/systemd user service found")
}
