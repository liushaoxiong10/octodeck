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
  if (family === 'codex' || family === 'traex') {
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
  return mode;
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
    if (mode !== 'full-access' && mode !== 'danger-full-access') return argv;
    if (hasArg(argv, '--dangerously-bypass-approvals-and-sandbox')) return argv;
    return ['--dangerously-bypass-approvals-and-sandbox', ...argv];
  }

  return argv;
}
