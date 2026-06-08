import type { AgentTeamInput } from './agent-teams.js';

export interface AgentTeamTemplateSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentTeamTemplate extends AgentTeamTemplateSummary {
  team: Omit<AgentTeamInput, 'goal' | 'createdByAgentId'>;
}

const templates: readonly AgentTeamTemplate[] = [
  {
    id: 'feature-delivery-v1',
    name: 'Feature Delivery v1',
    description:
      'Plan, implement, verify, and finalize a software feature with explicit artifacts.',
    tags: ['software', 'verify', 'leader-worker'],
    team: {
      name: 'Feature Delivery Team',
      shape: 'leader-worker',
      description: 'A governed team for delivering code changes with verification.',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          responsibility: 'Plan and finalize delivery.',
        },
        {
          id: 'implementer',
          name: 'Implementer',
          responsibility: 'Implement the requested change.',
        },
        {
          id: 'verifier',
          name: 'Verifier',
          responsibility: 'Verify correctness and risks.',
        },
      ],
      workflow:
        'Lead plans, implementer works, verifier checks, lead finalizes.',
      workflowSteps: [
        {
          id: 'plan',
          type: 'role',
          roleId: 'lead',
          phase: 'plan',
          outputKey: 'plan',
        },
        {
          id: 'implement',
          type: 'role',
          roleId: 'implementer',
          phase: 'work',
          inputKeys: ['plan'],
          dependsOn: ['plan'],
          outputKey: 'implementation',
        },
        {
          id: 'verify',
          type: 'verify',
          verify: {
            verifierRoleId: 'verifier',
            subjectKeys: ['implementation'],
          },
          dependsOn: ['implement'],
          inputKeys: ['implementation'],
          outputKey: 'verifier_report',
        },
        {
          id: 'finalize',
          type: 'role',
          roleId: 'lead',
          phase: 'finalize',
          inputKeys: ['plan', 'implementation', 'verifier_report'],
          dependsOn: ['verify'],
          outputKey: 'final',
        },
      ],
      successCriteria: [
        'Implementation satisfies the goal',
        'Verifier report has no blocking findings',
      ],
    },
  },
];

export function listAgentTeamTemplates(): AgentTeamTemplateSummary[] {
  return templates.map(({ id, name, description, tags }) => ({
    id,
    name,
    description,
    tags: [...tags],
  }));
}

export function getAgentTeamTemplate(id: string): AgentTeamTemplate | null {
  const template = templates.find((candidate) => candidate.id === id);
  return template ? structuredClone(template) : null;
}

export function createAgentTeamInputFromTemplate(
  id: string,
  input: { goal: string; createdByAgentId: string },
): AgentTeamInput {
  const template = getAgentTeamTemplate(id);
  if (!template) throw new Error(`agent team template not found: ${id}`);
  return {
    ...structuredClone(template.team),
    goal: input.goal,
    createdByAgentId: input.createdByAgentId,
  };
}
