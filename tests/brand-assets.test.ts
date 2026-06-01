import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('brand assets', () => {
  test.each([
    'web/public/icons/logo-text.svg',
    'web/public/icons/loading-logo.svg',
  ])('%s renders the OctoDeck wordmark', (file) => {
    const svg = readFileSync(file, 'utf8');

    expect(svg).toContain('OctoDeck');
    expect(svg).not.toMatch(/Letter \d+: h|HappyClaw/i);
    expect(svg).toMatch(/fill="#F57F28"[^>]*>OctoDeck</);
  });

  test('sidebar wordmark is text-only to avoid duplicate app icons', () => {
    const svg = readFileSync('web/public/icons/logo-text.svg', 'utf8');

    expect(svg).not.toContain('octo-mark');
    expect(svg).not.toContain('<circle');
    expect(svg).not.toContain('<rect');
  });

  test.each([
    'web/public/favicon.svg',
    'web/public/icons/logo-icon.svg',
    'web/public/icons/icon-192.svg',
    'web/public/icons/icon-512.svg',
  ])('%s uses the OctoDeck octopus mark instead of the legacy claw', (file) => {
    const svg = readFileSync(file, 'utf8');

    expect(svg).toContain('OctoDeck icon');
    expect(svg).toContain('octopus-head');
    expect(svg).toContain('deck-screen');
    expect(svg).not.toContain('clip0_217_4');
    expect(svg).not.toContain('M781.156 348.889');
  });

  test.each([
    'apple-touch-icon-180.png',
    'icon-48.png',
    'icon-72.png',
    'icon-96.png',
    'icon-128.png',
    'icon-144.png',
    'icon-152.png',
    'icon-192.png',
    'icon-384.png',
    'icon-512.png',
    'icon-512-maskable.png',
    'logo-1024.png',
  ])('generated PNG icon exists: %s', (name) => {
    expect(existsSync(`web/public/icons/${name}`)).toBe(true);
  });
});
