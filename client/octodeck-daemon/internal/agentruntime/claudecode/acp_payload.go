package claudecode

import (
	"encoding/json"
	"reflect"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
)

// SDKPayload marshals an acpsdk value to a generic map[string]any, applying
// tool-call enrichment so that downstream consumers can find toolUseId / name
// / input / result regardless of which variant the agent used.
func SDKPayload(value any) map[string]any {
	data, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil || payload == nil {
		return map[string]any{}
	}
	EnrichToolPayload(payload)
	return payload
}

// SDKPayloadVariant serializes an ACP variant struct (one of the SessionUpdate
// discriminated union members). These types declare their variant fields with
// `json:"-"` and rely on a custom UnmarshalJSON, so a plain json.Marshal would
// drop most data. This helper marshals the value through reflection so we
// surface every exported field to the caller.
func SDKPayloadVariant(value any) map[string]any {
	payload := make(map[string]any)
	v := reflect.ValueOf(value)
	if v.Kind() == reflect.Ptr {
		if v.IsNil() {
			return payload
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		data, err := json.Marshal(value)
		if err != nil {
			return payload
		}
		_ = json.Unmarshal(data, &payload)
		EnrichToolPayload(payload)
		return payload
	}
	t := v.Type()
	for i := 0; i < v.NumField(); i++ {
		fv := v.Field(i)
		ft := t.Field(i)
		if !ft.IsExported() {
			continue
		}
		name := ft.Name
		if tag, ok := ft.Tag.Lookup("json"); ok {
			parts := strings.Split(tag, ",")
			if parts[0] == "-" {
				// Keep the Go field name. ACP variants tag their data fields
				// json:"-" because the wire format puts the value under a
				// different key resolved by custom UnmarshalJSON.
			} else if parts[0] != "" {
				name = parts[0]
			}
		}
		if fv.Kind() == reflect.Ptr {
			if fv.IsNil() {
				continue
			}
			payload[name] = fv.Elem().Interface()
			continue
		}
		if fv.Kind() == reflect.Interface {
			if fv.IsNil() {
				continue
			}
		}
		if fv.Kind() == reflect.Slice || fv.Kind() == reflect.Map {
			if fv.IsNil() {
				continue
			}
		}
		payload[name] = fv.Interface()
	}
	EnrichToolPayload(payload)
	return payload
}

// SDKContentBlockText extracts a plain-text representation of an acpsdk
// ContentBlock. When includeThinking is true, "thinking"/"reasoning" blocks
// are also concatenated.
func SDKContentBlockText(block acpsdk.ContentBlock, includeThinking bool) string {
	if block.Text != nil {
		return block.Text.Text
	}
	data, err := json.Marshal(block)
	if err != nil {
		return ""
	}
	var payload any
	if json.Unmarshal(data, &payload) != nil {
		return ""
	}
	return ContentText(payload, includeThinking)
}
