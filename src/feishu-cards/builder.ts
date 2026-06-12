/**
 * Top-level Feishu v2 Agent reply card builders.
 *
 *   buildAgentReplyCard(input)
 *       Terminal (static) card. Header is status-driven: a successful `done`
 *       reply drops the header (unless an explicit title is passed) so short
 *       status messages aren't reduced to a truncated header, while
 *       running/warning/error keep a status-coloured header. Followed by body
 *       chunks + metadata row (2×2) + optional thinking/tool panels + footer.
 *       Suitable for finalized Agent replies and error cards.
 *
 *   buildStreamingAgentCard(opts)
 *       Initial streaming skeleton. Preserves the 5 slot element_ids that
 *       feishu-streaming-card.ts patches via cardElement.content(). The aux
 *       before/after slots remain plain markdown so the existing flush loop
 *       keeps working unchanged.
 */

import { optimizeMarkdownStyle } from '../feishu-markdown-style.js';
import type { AgentCardInput, CardMeta, FeishuCardV2 } from './types.js';
import {
  buildHeader,
  buildMetaRow,
  buildBodyChunks,
  buildThinkingPanel,
  buildToolsPanel,
  buildFooter,
  buildStreamingPanels,
  buildStatusBannerText,
  statusHeadline,
  extractTitle,
  CARD_ELEMENT_IDS,
  type StreamingPanelsInit,
} from './sections.js';
import {
  CARD_MD_LIMIT,
  CARD_SIZE_LIMIT,
  MAX_BODY_ELEMENTS_PER_CARD,
  splitCodeBlockSafe,
} from './length.js';

/** Per-platform typewriter tuning — mobile feels faster, PC breathes more. */
const STREAMING_CONFIG = {
  print_frequency_ms: { default: 30, android: 25, ios: 40, pc: 50 },
  print_step: { default: 2, android: 3, ios: 4, pc: 5 },
  print_strategy: 'fast' as const,
};

export function buildAgentReplyCard(input: AgentCardInput): FeishuCardV2 {
  // Apply Feishu-friendly markdown transformation once, up front.
  // Skip if the caller has already optimized the text (e.g. buildCardBatch
  // pre-optimizes the full text before splitting, so each chunk doesn't
  // get double-optimized — which would double <br> spacing around code blocks).
  const optimizedText = input.skipOptimize
    ? input.text
    : optimizeMarkdownStyle(input.text, 2);
  const optimizedThinking = input.thinking
    ? input.skipOptimize
      ? input.thinking
      : optimizeMarkdownStyle(input.thinking, 2)
    : undefined;

  const explicitTitle = input.title?.trim();
  const body = optimizedText.trim();

  // Header policy is driven by status, not by whether a title was passed:
  //   - done  → drop the header unless an explicit title is given, so short
  //             status replies don't promote their first line into a truncated
  //             header (issue #488).
  //   - running / warning / error → always render a status-coloured header so
  //             the orange/red/blue state semantics survive into the terminal
  //             card and the streaming→terminal transition stays visually
  //             consistent (no header that suddenly disappears).
  // The header title text comes from the explicit title when present, otherwise
  // a minimal status word — never the body's first line.
  const renderHeader = input.status !== 'done' || !!explicitTitle;
  const headlineTitle = explicitTitle ?? statusHeadline(input.status);
  const summaryTitle = renderHeader
    ? input.titlePrefix
      ? `${input.titlePrefix}${headlineTitle}`
      : headlineTitle
    : undefined;

  const normalizedInput: AgentCardInput = {
    ...input,
    text: optimizedText,
    title: explicitTitle,
    thinking: optimizedThinking,
  };

  const header = renderHeader ? buildHeader(normalizedInput) : undefined;
  const elements: Array<Record<string, unknown>> = [];
  if (body) {
    elements.push(...buildBodyChunks(body));
  }

  const metaRow = buildMetaRow(input.meta);
  const thinkingPanel = buildThinkingPanel(optimizedThinking);
  const toolsPanel = buildToolsPanel(input.meta?.toolCalls);
  const footer = buildFooter(input.footer, input.completedAtMs);

  const hasFooterArea =
    metaRow.length + thinkingPanel.length + toolsPanel.length + footer.length >
    0;
  if (hasFooterArea) {
    // Native v2 hr — components.md §hr confirms it's a valid component outside
    // of CardKit's live-streaming patch surface.
    elements.push({ tag: 'hr' });
  }

  elements.push(...metaRow);
  elements.push(...thinkingPanel);
  elements.push(...toolsPanel);
  elements.push(...footer);

  const config: Record<string, unknown> = {
    update_multi: true,
    enable_forward: true,
    width_mode: 'fill',
  };
  if (summaryTitle) {
    config.summary = { content: summaryTitle };
  }

  const card: FeishuCardV2 = {
    schema: '2.0',
    config,
    body: {
      direction: 'vertical',
      vertical_spacing: 'medium',
      elements,
    },
  };
  if (header) {
    card.header = header;
  }
  return card;
}

export interface StreamingCardBuildOptions {
  /** Initial text to seed into the MAIN_CONTENT slot. */
  initialText?: string;
  /** Optional override title (otherwise extracted from initialText). */
  title?: string;
  /** Optional title prefix (e.g. AI name). */
  titlePrefix?: string;
  /** Optional subtitle shown under the title. */
  subtitle?: string;
  /** Optional meta (currently only `model` is used for the header tag). */
  meta?: Pick<CardMeta, 'model'>;
  /** Initial content for structured runtime panels. */
  panels?: StreamingPanelsInit;
  /**
   * If true, use the "rich" structured skeleton (STATUS_BANNER + 4 collapsible
   * panels). If false, use the legacy flat skeleton (AUX_BEFORE/AUX_AFTER).
   * Default: true.
   */
  rich?: boolean;
}

export function buildStreamingAgentCard(
  opts: StreamingCardBuildOptions = {},
): FeishuCardV2 {
  const initialText = opts.initialText ?? '';
  // Header/summary title follows the same status-driven policy as the terminal
  // card: an explicit title wins, otherwise a minimal status word ("生成中") —
  // never the reply's first line. This keeps the streaming→terminal transition
  // consistent instead of moving the first line between header and body.
  const displayTitle = opts.title?.trim() || statusHeadline('running');
  const useRich = opts.rich !== false;

  const header = buildHeader({
    text: initialText,
    status: 'running',
    title: opts.title,
    titlePrefix: opts.titlePrefix,
    subtitle: opts.subtitle,
    meta: opts.meta ? { model: opts.meta.model } : undefined,
  });

  const mainContentEl = {
    tag: 'markdown',
    content: initialText || '...',
    element_id: CARD_ELEMENT_IDS.MAIN_CONTENT,
  };
  const interruptBtn = {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 中断回复' },
    type: 'danger',
    value: { action: 'interrupt_stream' },
    element_id: CARD_ELEMENT_IDS.INTERRUPT_BTN,
  };
  const footerNote = {
    tag: 'markdown',
    content: `<font color='grey'>${buildStatusBannerText({ phase: 'streaming' })}</font>`,
    element_id: CARD_ELEMENT_IDS.FOOTER_NOTE,
    text_size: 'notation',
  };

  const baseConfig = {
    update_multi: true,
    enable_forward: true,
    width_mode: 'fill',
    summary: { content: displayTitle },
    streaming_mode: true,
    streaming_config: STREAMING_CONFIG,
  };

  if (!useRich) {
    return {
      schema: '2.0',
      config: baseConfig,
      header,
      body: {
        direction: 'vertical',
        vertical_spacing: 'medium',
        elements: [
          {
            tag: 'markdown',
            content: '',
            element_id: CARD_ELEMENT_IDS.AUX_BEFORE,
            text_size: 'notation',
          },
          mainContentEl,
          {
            tag: 'markdown',
            content: '',
            element_id: CARD_ELEMENT_IDS.AUX_AFTER,
            text_size: 'notation',
          },
          interruptBtn,
          {
            tag: 'markdown',
            content: '⏳ 生成中...',
            element_id: CARD_ELEMENT_IDS.STATUS_NOTE,
            text_size: 'notation',
          },
        ],
      },
    };
  }

  // Default panel expansion for the streaming skeleton:
  //   thinking → expanded so the user can watch reasoning stream in as it arrives
  //   tools / progress → folded to keep the card compact; STATUS_BANNER still
  //                       surfaces the active tool / todo count at the top.
  const panelsInit: StreamingPanelsInit = {
    expandThinking: true,
    expandTools: false,
    expandProgress: false,
    ...(opts.panels ?? {}),
  };

  return {
    schema: '2.0',
    config: baseConfig,
    header,
    body: {
      direction: 'vertical',
      vertical_spacing: 'medium',
      elements: [
        ...buildStreamingPanels(panelsInit),
        mainContentEl,
        interruptBtn,
        footerNote,
      ],
    },
  };
}

// ─── Multi-card batch builder (shared across streaming + static paths) ──────

export interface CardBatchOptions {
  /** Override auto-extracted title. */
  title?: string;
  /** Title prefix for continuation cards (default: "(续) "). */
  continuationPrefix?: string;
  /**
   * Which card gets the metadata / thinking / tools / footer chrome.
   *   - "last" (default): only the final card shows meta/footer
   *   - "first": only the first card shows meta/footer
   *   - "all": every card shows meta/footer (spammy, not recommended)
   */
  chromePlacement?: 'first' | 'last' | 'all';
  /** Max body markdown elements per card (default: from length.ts). */
  maxBodyElements?: number;
}

/**
 * Build a batch of Feishu cards from a (potentially very long) reply text.
 *
 * Splits the text across multiple cards when it would overflow a single card
 * (either by element count or by total JSON byte size). Every chunk is
 * code-block-safe — no fence is ever cut in half.
 *
 * Usage:
 *   const cards = buildCardBatch(longText, { status: 'done', meta, footer });
 *   for (const card of cards) await sendFeishuCard(chatId, card);
 */
export function buildCardBatch(
  text: string,
  opts: Partial<Omit<AgentCardInput, 'text'>> & CardBatchOptions = {},
): FeishuCardV2[] {
  const {
    status = 'done',
    title: explicitTitle,
    titlePrefix,
    continuationPrefix = '(续) ',
    chromePlacement = 'last',
    maxBodyElements = MAX_BODY_ELEMENTS_PER_CARD,
    ...restInput
  } = opts;

  const optimized = optimizeMarkdownStyle(text.trim(), 2);
  if (!optimized) {
    return [buildAgentReplyCard({ ...restInput, status, text: '', title: explicitTitle, titlePrefix })];
  }

  // 1. Slice into code-block-safe chunks of ~CARD_MD_LIMIT chars each
  const chunks = splitCodeBlockSafe(optimized, CARD_MD_LIMIT);

  // 2. Group chunks into cards (each card has at most maxBodyElements chunks)
  const cardChunkGroups: string[][] = [];
  for (let i = 0; i < chunks.length; i += maxBodyElements) {
    cardChunkGroups.push(chunks.slice(i, i + maxBodyElements));
  }

  // 3. Determine the unified title (for consistent header across cards)
  const unifiedTitle = explicitTitle ?? extractTitle(text).title;

  // 4. Build each card
  const cards: FeishuCardV2[] = cardChunkGroups.map((group, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === cardChunkGroups.length - 1;
    const cardText = group.join('\n\n');

    const hasChrome =
      chromePlacement === 'all' ||
      (chromePlacement === 'first' && isFirst) ||
      (chromePlacement === 'last' && isLast);

    // Header title: first card uses titlePrefix + title,
    // continuation cards use continuationPrefix + title.
    const cardTitle = unifiedTitle;
    const cardTitlePrefix = isFirst ? titlePrefix : continuationPrefix + (titlePrefix ?? '');

    const cardInput: AgentCardInput = {
      ...restInput,
      status,
      text: cardText,
      title: cardTitle,
      titlePrefix: cardTitlePrefix,
      meta: hasChrome ? restInput.meta : undefined,
      thinking: hasChrome ? restInput.thinking : undefined,
      footer: hasChrome ? restInput.footer : undefined,
      completedAtMs: hasChrome ? restInput.completedAtMs : undefined,
      skipOptimize: true, // text is already optimized above
    };

    return buildAgentReplyCard(cardInput);
  });

  // 5. Byte-size safety: if the *last* card still exceeds CARD_SIZE_LIMIT
  //    (e.g. due to heavy chrome), fall back to splitting it further.
  //    This is iterative and conservative — only runs when truly needed.
  const sizedCards: FeishuCardV2[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const size = Buffer.byteLength(JSON.stringify(card), 'utf-8');
    if (size <= CARD_SIZE_LIMIT) {
      sizedCards.push(card);
      continue;
    }
    // Oversized: halve the chunk count and rebuild this card's group
    // (plus re-check; this is rare so a single re-split is enough)
    const group = cardChunkGroups[i];
    const half = Math.max(1, Math.floor(group.length / 2));
    const halfGroups = [group.slice(0, half), group.slice(half)].filter((g) => g.length > 0);
    for (const hg of halfGroups) {
      sizedCards.push(
        buildAgentReplyCard({
          ...restInput,
          status,
          text: hg.join('\n\n'),
          title: unifiedTitle,
          titlePrefix: i === 0 ? titlePrefix : continuationPrefix + (titlePrefix ?? ''),
          // When we split an oversized card, chrome stays on the last sub-card
          // of the original group (approximation — better than losing content).
          meta: undefined,
          thinking: undefined,
          footer: undefined,
          completedAtMs: undefined,
          skipOptimize: true, // text is already optimized
        }),
      );
    }
    // If this was supposed to be the chrome card, move chrome to the last sub-card
    if (chromePlacement === 'last' && i === cards.length - 1) {
      const lastIdx = sizedCards.length - 1;
      const lastCardText = halfGroups[halfGroups.length - 1].join('\n\n');
      sizedCards[lastIdx] = buildAgentReplyCard({
        ...restInput,
        status,
        text: lastCardText,
        title: unifiedTitle,
        titlePrefix: continuationPrefix + (titlePrefix ?? ''),
        meta: restInput.meta,
        thinking: restInput.thinking,
        footer: restInput.footer,
        completedAtMs: restInput.completedAtMs,
        skipOptimize: true,
      });
    }
  }

  return sizedCards;
}
