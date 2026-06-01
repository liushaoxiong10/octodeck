/**
 * coco (TraeCLI) backend.
 *
 * 调用方式：coco -p "<prompt>" --output-format=stream-json -y [--resume=<session>]
 * 输出协议：每行一个 JSON，识别 system/init / assistant / result/success / result/error
 *
 * Phase 4 起：所有 spawn / 行流 / timeout / 日志 逻辑统一走 host-cli-driver。
 * 本文件只剩「coco 在哪 / coco 怎么拼 argv」两件事。
 */
import fs from 'fs';
import path from 'path';

import type { ExecutionMode } from '../types.js';
import { runHostCli } from './host-cli-driver.js';
import type { AgentBackend } from './types.js';

const COCO_BINARY_CANDIDATES = [
  process.env.OCTODECK_COCO_BIN,
  path.join(process.env.HOME || '', '.local', 'bin', 'coco'),
  '/usr/local/bin/coco',
  '/opt/homebrew/bin/coco',
].filter((p): p is string => !!p && p.length > 0);

function resolveCocoBinary(): string | null {
  for (const candidate of COCO_BINARY_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  // Fall back to PATH lookup; spawn() will surface ENOENT if missing.
  return 'coco';
}

export const cocoBackend: AgentBackend = {
  id: 'coco',
  displayName: 'TraeCLI (coco)',
  usesProviderPool: false,
  supportsNativeSessions: true,

  supportsExecutionMode(mode: ExecutionMode): boolean {
    return mode === 'host';
  },

  run: (args) =>
    runHostCli(args, {
      backendId: 'coco',
      resolveBinary: resolveCocoBinary,
      buildArgv: (ctx) => {
        const argv = ['-p', ctx.prompt, '--output-format=stream-json', '-y'];
        if (ctx.sessionId) argv.push(`--resume=${ctx.sessionId}`);
        return argv;
      },
      outputProtocol: 'jsonline-stream-json',
    }),
};
