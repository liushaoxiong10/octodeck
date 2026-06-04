import { describe, expect, test } from 'vitest';

import { clearSessionCookies } from '../src/auth.js';
import { getSessionCookieValues } from '../src/middleware/auth.js';

describe('auth cookie migration', () => {
  test('accepts legacy HappyClaw session cookie during OctoDeck rename', () => {
    const values = getSessionCookieValues('happyclaw_session=legacy-token');

    expect(values).toEqual(['legacy-token']);
  });

  test('prefers new OctoDeck cookie before legacy cookie', () => {
    const values = getSessionCookieValues(
      'happyclaw_session=legacy-token; octodeck_session=new-token',
    );

    expect(values).toEqual(['new-token', 'legacy-token']);
  });

  test('clears both OctoDeck and legacy HappyClaw cookies on logout', () => {
    const cookies = clearSessionCookies({
      req: {
        header: () => undefined,
        url: 'http://localhost/api/auth/logout',
      },
    });

    expect(cookies).toEqual([
      'octodeck_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      'happyclaw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    ]);
  });
});
