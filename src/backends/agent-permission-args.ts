import { inferAgentClientFamily } from './agent-client-families.js';

function hasArg(argv: string[], ...names: string[]): boolean {
  return argv.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)));
}

function insertBeforeTail(argv: string[], tailCount: number, extra: string[]): string[] {
  if (extra.length === 0) return argv;
  const index = Math.max(0, argv.length - tailCount);
  return [...argv.slice(0, index), ...extra, ...argv.slice(index)];
}

function agentFamily(agentClientId: string | undefined | null): 'claude' | 'codex' | 'traecli' | 'traex' | 'unknown' {
  return inferAgentClientFamily(agentClientId) ?? 'unknown';
}

export function normalizePermissionModeForAgent(
  agentClientId: string | undefined | null,
  permissionMode: string | null | undefined,
): string | undefined {
  const mode = permissionMode?.trim();
  if (!mode) return undefined;
  const family = agentFamily(agentClientId);
  if (family === 'codex') {
    switch (mode) {
      case 'default':
      case 'plan':
        return 'read-only';
      case 'acceptEdits':
        return 'workspace-write';
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
    // default / plan 走 TraeX 原生 permission preset，其余按沙箱或免审批别名映射。
    switch (mode) {
      case 'default':
      case 'plan':
        return mode;
      case 'acceptEdits':
        return 'workspace-write';
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
//   default / plan -> --permission-mode <mode>（使用 TraeX 原生审批预设）
//   acceptEdits -> --sandbox workspace-write（工作区编辑免逐次审批）
//   read-only / workspace-write / full-access -> --sandbox <policy>（沙箱级别）
// 这些都是根级参数，必须置于 exec / acp 等子命令之前。
function traexPermissionArgs(mode: string): string[] {
  switch (mode) {
    case 'default':
    case 'plan':
      return ['--permission-mode', mode];
    case 'bypassPermissions':
      return ['--permission-mode', 'bypass_permissions'];
    case 'read-only':
      return ['--sandbox', 'read-only'];
    case 'acceptEdits':
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
