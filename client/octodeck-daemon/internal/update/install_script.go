package update

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// downloadFile fetches a binary from url and writes it to target with the supplied mode.
// It is shared by the install/update flows that need to materialize the daemon executable.
func downloadFile(url string, target string, mode os.FileMode) error {
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download %s: http %s", url, resp.Status)
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Chmod(target, mode)
}

// NormalizeVersion strips common prefixes (e.g. "octodeck-daemon/", leading "v") and trims whitespace.
func NormalizeVersion(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "octodeck-daemon/")
	s = strings.TrimPrefix(s, "v")
	return s
}

// IsNewerVersion reports whether the latest version string represents a newer release than current.
// It performs a best-effort semver comparison and falls back to string inequality when versions are
// not pure numeric semver.
func IsNewerVersion(latest string, current string) bool {
	latest = NormalizeVersion(latest)
	current = NormalizeVersion(current)
	if latest == "" || current == "" || latest == current {
		return false
	}
	latestParts, latestOK := parseSemver(latest)
	currentParts, currentOK := parseSemver(current)
	if latestOK && currentOK {
		for i := 0; i < len(latestParts); i++ {
			if latestParts[i] != currentParts[i] {
				return latestParts[i] > currentParts[i]
			}
		}
		return false
	}
	return latest != current
}

func parseSemver(s string) ([3]int, bool) {
	var out [3]int
	base := strings.SplitN(s, "-", 2)[0]
	parts := strings.Split(base, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		if p == "" {
			return out, false
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
