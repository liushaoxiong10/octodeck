import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { remoteCollectCommand, remoteCollectGitCommand } from '../src/repo-knowledge.js';
import type { ManagedRepo } from '../src/types.js';

const tmpDirs: string[] = [];

function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-rk-remote-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=should-not-be-indexed\n');
  return dir;
}

function opts() {
  return {
    maxFiles: 100,
    maxFileBytes: 1024 * 1024,
    includePatterns: [],
    excludePatterns: [],
    provider: 'builtin' as const,
    fallbackBuiltin: true,
    includeDocs: true,
    includeDependencies: true,
    includeImportGraph: true,
    searchBackend: 'auto' as const,
    sourceKind: 'repo' as const,
  };
}

function runShellCommand(command: string, cwd: string): string {
  return execFileSync('/bin/sh', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('repo knowledge remote collection commands', () => {
  test('device path collection command is valid shell/python and returns files', () => {
    const repoDir = makeFixtureRepo();
    const command = remoteCollectCommand(repoDir, opts());

    expect(Buffer.from(command).includes(0)).toBe(false);

    const parsed = JSON.parse(runShellCommand(command, repoDir)) as {
      files: Array<{ path: string; content: string }>;
      stats: { skippedSensitiveFiles: number };
    };

    expect(parsed.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['README.md', 'src/index.ts']),
    );
    expect(parsed.files.some((file) => file.path === '.env')).toBe(false);
    expect(parsed.stats.skippedSensitiveFiles).toBeGreaterThanOrEqual(1);
  });

  test('git-on-device collection command is valid shell/python and returns revision', () => {
    const repoDir = makeFixtureRepo();
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'octodeck@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'OctoDeck Test'], { cwd: repoDir });
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-rk-git-work-'));
    tmpDirs.push(workDir);
    const repo: ManagedRepo = {
      id: 'repo_test',
      name: 'fixture',
      kind: 'git',
      gitUrl: repoDir,
      mainBranch: 'master',
      createdBy: 'user-a',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const command = remoteCollectGitCommand(repo, opts());

    expect(Buffer.from(command).includes(0)).toBe(false);

    const parsed = JSON.parse(runShellCommand(command, workDir)) as {
      files: Array<{ path: string }>;
      revision?: string;
    };

    expect(parsed.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['README.md', 'src/index.ts']),
    );
  });
});
