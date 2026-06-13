function hasArg(argv: string[], ...names: string[]): boolean {
  return argv.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)));
}

function insertBeforeTail(argv: string[], tailCount: number, extra: string[]): string[] {
  if (extra.length === 0) return argv;
  const index = Math.max(0, argv.length - tailCount);
  return [...argv.slice(0, index), ...extra, ...argv.slice(index)];
}

function agentFamily(agentClientId: string | undefined | null): 'claude' | 'codex' | 'traecli' | 'traex' | 'unknown' {
  const id = (agentClientId || '').toLowerCase();
  if (id === 'claude-code' || id === 'claude-acp' || id.includes('claude')) return 'claude';
  if (id === 'traex' || id === 'traex-acp' || id.includes('traex')) return 'traex';
  if (id === 'codex' || id === 'codex-acp' || id.includes('codex')) return 'codex';
  if (id === 'traecli' || id === 'traecli-acp' || id.includes('traecli')) return 'traecli';
  return 'unknown';
}

export function normalizePermissionModeForAgent(
  agentClientId: string | undefined | null,
  permissionMode: string | null | undefined,
): string | undefined {
  const mode = permissionMode?.trim();
  if (!mode || mode === 'default') return undefined;
  const family = agentFamily(agentClientId);
  if (family === 'codex') {
    switch (mode) {
      case 'bypassPermissions':
      case 'dangerously-skip-permissions':
      case 'no-approval':
      case 'auto-approve':
        return 'full-access';
      default:
        return mode;
    }
  }
  if (family === 'traex') {
    // traex 区分「审批预设」(--permission-mode) 与「沙箱策略」(--sandbox)，
    // 这里只把各种免审批别名归一到 bypassPermissions，其余模式原样保留。
    switch (mode) {
      case 'dangerously-skip-permissions':
      case 'no-approval':
      case 'auto-approve':
        return 'bypassPermissions';
      default:
        return mode;
    }
  }
  return mode;
}

// traex 把 OctoDeck 的权限模式映射到自身原生的根级参数：
//   bypassPermissions -> --permission-mode bypass_permissions（免审批，保留沙箱）
//   read-only / workspace-write / full-access -> --sandbox <policy>（沙箱级别）
// 这些都是根级参数，必须置于 exec / acp 等子命令之前。
function traexPermissionArgs(mode: string): string[] {
  switch (mode) {
    case 'bypassPermissions':
      return ['--permission-mode', 'bypass_permissions'];
    case 'read-only':
      return ['--sandbox', 'read-only'];
    case 'workspace-write':
      return ['--sandbox', 'workspace-write'];
    case 'full-access':
    case 'danger-full-access':
      return ['--sandbox', 'danger-full-access'];
    default:
      return [];
  }
}

export function applyAgentPermissionArgs(
  argv: string[],
  agentClientId: string | undefined | null,
  permissionMode: string | null | undefined,
): string[] {
  const mode = normalizePermissionModeForAgent(agentClientId, permissionMode);
  if (!mode) return argv;

  const family = agentFamily(agentClientId);
  if (family === 'claude') {
    if (hasArg(argv, '--permission-mode', '--dangerously-skip-permissions')) return argv;
    return [...argv, '--permission-mode', mode];
  }

  if (family === 'traecli') {
    if (mode !== 'bypassPermissions') return argv;
    if (hasArg(argv, '-y', '--yes')) return argv;
    return [...argv, '-y'];
  }

  if (family === 'codex') {
    const extra: string[] = [];
    const normalized = mode === 'full-access' ? 'danger-full-access' : mode;
    if (!hasArg(argv, '--sandbox') && ['read-only', 'workspace-write', 'danger-full-access'].includes(normalized)) {
      extra.push('--sandbox', normalized);
    }
    if (!hasArg(argv, '--ask-for-approval') && (mode === 'full-access' || normalized === 'danger-full-access')) {
      extra.push('--ask-for-approval', 'never');
    }
    if (extra.length === 0) return argv;
    const tailCount = argv[0] === 'exec' && argv[1] === 'resume' ? 2 : 1;
    return insertBeforeTail(argv, tailCount, extra);
  }

  if (family === 'traex') {
    if (hasArg(argv, '--permission-mode', '--sandbox', '--dangerously-bypass-approvals-and-sandbox', '-y'))
      return argv;
    const extra = traexPermissionArgs(mode);
    if (extra.length === 0) return argv;
    return [...extra, ...argv];
  }

  return argv;
}
