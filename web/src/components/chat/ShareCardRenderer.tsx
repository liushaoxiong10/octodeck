import { forwardRef, useMemo } from 'react';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';

/** Color scheme matching the app-level CSS themes; each skin covers light + dark mode. */
export type ShareCardColorScheme = 'default' | 'orange' | 'neutral' | 'dracula';
export type ShareCardMode = 'light' | 'dark';

export interface ShareCardSkin {
  colorScheme: ShareCardColorScheme;
  mode: ShareCardMode;
}

interface ShareCardRendererProps {
  content: string;
  senderName: string;
  timestamp: string;
  groupJid?: string;
  aiEmoji?: string | null;
  aiColor?: string | null;
  aiImageUrl?: string | null;
  skin?: ShareCardSkin;
}

/**
 * Base semantic tokens for a share card skin. Mirrors the shadcn/ui tokens used
 * in globals.css so the exported image visually matches what the user sees in app.
 * Also includes literal inline colors for the card chrome (header, footer, border,
 * gradient fade) which bypass Tailwind classes entirely.
 */
interface ShareCardSkinTokens {
  /** CSS variables injected onto the card root (drives MarkdownRenderer's Tailwind classes). */
  vars: Record<string, string>;
  /** Inline chrome colors (background, header/footer, borders, text, fade). */
  chrome: {
    background: string;
    foreground: string;
    headerBg: string;
    headerBorder: string;
    headerName: string;
    timestamp: string;
    footerBg: string;
    footerBorder: string;
    footerText: string;
    fade: string;
  };
}

const DEFAULT_BRAND: Record<string, string> = {
  '--brand-50': '#f0fdfa', '--brand-100': '#ccfbf1', '--brand-200': '#99f6e4',
  '--brand-300': '#5eead4', '--brand-400': '#2dd4bf', '--brand-500': '#0d9488',
  '--brand-600': '#0f766e', '--brand-700': '#115e59',
};
const ORANGE_BRAND: Record<string, string> = {
  '--brand-50': '#fff7ed', '--brand-100': '#ffedd5', '--brand-200': '#fed7aa',
  '--brand-300': '#fdba74', '--brand-400': '#fb923c', '--brand-500': '#f97316',
  '--brand-600': '#ea580c', '--brand-700': '#c2410c',
};
const NEUTRAL_BRAND: Record<string, string> = {
  '--brand-50': '#fafafa', '--brand-100': '#f4f4f5', '--brand-200': '#e4e4e7',
  '--brand-300': '#d4d4d8', '--brand-400': '#a1a1aa', '--brand-500': '#71717a',
  '--brand-600': '#52525b', '--brand-700': '#3f3f46',
};
const DRACULA_BRAND: Record<string, string> = {
  '--brand-50': '#2d233f', '--brand-100': '#3f2e5f', '--brand-200': '#533d7d',
  '--brand-300': '#6d52a3', '--brand-400': '#8a69c8', '--brand-500': '#bd93f9',
  '--brand-600': '#d6b8ff', '--brand-700': '#eee0ff',
};

function buildTokens(
  base: { bg: string; fg: string; card: string; cardFg: string; secondary: string; secondaryFg: string; muted: string; mutedFg: string; accent: string; accentFg: string; border: string; input: string; ring: string; destructive: string; destructiveFg: string; primaryFg: string; codeBg: string; inlineCodeBg: string; inlineCodeText: string },
  brand: Record<string, string>,
  chrome: ShareCardSkinTokens['chrome'],
): ShareCardSkinTokens {
  return {
    vars: {
      '--background': base.bg,
      '--foreground': base.fg,
      '--card': base.card,
      '--card-foreground': base.cardFg,
      '--popover': base.card,
      '--popover-foreground': base.cardFg,
      '--primary': brand['--brand-500'],
      '--primary-foreground': base.primaryFg,
      '--secondary': base.secondary,
      '--secondary-foreground': base.secondaryFg,
      '--muted': base.muted,
      '--muted-foreground': base.mutedFg,
      '--accent': base.accent,
      '--accent-foreground': base.accentFg,
      '--destructive': base.destructive,
      '--destructive-foreground': base.destructiveFg,
      '--border': base.border,
      '--input': base.input,
      '--ring': base.ring,
      '--surface': base.card,
      '--code-block-bg': base.codeBg,
      '--inline-code-bg': base.inlineCodeBg,
      '--inline-code-text': base.inlineCodeText,
      ...brand,
    },
    chrome,
  };
}

const SKINS: Record<string, ShareCardSkinTokens> = {
  'default-light': buildTokens(
    { bg: '#ffffff', fg: '#0f172a', card: '#ffffff', cardFg: '#0f172a', secondary: '#f1f5f9', secondaryFg: '#0f172a', muted: '#f1f5f9', mutedFg: '#64748b', accent: '#f0fdfa', accentFg: '#134e4a', border: '#e2e8f0', input: '#e2e8f0', ring: '#0d9488', destructive: '#dc2626', destructiveFg: '#ffffff', primaryFg: '#ffffff', codeBg: '#f6f8fa', inlineCodeBg: 'rgba(13,148,136,0.10)', inlineCodeText: '#0d9488' },
    DEFAULT_BRAND,
    { background: '#ffffff', foreground: '#0f172a', headerBg: '#f8fafc', headerBorder: '#e2e8f0', headerName: '#0f172a', timestamp: '#64748b', footerBg: '#f8fafc', footerBorder: '#e2e8f0', footerText: '#94a3b8', fade: '#ffffff' },
  ),
  'default-dark': buildTokens(
    { bg: '#0f172a', fg: '#f1f5f9', card: '#111c32', cardFg: '#f1f5f9', secondary: '#1e293b', secondaryFg: '#f1f5f9', muted: '#1e293b', mutedFg: '#94a3b8', accent: '#0f3734', accentFg: '#5eead4', border: '#1e3a5f', input: '#1e3a5f', ring: '#2dd4bf', destructive: '#ef4444', destructiveFg: '#ffffff', primaryFg: '#0f172a', codeBg: '#0b1224', inlineCodeBg: 'rgba(45,212,191,0.18)', inlineCodeText: '#5eead4' },
    {
      '--brand-50': '#042f2e', '--brand-100': '#134e4a', '--brand-200': '#115e59',
      '--brand-300': '#0f766e', '--brand-400': '#0d9488', '--brand-500': '#14b8a6',
      '--brand-600': '#2dd4bf', '--brand-700': '#5eead4',
    },
    { background: '#0f172a', foreground: '#f1f5f9', headerBg: '#11223f', headerBorder: '#1e3a5f', headerName: '#f1f5f9', timestamp: '#94a3b8', footerBg: '#11223f', footerBorder: '#1e3a5f', footerText: '#64748b', fade: '#0f172a' },
  ),
  'orange-light': buildTokens(
    { bg: '#FAF9F5', fg: '#141413', card: '#F0EEE6', cardFg: '#141413', secondary: '#F0EEE6', secondaryFg: '#141413', muted: '#F0EEE6', mutedFg: '#8b857d', accent: '#F0EEE6', accentFg: '#141413', border: '#DAD9D5', input: '#DAD9D5', ring: '#8b857d', destructive: '#b91c1c', destructiveFg: '#ffffff', primaryFg: '#ffffff', codeBg: 'rgba(61,61,58,0.05)', inlineCodeBg: 'rgba(61,61,58,0.05)', inlineCodeText: 'rgb(138,36,36)' },
    ORANGE_BRAND,
    { background: '#FAF9F5', foreground: '#141413', headerBg: '#F0EEE6', headerBorder: '#DAD9D5', headerName: '#141413', timestamp: '#8b857d', footerBg: '#F0EEE6', footerBorder: '#DAD9D5', footerText: '#a8a29a', fade: '#FAF9F5' },
  ),
  'orange-dark': buildTokens(
    { bg: 'oklch(0.145 0 0)', fg: 'oklch(0.985 0 0)', card: 'oklch(0.205 0 0)', cardFg: 'oklch(0.985 0 0)', secondary: 'oklch(0.274 0.006 286.033)', secondaryFg: 'oklch(0.985 0 0)', muted: 'oklch(0.269 0 0)', mutedFg: 'oklch(0.708 0 0)', accent: 'oklch(0.269 0 0)', accentFg: 'oklch(0.985 0 0)', border: 'rgba(255,255,255,0.10)', input: 'rgba(255,255,255,0.15)', ring: 'oklch(0.556 0 0)', destructive: 'oklch(0.704 0.191 22.216)', destructiveFg: '#ffffff', primaryFg: 'oklch(0.98 0.016 73.684)', codeBg: 'rgba(200,200,195,0.08)', inlineCodeBg: 'rgba(200,200,195,0.10)', inlineCodeText: 'rgb(220,140,140)' },
    {
      '--brand-50': '#431407', '--brand-100': '#7c2d12', '--brand-200': '#9a3412',
      '--brand-300': '#c2410c', '--brand-400': '#ea580c', '--brand-500': '#f97316',
      '--brand-600': '#fb923c', '--brand-700': '#fdba74',
    },
    { background: '#1a1613', foreground: '#faf9f5', headerBg: '#261f1b', headerBorder: 'rgba(255,255,255,0.10)', headerName: '#faf9f5', timestamp: '#a0958a', footerBg: '#261f1b', footerBorder: 'rgba(255,255,255,0.10)', footerText: '#6b6259', fade: '#1a1613' },
  ),
  'neutral-light': buildTokens(
    { bg: '#ffffff', fg: '#18181b', card: '#f4f4f5', cardFg: '#18181b', secondary: '#f4f4f5', secondaryFg: '#18181b', muted: '#f4f4f5', mutedFg: '#71717a', accent: '#f4f4f5', accentFg: '#18181b', border: '#e4e4e7', input: '#e4e4e7', ring: '#a1a1aa', destructive: '#dc2626', destructiveFg: '#ffffff', primaryFg: '#ffffff', codeBg: '#f4f4f5', inlineCodeBg: 'rgba(82,82,91,0.08)', inlineCodeText: '#3f3f46' },
    NEUTRAL_BRAND,
    { background: '#ffffff', foreground: '#18181b', headerBg: '#fafafa', headerBorder: '#e4e4e7', headerName: '#18181b', timestamp: '#71717a', footerBg: '#fafafa', footerBorder: '#e4e4e7', footerText: '#a1a1aa', fade: '#ffffff' },
  ),
  'neutral-dark': buildTokens(
    { bg: '#09090b', fg: '#fafafa', card: '#18181b', cardFg: '#fafafa', secondary: '#27272a', secondaryFg: '#fafafa', muted: '#27272a', mutedFg: '#a1a1aa', accent: '#27272a', accentFg: '#fafafa', border: '#27272a', input: '#27272a', ring: '#52525b', destructive: '#ef4444', destructiveFg: '#ffffff', primaryFg: '#09090b', codeBg: '#1f1f23', inlineCodeBg: 'rgba(161,161,170,0.14)', inlineCodeText: '#d4d4d8' },
    {
      '--brand-50': '#18181b', '--brand-100': '#27272a', '--brand-200': '#3f3f46',
      '--brand-300': '#52525b', '--brand-400': '#71717a', '--brand-500': '#a1a1aa',
      '--brand-600': '#d4d4d8', '--brand-700': '#e4e4e7',
    },
    { background: '#09090b', foreground: '#fafafa', headerBg: '#151518', headerBorder: '#27272a', headerName: '#fafafa', timestamp: '#a1a1aa', footerBg: '#151518', footerBorder: '#27272a', footerText: '#52525b', fade: '#09090b' },
  ),
  // Dracula is intentionally dark-only (matches the CSS theme).
  'dracula-light': buildTokens(
    { bg: '#282a36', fg: '#f8f8f2', card: '#343746', cardFg: '#f8f8f2', secondary: '#44475a', secondaryFg: '#f8f8f2', muted: '#44475a', mutedFg: '#b6b6c9', accent: '#3f3658', accentFg: '#ff79c6', border: '#4a4d63', input: '#4a4d63', ring: '#bd93f9', destructive: '#ff5555', destructiveFg: '#f8f8f2', primaryFg: '#282a36', codeBg: '#21222c', inlineCodeBg: 'rgba(189,147,249,0.16)', inlineCodeText: '#ff79c6' },
    DRACULA_BRAND,
    { background: '#282a36', foreground: '#f8f8f2', headerBg: '#21222c', headerBorder: '#44475a', headerName: '#f8f8f2', timestamp: '#b6b6c9', footerBg: '#21222c', footerBorder: '#44475a', footerText: '#6272a4', fade: '#282a36' },
  ),
  'dracula-dark': buildTokens(
    { bg: '#282a36', fg: '#f8f8f2', card: '#343746', cardFg: '#f8f8f2', secondary: '#44475a', secondaryFg: '#f8f8f2', muted: '#44475a', mutedFg: '#b6b6c9', accent: '#3f3658', accentFg: '#ff79c6', border: '#4a4d63', input: '#4a4d63', ring: '#bd93f9', destructive: '#ff5555', destructiveFg: '#f8f8f2', primaryFg: '#282a36', codeBg: '#21222c', inlineCodeBg: 'rgba(189,147,249,0.18)', inlineCodeText: '#ff79c6' },
    DRACULA_BRAND,
    { background: '#282a36', foreground: '#f8f8f2', headerBg: '#21222c', headerBorder: '#44475a', headerName: '#f8f8f2', timestamp: '#b6b6c9', footerBg: '#21222c', footerBorder: '#44475a', footerText: '#6272a4', fade: '#282a36' },
  ),
};

export function resolveSkinTokens(skin?: ShareCardSkin | null): ShareCardSkinTokens {
  const colorScheme = skin?.colorScheme ?? 'orange';
  // Dracula has no light mode; fall back to dark regardless of user preference.
  const mode = colorScheme === 'dracula' ? 'dark' : (skin?.mode ?? 'light');
  const key = `${colorScheme}-${mode}` as const;
  return SKINS[key];
}

/** Dropdown / radio options exposed in the share dialog, matching ProfileSection.tsx. */
export const SHARE_CARD_COLOR_SCHEMES: { value: ShareCardColorScheme; label: string; preview: { bg: string; accent: string; text: string } }[] = [
  { value: 'default', label: '经典绿', preview: { bg: '#ffffff', accent: '#0d9488', text: '#0f172a' } },
  { value: 'orange', label: '暖橙', preview: { bg: '#FAF9F5', accent: '#f97316', text: '#141413' } },
  { value: 'neutral', label: '素白', preview: { bg: '#ffffff', accent: '#52525b', text: '#18181b' } },
  { value: 'dracula', label: 'Dracula', preview: { bg: '#282a36', accent: '#bd93f9', text: '#f8f8f2' } },
];

export const SHARE_CARD_MODES: { value: ShareCardMode; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const MAX_HEIGHT = 20000;
export const SHARE_CARD_DEFAULT_WIDTH = 720;
export const SHARE_CARD_MAX_WIDTH = 1200;
export const SHARE_CARD_PADDING = 48; // 24px * 2

/**
 * Override styles for the share card content area.
 * Tables are allowed to expand the card width (up to MAX_WIDTH).
 * Non-table content wraps at whatever the current card width is.
 */
const CONTENT_OVERRIDE_STYLE = `
  .share-card-content {
    overflow-wrap: break-word !important;
    word-break: break-word !important;
  }
  .share-card-content th,
  .share-card-content td {
    white-space: normal !important;
    word-break: break-word !important;
  }
  .share-card-content pre {
    white-space: pre-wrap !important;
    word-break: break-all !important;
  }
  .share-card-content code {
    word-break: break-all !important;
  }
  .share-card-content .overflow-x-auto {
    overflow: visible !important;
  }
`;

export const ShareCardRenderer = forwardRef<HTMLDivElement, ShareCardRendererProps>(
  function ShareCardRenderer(
    { content, senderName, timestamp, groupJid, aiEmoji, aiColor, aiImageUrl, skin },
    ref,
  ) {
    const tokens = useMemo(() => resolveSkinTokens(skin ?? null), [skin]);
    const themeVars = tokens.vars as unknown as React.CSSProperties;
    const chrome = tokens.chrome;

    return (
      <div
        ref={ref}
        style={{
          ...themeVars,
          minWidth: SHARE_CARD_DEFAULT_WIDTH,
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: chrome.background,
          color: chrome.foreground,
          borderRadius: 16,
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        <style>{CONTENT_OVERRIDE_STYLE}</style>

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
            borderBottom: `1px solid ${chrome.headerBorder}`,
            background: chrome.headerBg,
            borderRadius: '16px 16px 0 0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <EmojiAvatar
              imageUrl={aiImageUrl}
              emoji={aiEmoji}
              color={aiColor}
              fallbackChar={senderName[0]}
              size="md"
            />
            <span style={{ fontSize: 15, fontWeight: 600, color: chrome.headerName }}>{senderName}</span>
          </div>
          <span style={{ fontSize: 13, color: chrome.timestamp, whiteSpace: 'nowrap', marginLeft: 16 }}>{timestamp}</span>
        </div>

        {/* Content */}
        <div
          style={{
            padding: '20px 24px',
            maxHeight: MAX_HEIGHT,
            position: 'relative',
          }}
        >
          <div className="share-card-content max-w-none">
            <MarkdownRenderer content={content} groupJid={groupJid} variant="chat" eagerImages />
          </div>
          {/* Gradient fade for extremely long content */}
          {content.length > 30000 && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 80,
                background: `linear-gradient(transparent, ${chrome.fade})`,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px 24px',
            gap: '6px',
            borderTop: `1px solid ${chrome.footerBorder}`,
            background: chrome.footerBg,
            borderRadius: '0 0 16px 16px',
          }}
        >
          <img
            src="/icons/icon-192.png"
            alt="OctoDeck"
            style={{ width: 16, height: 16, borderRadius: 3 }}
          />
          <span style={{ fontSize: 12, color: chrome.footerText }}>
            OctoDeck · github.com/liushaoxiong10/octodeck
          </span>
        </div>
      </div>
    );
  },
);
