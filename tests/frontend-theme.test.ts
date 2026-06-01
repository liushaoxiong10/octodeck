import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { COLOR_SCHEMES, resolveEffectiveTheme } from '../web/src/hooks/useTheme.js';

const repoRoot = process.cwd();

describe('frontend theme preferences', () => {
  test('exposes Dracula as a selectable color scheme', () => {
    expect(COLOR_SCHEMES).toContain('dracula');
  });

  test('Dracula color scheme renders with dark-mode variants regardless of selected brightness', () => {
    expect(resolveEffectiveTheme('light', 'dracula', 'light')).toBe('dark');
    expect(resolveEffectiveTheme('system', 'dracula', 'light')).toBe('dark');
    expect(resolveEffectiveTheme('dark', 'dracula', 'light')).toBe('dark');
  });

  test('Dracula has stylesheet tokens and a profile selector option', () => {
    const globals = readFileSync(join(repoRoot, 'web/src/styles/globals.css'), 'utf8');
    const profile = readFileSync(join(repoRoot, 'web/src/components/settings/ProfileSection.tsx'), 'utf8');

    expect(globals).toContain('html.theme-dracula');
    expect(globals).toContain('--background: #282a36');
    expect(globals).toContain('--primary: #bd93f9');
    expect(profile).toContain("value: 'dracula'");
    expect(profile).toContain("label: 'Dracula'");
  });
});
