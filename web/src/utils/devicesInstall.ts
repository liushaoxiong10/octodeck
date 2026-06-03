interface DaemonInstallOptions {
  deviceId: string;
  apiKey: string;
  server: string;
}

function normalizeServerOrigin(server: string): string {
  try {
    return new URL(server).origin;
  } catch {
    return server.replace(/\/+$/, '');
  }
}

export function getCurrentServerOrigin(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

export function buildDaemonInstallUrl(opts: DaemonInstallOptions): string {
  const server = normalizeServerOrigin(opts.server);
  const url = new URL('/api/daemon/install-script', server);
  url.searchParams.set('device', opts.deviceId);
  url.searchParams.set('apiKey', opts.apiKey);
  url.searchParams.set('server', server);
  return url.toString();
}

export function buildDaemonInstallCommand(opts: DaemonInstallOptions): string {
  return `curl -fsSL "${buildDaemonInstallUrl(opts)}" | bash`;
}

export function buildDaemonUpdateCommand(): string {
  return '~/.octodeck/daemon/bin/octodeck-daemon update -config ~/.octodeck/daemon/config.json';
}

export function buildDaemonUninstallCommand(): string {
  return '~/.octodeck/daemon/bin/octodeck-daemon uninstall';
}
