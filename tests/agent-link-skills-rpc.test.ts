import { describe, expect, test, vi } from 'vitest';

import { InboundFrame, OutboundFrame } from '../src/agent-link/protocol.js';
import { deliverSkillsResult, requestProviderSkills } from '../src/agent-link/skills-rpc.js';

describe('agent-link skills rpc', () => {
  test('protocol accepts skills.request and skills.result frames', () => {
    const outbound = OutboundFrame.parse({
      type: 'skills.request',
      id: 0,
      requestId: 'req_1',
      providerId: 'claude-code',
      cwd: '/workspace/demo',
    });
    expect(outbound).toMatchObject({ type: 'skills.request', providerId: 'claude-code' });

    const inbound = InboundFrame.parse({
      type: 'skills.result',
      requestId: 'req_1',
      ok: true,
      workspaceSkills: [{ id: 'project-skill', name: 'Project Skill', source: 'workspace', enabled: true }],
      cliSkills: [{ id: 'cli-skill', name: 'CLI Skill', source: 'cli', enabled: true }],
      error: null,
      durationMs: 12,
    });
    expect(inbound).toMatchObject({ type: 'skills.result', workspaceSkills: [{ id: 'project-skill' }] });
  });

  test('protocol tolerates legacy skills.result null skill lists as empty arrays', () => {
    const inbound = InboundFrame.parse({
      type: 'skills.result',
      requestId: 'req_legacy_empty',
      ok: true,
      workspaceSkills: null,
      cliSkills: null,
      error: null,
      durationMs: 3,
    });

    expect(inbound).toMatchObject({
      type: 'skills.result',
      workspaceSkills: [],
      cliSkills: [],
    });
  });

  test('protocol accepts skills.result package metadata and skill content', () => {
    const inbound = InboundFrame.parse({
      type: 'skills.result',
      requestId: 'req_detail',
      ok: true,
      workspaceSkills: [
        {
          id: 'project-skill',
          name: 'Project Skill',
          source: 'workspace',
          enabled: true,
          content: '---\nname: Project Skill\n---\n# Project Skill\n',
        },
      ],
      cliSkills: [
        {
          id: 'cli-skill',
          name: 'CLI Skill',
          source: 'cli',
          enabled: true,
          packageName: 'owner/repo@cli-skill',
          content: '---\nname: CLI Skill\n---\n# CLI Skill\n',
        },
      ],
      error: null,
      durationMs: 5,
    });

    expect(inbound).toMatchObject({
      type: 'skills.result',
      workspaceSkills: [{ id: 'project-skill', content: expect.stringContaining('# Project Skill') }],
      cliSkills: [
        {
          id: 'cli-skill',
          packageName: 'owner/repo@cli-skill',
          content: expect.stringContaining('# CLI Skill'),
        },
      ],
    });
  });

  test('protocol still requires skills.result skill list fields', () => {
    expect(() =>
      InboundFrame.parse({
        type: 'skills.result',
        requestId: 'req_missing_lists',
        ok: true,
        error: null,
        durationMs: 3,
      }),
    ).toThrow();
  });

  test('sends skills.request and resolves from matching skills.result', async () => {
    const sent: unknown[] = [];
    const session = {
      state: 'open',
      send(frame: unknown) {
        sent.push(frame);
        return true;
      },
    } as any;

    const promise = requestProviderSkills(session, {
      linkId: 'cl_1234567890abcdef',
      providerId: 'claude-code',
      cwd: '/workspace/demo',
      timeoutMs: 1000,
    });

    expect(sent[0]).toMatchObject({
      type: 'skills.request',
      providerId: 'claude-code',
      cwd: '/workspace/demo',
    });

    const requestId = (sent[0] as any).requestId;
    deliverSkillsResult({
      type: 'skills.result',
      requestId,
      ok: true,
      workspaceSkills: [{ id: 'project-skill', name: 'Project Skill', source: 'workspace', enabled: true }],
      cliSkills: [{ id: 'cli-skill', name: 'CLI Skill', source: 'cli', enabled: true }],
      error: null,
      durationMs: 10,
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      workspaceSkills: [{ id: 'project-skill', name: 'Project Skill', source: 'workspace', enabled: true }],
      cliSkills: [{ id: 'cli-skill', name: 'CLI Skill', source: 'cli', enabled: true }],
      error: null,
      durationMs: 10,
    });
  });

  test('rejects when session send fails', async () => {
    const session = {
      state: 'open',
      send: vi.fn(() => false),
    } as any;

    await expect(
      requestProviderSkills(session, {
        linkId: 'cl_1234567890abcdef',
        providerId: 'claude-code',
        cwd: '/workspace/demo',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('send_failed');
  });
});
