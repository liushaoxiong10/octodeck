import type { AgentBackend } from './types.js';

/**
 * Whether HappyClaw should prepend persisted chat history as a prompt block.
 *
 * Claude SDK sessions sometimes need this fallback when the underlying SDK
 * session is cleared by provider switching or recovery. CLI backends that can
 * resume their own native session should not receive this synthetic prompt
 * history; they get `input.sessionId` and can translate it to their own resume
 * argv/env instead.
 */
export function shouldInjectHistoryContext(backend: AgentBackend): boolean {
  return backend.supportsNativeSessions !== true;
}
