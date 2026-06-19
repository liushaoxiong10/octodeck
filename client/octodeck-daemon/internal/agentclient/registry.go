package agentclient

import (
	"fmt"
	"sort"
	"sync"
)

// descriptorRegistry 是进程内全局 descriptor 注册中心，由各 family 子包
// 在 init() 中通过 Register 写入；daemon 主流程通过 RegisteredDescriptors
// / DescriptorByID / DescriptorByFamily 读取。
//
// 注册中心是线程安全的，但典型用法是 init 期间一次写入、运行期只读。
var (
	registryMu          sync.RWMutex
	registryByID        = make(map[string]Descriptor)
	registryInsertOrder = make([]string, 0, 8)
)

// Register 把一个 Descriptor 注册到全局注册中心。重复注册（相同 ID）将
// panic，以便在启动期就暴露 family 子包之间的 ID 冲突，而不是在 runtime
// 偷偷覆盖。
func Register(d Descriptor) {
	if d.ID == "" {
		panic("agentclient.Register: descriptor ID must not be empty")
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	if existing, exists := registryByID[d.ID]; exists {
		if existing.Family == d.Family && existing.Binary == d.Binary {
			return
		}
		panic(fmt.Sprintf("agentclient.Register: duplicate descriptor id %q", d.ID))
	}
	// 拷贝 slice 防止外部 caller 持有同一份底层数组导致后续被改。
	d.Args = append([]string(nil), d.Args...)
	d.SearchDirs = append([]string(nil), d.SearchDirs...)
	d.VersionArgs = append([]string(nil), d.VersionArgs...)
	d.PermissionModes = append([]string(nil), d.PermissionModes...)
	d.Capabilities = append([]string(nil), d.Capabilities...)
	registryByID[d.ID] = d
	registryInsertOrder = append(registryInsertOrder, d.ID)
}

// RegisteredDescriptors 返回当前已注册 descriptor 的拷贝，按注册顺序输出。
// 调用方可以对返回值任意修改，不会影响注册中心。
func RegisteredDescriptors() []Descriptor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]Descriptor, 0, len(registryInsertOrder))
	for _, id := range registryInsertOrder {
		out = append(out, copyDescriptor(registryByID[id]))
	}
	return out
}

// DescriptorByID 按 descriptor ID 精确查找。
func DescriptorByID(id string) (Descriptor, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	d, ok := registryByID[id]
	if !ok {
		return Descriptor{}, false
	}
	return copyDescriptor(d), true
}

// DescriptorByFamily 返回首个匹配 family 的 descriptor。同一 family 可能
// 有多个 descriptor（例如 claude-code + claude-acp），调用方关心的是
// "存在某个属于这个 family 的注册" 这件事，因此返回第一个即可；如需全部
// 可自行使用 RegisteredDescriptors() 过滤。
func DescriptorByFamily(family string) (Descriptor, bool) {
	if family == "" {
		return Descriptor{}, false
	}
	registryMu.RLock()
	defer registryMu.RUnlock()
	// 按 ID 字典序遍历以保证调用结果稳定。
	ids := make([]string, 0, len(registryByID))
	for id := range registryByID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if registryByID[id].Family == family {
			return copyDescriptor(registryByID[id]), true
		}
	}
	return Descriptor{}, false
}

func copyDescriptor(d Descriptor) Descriptor {
	d.Args = append([]string(nil), d.Args...)
	d.SearchDirs = append([]string(nil), d.SearchDirs...)
	d.VersionArgs = append([]string(nil), d.VersionArgs...)
	d.PermissionModes = append([]string(nil), d.PermissionModes...)
	d.Capabilities = append([]string(nil), d.Capabilities...)
	return d
}

// resetRegistryForTest 仅用于测试场景重置注册中心，由同包的 _test.go
// 通过 Go 内部可见性调用。
func resetRegistryForTest() {
	registryMu.Lock()
	defer registryMu.Unlock()
	registryByID = make(map[string]Descriptor)
	registryInsertOrder = registryInsertOrder[:0]
}
