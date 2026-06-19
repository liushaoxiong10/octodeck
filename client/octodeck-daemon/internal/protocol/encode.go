package protocol

import (
	"encoding/json"
	"errors"
)

// EncodeFrame serializes any frame value into its JSON wire form.
func EncodeFrame(frame any) ([]byte, error) {
	if frame == nil {
		return nil, errors.New("encodeFrame: nil")
	}
	return json.Marshal(frame)
}
