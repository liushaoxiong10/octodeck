package update

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	daemonconfig "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/config"
)

// RunUninstallCommand removes the daemon installation and optionally workspace data.
func RunUninstallCommand(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	var removeData bool
	var keepConfig bool
	fs.BoolVar(&removeData, "remove-data", false, "also remove workspace/task/repos/session data under ~/.octodeck")
	fs.BoolVar(&keepConfig, "keep-config", false, "keep ~/.octodeck/daemon/config.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	home, err := daemonconfig.OctodeckHomeDir()
	if err != nil {
		return err
	}
	daemon, err := daemonconfig.DefaultDaemonDir()
	if err != nil {
		return err
	}
	stopAndRemoveService()
	if keepConfig {
		configPath := filepath.Join(daemon, "config.json")
		configData, readErr := os.ReadFile(configPath)
		if readErr != nil && !os.IsNotExist(readErr) {
			return fmt.Errorf("read config before uninstall: %w", readErr)
		}
		if err := os.RemoveAll(daemon); err != nil {
			return fmt.Errorf("remove daemon dir: %w", err)
		}
		if readErr == nil {
			if err := os.MkdirAll(daemon, 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(configPath, configData, 0o600); err != nil {
				return err
			}
		}
	} else if err := os.RemoveAll(daemon); err != nil {
		return fmt.Errorf("remove daemon dir: %w", err)
	}
	if removeData {
		for _, name := range []string{"workspace", "task", "repos", "session"} {
			if err := os.RemoveAll(filepath.Join(home, name)); err != nil {
				return fmt.Errorf("remove %s: %w", name, err)
			}
		}
	}
	fmt.Println("octodeck-daemon: uninstalled")
	if !removeData {
		fmt.Printf("octodeck-daemon: kept workspace data under %s (use --remove-data to delete it)\n", home)
	}
	return nil
}

func stopAndRemoveService() {
	if runtime.GOOS == "darwin" {
		plist := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", "com.octodeck.octodeck-daemon.plist")
		_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d/com.octodeck.octodeck-daemon", os.Getuid())).Run()
		_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d", os.Getuid()), plist).Run()
		_ = os.Remove(plist)
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		service := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", "octodeck-daemon.service")
		_ = exec.Command("systemctl", "--user", "disable", "--now", "octodeck-daemon.service").Run()
		_ = os.Remove(service)
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	}
}
