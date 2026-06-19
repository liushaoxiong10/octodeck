// Consolidated from: workspacefs/workspacefs.go (IsManagedURI)
package workspace

import "strings"

// IsManagedURI reports whether value is a managed device workspace or tmp URI.
// Consolidated from workspacefs.IsManagedURI.
func IsManagedURI(value string) bool {
	return strings.HasPrefix(value, DeviceWorkspaceURIPrefix) || strings.HasPrefix(value, DeviceTmpURIPrefix)
}
