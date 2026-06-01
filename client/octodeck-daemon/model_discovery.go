package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type modelDiscoverer struct {
	send func(any) error
}

func newModelDiscoverer(send func(any) error) *modelDiscoverer {
	return &modelDiscoverer{send: send}
}

func (d *modelDiscoverer) handle(ctx context.Context, req *ModelsRequestFrame) {
	go func() {
		started := time.Now()
		models, err := discoverProviderModels(ctx, req.ProviderID)
		var errPtr *string
		if err != nil {
			msg := err.Error()
			errPtr = &msg
		}
		_ = d.send(&ModelsResultFrame{
			Type:       tModelsResult,
			RequestID:  req.RequestID,
			OK:         err == nil,
			Models:     models,
			Error:      errPtr,
			DurationMs: time.Since(started).Milliseconds(),
		})
	}()
}

func discoverProviderModels(ctx context.Context, providerID string) ([]ModelInfo, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return nil, fmt.Errorf("providerId required")
	}
	clients := discoverAgentClients()
	var foundClient *AgentClientInfo
	for _, client := range clients {
		if client.ID == providerID {
			c := client
			foundClient = &c
			break
		}
	}
	if foundClient == nil {
		return nil, fmt.Errorf("provider not found on device: %s", providerID)
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	switch providerID {
	case "claude-code":
		return []ModelInfo{
			{ID: "claude-sonnet-4-5", DisplayName: "Claude Sonnet 4.5"},
			{ID: "claude-opus-4-1", DisplayName: "Claude Opus 4.1"},
			{ID: "sonnet", DisplayName: "Sonnet (CLI alias)"},
			{ID: "opus", DisplayName: "Opus (CLI alias)"},
		}, nil
	case "codex":
		return []ModelInfo{
			{ID: "gpt-5", DisplayName: "GPT-5"},
			{ID: "gpt-5-codex", DisplayName: "GPT-5 Codex"},
		}, nil
	case "traecli":
		return discoverTraeCliModels(ctx, foundClient.Binary)
	default:
		return []ModelInfo{{ID: "default", DisplayName: "Default"}}, nil
	}
}

type traeCliModelJSON struct {
	Name        string `json:"name"`
	RealName    string `json:"real_name"`
	Description string `json:"description"`
}

func discoverTraeCliModels(ctx context.Context, binary string) ([]ModelInfo, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, binary, "models", "--json")
	out, err := cmd.CombinedOutput()
	if cmdCtx.Err() != nil {
		return nil, cmdCtx.Err()
	}
	if err != nil {
		return nil, fmt.Errorf("traecli models --json failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	models, err := parseTraeCliModelsJSON(out)
	if err != nil {
		return nil, err
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("traecli models --json returned no models")
	}
	return models, nil
}

func parseTraeCliModelsJSON(out []byte) ([]ModelInfo, error) {
	var raw []traeCliModelJSON
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse traecli models json failed: %w", err)
	}
	models := make([]ModelInfo, 0, len(raw))
	seen := map[string]struct{}{}
	for _, item := range raw {
		id := strings.TrimSpace(item.Name)
		if id == "" {
			id = strings.TrimSpace(item.RealName)
		}
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		displayName := strings.TrimSpace(item.RealName)
		if displayName == "" {
			displayName = id
		}
		models = append(models, ModelInfo{ID: id, DisplayName: displayName})
	}
	return models, nil
}
