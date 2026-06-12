/**
 * Shared length-aware utilities for Feishu card rendering.
 *
 * Two tiers of text splitting, serving different purposes:
 *
 *   1. splitIntoBodySections() — paragraph-level packing into collapsible
 *      sections for a SINGLE card. Never clips code blocks mid-fence; never
 *      silenty truncates the tail (the old MAX_SECTIONS=4 clip is gone).
 *
 *   2. splitCodeBlockSafe() — character-level hard split that preserves
 *      fenced code block integrity. Used when slicing text across MULTIPLE
 *      cards (multi-card batch).
 *
 * Constants here are the single source of truth for size limits; both the
 * static card builder (feishu-cards/) and the streaming card controller
 * (feishu-streaming-card.ts) import from here.
 */

// ─── Constants (single source of truth) ───────────────────────────

/** Max chars per markdown element in a Feishu card. */
export const CARD_MD_LIMIT = 4000;

/**
 * Max JSON byte size for a single Feishu interactive card.
 * Feishu's actual limit is ~30 KB; we leave a 5 KB safety margin.
 */
export const CARD_SIZE_LIMIT = 25 * 1024;

/**
 * Conservative max number of body markdown elements per card.
 * Feishu v2 cards support many more elements, but we cap early so the
 * header / meta / footer area always fits without pushing the card
 * past CARD_SIZE_LIMIT.
 */
export const MAX_BODY_ELEMENTS_PER_CARD = 20;

// ─── Code-block-safe character split ─────────────────────────────

interface CodeBlockRange {
  open: number;
  close: number;
  lang: string;
}

function findCodeBlockRanges(text: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const regex = /^```(\w*)\s*$/gm;
  let match: RegExpExecArray | null;
  let openMatch: RegExpExecArray | null = null;
  let openLang = '';

  while ((match = regex.exec(text)) !== null) {
    if (!openMatch) {
      openMatch = match;
      openLang = match[1] || '';
    } else {
      ranges.push({
        open: openMatch.index,
        close: match.index + match[0].length,
        lang: openLang,
      });
      openMatch = null;
      openLang = '';
    }
  }

  // Unclosed code block — treat from open to end of text
  if (openMatch) {
    ranges.push({
      open: openMatch.index,
      close: text.length,
      lang: openLang,
    });
  }

  return ranges;
}

function findContainingBlock(
  pos: number,
  ranges: CodeBlockRange[],
): CodeBlockRange | null {
  for (const r of ranges) {
    if (pos > r.open && pos < r.close) return r;
  }
  return null;
}

/**
 * Split text respecting fenced code block boundaries — never truncates inside
 * a code block without properly closing/reopening the fence.
 *
 * Algorithm:
 *   - Try to break at a paragraph boundary (\n\n) near maxLen.
 *   - Fall back to a line break (\n) if no paragraph break nearby.
 *   - Hard split at maxLen if nothing else works (e.g. a single huge code block).
 *   - If the split point falls inside a code block:
 *       - Retreat before the opening fence if possible (≥ 30% of maxLen).
 *       - Otherwise split inside but close the fence and reopen it on the next chunk.
 */
export function splitCodeBlockSafe(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Recompute ranges on current remaining text each iteration.
    // This handles synthetic reopeners correctly since all positions
    // are relative to `remaining`, not the original text.
    const ranges = findCodeBlockRanges(remaining);

    // Find a split point around maxLen
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    const block = findContainingBlock(idx, ranges);

    if (block) {
      // Split point is inside a code block
      if (block.open > 0 && block.open > maxLen * 0.3) {
        // Retreat to just before the code block opening
        const retreatIdx = remaining.lastIndexOf('\n', block.open);
        idx = retreatIdx > maxLen * 0.3 ? retreatIdx : block.open;
        chunks.push(remaining.slice(0, idx).trimEnd());
        remaining = remaining.slice(idx).replace(/^\n+/, '');
      } else {
        // Block starts too early to retreat — split inside but close/reopen fence
        const chunk = remaining.slice(0, idx).trimEnd() + '\n```';
        chunks.push(chunk);
        const reopener = '```' + block.lang + '\n';
        remaining = reopener + remaining.slice(idx).replace(/^\n/, '');
      }
    } else {
      chunks.push(remaining.slice(0, idx).trimEnd());
      remaining = remaining.slice(idx).replace(/^\n+/, '');
    }
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Paragraph-level section packing (single card) ──────────────

export interface BodySection {
  text: string;
  expanded: boolean;
}

/**
 * Split the body text into sections for collapsible rendering
 * inside a SINGLE card.
 *
 * Rules:
 *   - Empty / blank text → empty array.
 *   - Length ≤ SECTION_SOFT_LIMIT → single section, expanded.
 *   - Otherwise greedy-pack paragraphs (split by \n{2,}) into bins whose length
 *     stays within CARD_MD_LIMIT. First bin is expanded, the rest collapse.
 *   - A single paragraph larger than CARD_MD_LIMIT is kept intact in its
 *     own bin (Feishu markdown element supports ≥4000 chars); we don't split
 *     mid-paragraph to avoid breaking code fences.
 *   - NO upper bound on the number of sections — every paragraph is rendered.
 *     The old MAX_SECTIONS=4 tail-truncation bug is gone.
 */
const SECTION_SOFT_LIMIT = 2000;

export function splitIntoBodySections(text: string): BodySection[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= SECTION_SOFT_LIMIT) {
    return [{ text: trimmed, expanded: true }];
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const bins: string[] = [];
  let cur = '';
  for (const p of paragraphs) {
    if (!cur) {
      cur = p;
      continue;
    }
    const candidate = `${cur}\n\n${p}`;
    if (candidate.length > CARD_MD_LIMIT) {
      bins.push(cur);
      cur = p;
    } else {
      cur = candidate;
    }
  }
  if (cur) bins.push(cur);

  // Every bin is rendered — no tail truncation.
  return bins.map((t, i) => ({ text: t, expanded: i === 0 }));
}
