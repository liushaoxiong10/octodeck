import { describe, expect, test } from 'vitest';

import {
  buildDaemonInstallCommand,
  buildDaemonInstallUrl,
} from '../web/src/utils/devicesInstall.js';

describe('devices daemon install command', () => {
  test('builds a curl pipe command with encoded device token and server', () => {
    const command = buildDaemonInstallCommand({
      deviceId: 'cl_1234567890abcdef',
      apiKey: 'hNMmUmbs9z2UX_UPQEvkmFaR-v2gJvoujXadC-tcARE',
      server: 'https://seedclaw.byted.org/',
    });

    expect(command).toBe(
      'curl -fsSL "https://seedclaw.byted.org/api/daemon/install-script?device=cl_1234567890abcdef&apiKey=hNMmUmbs9z2UX_UPQEvkmFaR-v2gJvoujXadC-tcARE&server=https%3A%2F%2Fseedclaw.byted.org" | bash',
    );
  });

  test('normalizes server origin before generating install URL', () => {
    const url = buildDaemonInstallUrl({
      deviceId: 'cl_abc',
      apiKey: 'tok',
      server: 'https://seedclaw.byted.org/app/devices?x=1',
    });

    expect(url).toBe(
      'https://seedclaw.byted.org/api/daemon/install-script?device=cl_abc&apiKey=tok&server=https%3A%2F%2Fseedclaw.byted.org',
    );
  });
});
