package debug

import (
	"encoding/json"
	"fmt"
	"io"
)

// PrintHelp lists the available debug subcommands.
func PrintHelp(out io.Writer) {
	fmt.Fprintln(out, "commands:")
	fmt.Fprintln(out, "  status      当前配置、已发现 agent、session 数量")
	fmt.Fprintln(out, "  sessions    列出 provider 原生会话元数据")
	fmt.Fprintln(out, "  acp         列出 conversation runtime 的 conversation -> session 映射")
	fmt.Fprintln(out, "  clients     列出当前可用 agent clients")
	fmt.Fprintln(out, "  paths       显示 workspace/session/state 目录")
	fmt.Fprintln(out, "  all         输出全部调试信息")
	fmt.Fprintln(out, "  json        以 JSON 输出全部快照")
	fmt.Fprintln(out, "  quit        退出交互模式")
}

// PrintStatus emits the daemon's high-level runtime status.
func PrintStatus(out io.Writer, s Snapshot) {
	fmt.Fprintf(out, "version: %s\n", s.Version)
	fmt.Fprintf(out, "linkId: %s\n", s.LinkID)
	fmt.Fprintf(out, "server: %s\n", s.Server)
	fmt.Fprintf(out, "host: %s %s/%s\n", s.Hostname, s.OS, s.Arch)
	fmt.Fprintf(out, "agentClients: %d\n", len(s.AgentClients))
	fmt.Fprintf(out, "sessions: %d\n", len(s.Sessions))
	fmt.Fprintf(out, "conversationRuntimeSessions: %d\n", len(s.ConversationRuntimeSessions))
}

// PrintPaths emits the configured directory paths.
func PrintPaths(out io.Writer, s Snapshot) {
	fmt.Fprintf(out, "config: %s\n", s.ConfigPath)
	fmt.Fprintf(out, "workspaceDir: %s\n", s.WorkspaceDir)
	fmt.Fprintf(out, "sessionDir: %s\n", s.SessionDir)
	fmt.Fprintf(out, "stateDir: %s\n", s.StateDir)
}

// PrintClients emits the discovered agent client list.
func PrintClients(out io.Writer, s Snapshot) {
	if len(s.AgentClients) == 0 {
		fmt.Fprintln(out, "no agent clients discovered")
		return
	}
	for _, c := range s.AgentClients {
		transport := c.Transport
		if transport == "" {
			transport = "stdio"
		}
		fmt.Fprintf(out, "- %s (%s) family=%s transport=%s provider=%s binary=%s version=%s\n",
			c.ID, c.DisplayName, c.Family, transport, c.Provider, c.Binary, c.Version)
	}
}

// PrintSessions emits the provider session metadata list.
func PrintSessions(out io.Writer, s Snapshot) {
	if len(s.Sessions) == 0 {
		fmt.Fprintln(out, "no provider sessions found")
		return
	}
	for _, item := range s.Sessions {
		fmt.Fprintf(out, "- workspace=%s agent=%s session=%s updated=%s size=%d path=%s",
			item.Workspace, item.AgentID, item.ID, item.UpdatedAt, item.SizeBytes, item.Path)
		if item.Title != "" {
			fmt.Fprintf(out, " title=%q", item.Title)
		}
		fmt.Fprintln(out)
	}
}

// PrintACPMappings emits the persisted conversation runtime session mappings.
func PrintACPMappings(out io.Writer, s Snapshot) {
	if len(s.ConversationRuntimeSessions) == 0 {
		fmt.Fprintln(out, "no conversation runtime session mappings found")
		return
	}
	fmt.Fprintln(out, "conversation runtime session mappings:")
	for _, rec := range s.ConversationRuntimeSessions {
		fmt.Fprintf(out, "- conversation=%s agent=%s session=%s updated=%s cwd=%s model=%s\n",
			rec.ConversationID, rec.AgentClientID, rec.SessionID, rec.UpdatedAt, rec.Cwd, rec.Model)
	}
}

// PrintJSON serialises the entire snapshot as indented JSON.
func PrintJSON(out io.Writer, s Snapshot) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, string(data))
	return err
}
