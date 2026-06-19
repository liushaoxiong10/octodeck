package output

import (
	"bufio"
	"context"
	"io"
	"sync/atomic"
	"time"

	proto "github.com/liushaoxiong10/octodeck/client/octodeck-daemon/internal/protocol"
)

// stream.go 集中处理 stdout / stderr 的字节流读取、cap 控制与时间戳生成。
// parser.go 负责单行 JSON → AgentRunEventFrame 的解析，本文件负责 "怎么把
// 子进程的字节流喂进 parser 并对外发射事件"。

// PumpStdout 从子进程 stdout 读取数据：
//   - jsonLines=true：按行解析 JSON 并归一化成 AgentRunEventFrame
//   - jsonLines=false：作为纯文本 text_delta 上报
func PumpStdout(ctx context.Context, r io.Reader, req *AgentRunRequestFrame, jsonLines bool, parser func(string) []AgentRunEventFrame, sent *atomic.Int64, emit func(AgentRunEventFrame)) {
	if !jsonLines {
		PumpLogAsText(r, req, sent, emit)
		return
	}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return
		}
		line := scanner.Text()
		if parser == nil {
			if AllowBytes(sent, int64(len(line)), req.MaxOutputBytes) {
				emit(AgentRunEventFrame{Type: proto.TAgentRunEvent, RunID: req.RunID, AgentID: req.AgentID, EventType: "log", Text: line, At: formatTime(time.Now())})
			}
			continue
		}
		frames := parser(line)
		for _, frame := range frames {
			if frame.Text == "" && frame.SessionID == "" && frame.EventType == "log" {
				continue
			}
			if !AllowBytes(sent, int64(len(frame.Text)), req.MaxOutputBytes) {
				continue
			}
			if frame.Text == "" && frame.SessionID != "" && frame.EventType == "log" && LooksLikeSessionNotification(frame.Payload) {
				frame.EventType = "session"
			}
			frame.Type = proto.TAgentRunEvent
			frame.RunID = req.RunID
			frame.AgentID = req.AgentID
			frame.At = formatTime(time.Now())
			emit(frame)
		}
	}
}

// PumpLog 把子进程的 stderr 流以 "log" 事件上报。
func PumpLog(r io.Reader, req *AgentRunRequestFrame, sent *atomic.Int64, emit func(AgentRunEventFrame)) {
	PumpLogAsText(r, req, sent, func(frame AgentRunEventFrame) {
		frame.EventType = "log"
		emit(frame)
	})
}

// PumpLogAsText 是裸字节流读取入口；调用方决定上报时挂什么 EventType。
func PumpLogAsText(r io.Reader, req *AgentRunRequestFrame, sent *atomic.Int64, emit func(AgentRunEventFrame)) {
	reader := bufio.NewReader(r)
	buf := make([]byte, 8192)
	for {
		n, err := reader.Read(buf)
		if n > 0 && AllowBytes(sent, int64(n), req.MaxOutputBytes) {
			emit(AgentRunEventFrame{Type: proto.TAgentRunEvent, RunID: req.RunID, AgentID: req.AgentID, EventType: "text_delta", Text: string(buf[:n]), At: formatTime(time.Now())})
		}
		if err != nil {
			return
		}
	}
}

// AllowBytes 是 stdout / stderr 输出字节计数的并发安全 cap：sent 已发送字节
// 累计到 max 后所有后续写入会被丢弃，避免 daemon 内存或链路被 runaway agent
// 占满。
func AllowBytes(sent *atomic.Int64, n, max int64) bool {
	if n <= 0 {
		return true
	}
	for {
		cur := sent.Load()
		if cur >= max {
			return false
		}
		if cur+n > max {
			n = max - cur
		}
		if sent.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
