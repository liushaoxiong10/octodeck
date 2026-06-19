export type GitPullRequestProvider = 'github' | 'gitlab' | 'codebase' | 'unknown';

export interface ResolvedGitProvider {
  provider: GitPullRequestProvider;
  repositoryUrl?: string;
  owner?: string;
  repo?: string;
  projectPath?: string;
  apiBaseUrl?: string;
}

export interface CreatePullRequestInput {
  repositoryUrl?: string | null;
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface CreatePullRequestResult {
  ok: boolean;
  provider: GitPullRequestProvider;
  url?: string;
  number?: number;
  id?: string;
  error?: string;
  createdAt?: string;
}

export interface CreatePullRequestOptions {
  githubToken?: string | null;
  gitlabToken?: string | null;
  codebaseToken?: string | null;
  fetchImpl?: typeof fetch;
}

export interface PullRequestStatusInput {
  repositoryUrl?: string | null;
  number?: number | null;
  id?: string | null;
  url?: string | null;
}

export interface PullRequestStatusResult {
  ok: boolean;
  provider: GitPullRequestProvider;
  url?: string;
  number?: number;
  id?: string;
  state?: 'open' | 'closed' | 'merged' | 'unknown';
  mergeable?: boolean | null;
  checks: Array<{
    name: string;
    status: 'queued' | 'in_progress' | 'completed' | 'unknown';
    conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | 'unknown' | null;
    url?: string;
  }>;
  reviews: Array<{
    reviewer?: string;
    state: 'approved' | 'changes_requested' | 'commented' | 'pending' | 'unknown';
    url?: string;
  }>;
  mergedAt?: string | null;
  headSha?: string | null;
  targetBranch?: string | null;
  error?: string;
}

function normalizeRepoUrl(gitUrl?: string | null): string | undefined {
  if (!gitUrl) return undefined;
  const trimmed = gitUrl.trim();
  const https = /^(https?):\/\/([^/]+)\/(.+?)(?:\.git)?(?:[#?].*)?$/.exec(trimmed);
  if (https) return `${https[1]}://${https[2]}/${https[3].replace(/\/+$/, '')}`;
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\/+$/, '')}`;
  return undefined;
}

function normalizeProviderError(data: Record<string, unknown>, fallback: string): string {
  const message = data.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  if (message && typeof message === 'object') {
    return Object.entries(message as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.map(String).join(', ') : String(value)}`)
      .join('; ');
  }
  if (typeof data.error === 'string') return data.error;
  return fallback;
}

export function resolveGitProvider(gitUrl?: string | null): ResolvedGitProvider {
  const repositoryUrl = normalizeRepoUrl(gitUrl);
  if (!repositoryUrl) return { provider: 'unknown' };
  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    return { provider: 'unknown', repositoryUrl };
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { provider: 'unknown', repositoryUrl };
  const repo = parts[parts.length - 1]?.replace(/\.git$/, '');
  const owner = parts.slice(0, -1).join('/');
  const projectPath = [...parts.slice(0, -1), repo].filter(Boolean).join('/');
  if (parsed.hostname === 'github.com') {
    return {
      provider: 'github',
      repositoryUrl,
      owner,
      repo,
      projectPath,
      apiBaseUrl: 'https://api.github.com',
    };
  }
  if (parsed.hostname.includes('gitlab') || parsed.hostname.startsWith('git.')) {
    return {
      provider: 'gitlab',
      repositoryUrl,
      owner,
      repo,
      projectPath,
      apiBaseUrl: `${parsed.origin}/api/v4`,
    };
  }
  if (parsed.hostname.includes('codebase')) {
    return { provider: 'codebase', repositoryUrl, owner, repo };
  }
  return { provider: 'gitlab', repositoryUrl, owner, repo, projectPath, apiBaseUrl: `${parsed.origin}/api/v4` };
}

export async function createIssueRunPullRequest(
  input: CreatePullRequestInput,
  options: CreatePullRequestOptions = {},
): Promise<CreatePullRequestResult> {
  const resolved = resolveGitProvider(input.repositoryUrl);
  if (resolved.provider === 'unknown') {
    return { ok: false, provider: 'unknown', error: 'repository_url_not_supported' };
  }
  if (!input.sourceBranch.trim() || !input.targetBranch.trim()) {
    return { ok: false, provider: resolved.provider, error: 'branch_missing' };
  }
  if (resolved.provider === 'github') {
    const token = options.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!token.trim()) return { ok: false, provider: 'github', error: 'provider_not_configured' };
    if (!resolved.owner || !resolved.repo || !resolved.apiBaseUrl) {
      return { ok: false, provider: 'github', error: 'repository_url_not_supported' };
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${resolved.apiBaseUrl}/repos/${resolved.owner}/${resolved.repo}/pulls`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.sourceBranch,
        base: input.targetBranch,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, provider: 'github', error: normalizeProviderError(data, `github_api_${response.status}`) };
    }
    return {
      ok: true,
      provider: 'github',
      url: typeof data.html_url === 'string' ? data.html_url : undefined,
      number: typeof data.number === 'number' ? data.number : undefined,
      id: data.id !== undefined ? String(data.id) : undefined,
      createdAt: new Date().toISOString(),
    };
  }
  if (resolved.provider === 'gitlab') {
    const token = options.gitlabToken || process.env.GITLAB_TOKEN || process.env.GL_TOKEN || '';
    if (!token.trim()) return { ok: false, provider: 'gitlab', error: 'provider_not_configured' };
    if (!resolved.projectPath || !resolved.apiBaseUrl) {
      return { ok: false, provider: 'gitlab', error: 'repository_url_not_supported' };
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${resolved.apiBaseUrl}/projects/${encodeURIComponent(resolved.projectPath)}/merge_requests`,
      {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          remove_source_branch: false,
        }),
      },
    );
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, provider: 'gitlab', error: normalizeProviderError(data, `gitlab_api_${response.status}`) };
    }
    return {
      ok: true,
      provider: 'gitlab',
      url: typeof data.web_url === 'string' ? data.web_url : undefined,
      number: typeof data.iid === 'number' ? data.iid : undefined,
      id: data.id !== undefined ? String(data.id) : undefined,
      createdAt: new Date().toISOString(),
    };
  }
  if (resolved.provider === 'codebase') {
    return { ok: false, provider: 'codebase', error: 'provider_not_configured' };
  }
  return { ok: false, provider: resolved.provider, error: 'provider_not_supported' };
}

function normalizeGithubReviewState(state: unknown): PullRequestStatusResult['reviews'][number]['state'] {
  const value = String(state ?? '').toUpperCase();
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes_requested';
  if (value === 'COMMENTED') return 'commented';
  if (value === 'PENDING') return 'pending';
  return 'unknown';
}

function normalizeGithubCheckConclusion(value: unknown): PullRequestStatusResult['checks'][number]['conclusion'] {
  const conclusion = String(value ?? 'unknown');
  if (['success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out'].includes(conclusion)) {
    return conclusion as PullRequestStatusResult['checks'][number]['conclusion'];
  }
  return 'unknown';
}

function normalizeGithubCommitStatus(status: any): PullRequestStatusResult['checks'][number] {
  const state = String(status?.state ?? 'unknown');
  const completed = ['success', 'failure', 'error'].includes(state);
  return {
    name: String(status?.context ?? 'status'),
    status: completed ? 'completed' : state === 'pending' ? 'in_progress' : 'unknown',
    conclusion: state === 'success' ? 'success' : state === 'failure' || state === 'error' ? 'failure' : 'unknown',
    url: typeof status?.target_url === 'string' ? status.target_url : undefined,
  };
}

function latestEffectiveGithubReviews(reviewsData: any[]): PullRequestStatusResult['reviews'] {
  const latestByReviewer = new Map<string, any>();
  for (const review of reviewsData) {
    const rawState = String(review?.state ?? '').toUpperCase();
    const state = normalizeGithubReviewState(rawState);
    if (state !== 'approved' && state !== 'changes_requested' && rawState !== 'DISMISSED') continue;
    const reviewer = typeof review?.user?.login === 'string' ? review.user.login : undefined;
    const key = reviewer ?? String(review?.user?.id ?? review?.id ?? latestByReviewer.size);
    const current = latestByReviewer.get(key);
    const currentTime = Date.parse(String(current?.submitted_at ?? current?.submittedAt ?? '')) || Number(current?.id ?? 0);
    const nextTime = Date.parse(String(review?.submitted_at ?? review?.submittedAt ?? '')) || Number(review?.id ?? 0);
    if (!current || nextTime >= currentTime) latestByReviewer.set(key, review);
  }
  return Array.from(latestByReviewer.values())
    .filter((review: any) => String(review?.state ?? '').toUpperCase() !== 'DISMISSED')
    .map((review: any) => ({
      reviewer: typeof review.user?.login === 'string' ? review.user.login : undefined,
      state: normalizeGithubReviewState(review.state),
      url: typeof review.html_url === 'string' ? review.html_url : undefined,
    }));
}

function normalizeGitlabPipelineConclusion(status: unknown): PullRequestStatusResult['checks'][number]['conclusion'] {
  const value = String(status ?? 'unknown');
  if (value === 'success') return 'success';
  if (value === 'failed') return 'failure';
  if (value === 'canceled') return 'cancelled';
  if (value === 'skipped') return 'skipped';
  return 'unknown';
}

function selectCurrentGitlabPipelines(pipelines: any[], mrData: Record<string, any>): any[] {
  const headPipeline = mrData.head_pipeline && typeof mrData.head_pipeline === 'object' ? mrData.head_pipeline : null;
  if (headPipeline) return [headPipeline];
  const headSha = typeof mrData.sha === 'string' ? mrData.sha : null;
  const matchingHead = headSha ? pipelines.filter((pipeline) => pipeline?.sha === headSha) : [];
  const candidates = matchingHead.length ? matchingHead : pipelines;
  return candidates
    .slice()
    .sort((a, b) => {
      const byUpdated = Date.parse(String(b?.updated_at ?? b?.created_at ?? '')) - Date.parse(String(a?.updated_at ?? a?.created_at ?? ''));
      if (Number.isFinite(byUpdated) && byUpdated !== 0) return byUpdated;
      return Number(b?.id ?? 0) - Number(a?.id ?? 0);
    })
    .slice(0, 1);
}

function normalizeGitlabApprovalReviews(approvals: Record<string, any>): PullRequestStatusResult['reviews'] {
  const reviews: PullRequestStatusResult['reviews'] = Array.isArray(approvals.approved_by)
    ? approvals.approved_by.map((item: any) => ({
        reviewer: typeof item.user?.username === 'string' ? item.user.username : undefined,
        state: 'approved' as const,
      }))
    : [];
  const approvalsLeft = Number(approvals.approvals_left ?? 0);
  if (Number.isFinite(approvalsLeft) && approvalsLeft > 0) {
    reviews.push({ reviewer: `${approvalsLeft} approval(s) pending`, state: 'pending' });
  }
  return reviews;
}

export async function getIssueRunPullRequestStatus(
  input: PullRequestStatusInput,
  options: CreatePullRequestOptions = {},
): Promise<PullRequestStatusResult> {
  const resolved = resolveGitProvider(input.repositoryUrl);
  if (resolved.provider === 'unknown') {
    return { ok: false, provider: 'unknown', checks: [], reviews: [], error: 'repository_url_not_supported' };
  }
  const number = typeof input.number === 'number' ? input.number : Number(input.id);
  if (!Number.isFinite(number) || number <= 0) {
    return { ok: false, provider: resolved.provider, checks: [], reviews: [], error: 'pull_request_number_missing' };
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  if (resolved.provider === 'github') {
    const token = options.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!token.trim()) return { ok: false, provider: 'github', checks: [], reviews: [], error: 'provider_not_configured' };
    if (!resolved.owner || !resolved.repo || !resolved.apiBaseUrl) {
      return { ok: false, provider: 'github', checks: [], reviews: [], error: 'repository_url_not_supported' };
    }
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const prResponse = await fetchImpl(`${resolved.apiBaseUrl}/repos/${resolved.owner}/${resolved.repo}/pulls/${number}`, { headers });
    const prData = (await prResponse.json().catch(() => ({}))) as Record<string, any>;
    if (!prResponse.ok) {
      return { ok: false, provider: 'github', checks: [], reviews: [], error: normalizeProviderError(prData, `github_api_${prResponse.status}`) };
    }
    const headSha = typeof prData.head?.sha === 'string' ? prData.head.sha : null;
    const [checksResponse, statusesResponse, reviewsResponse] = await Promise.all([
      headSha
        ? fetchImpl(`${resolved.apiBaseUrl}/repos/${resolved.owner}/${resolved.repo}/commits/${headSha}/check-runs`, { headers })
        : Promise.resolve(new Response(JSON.stringify({ check_runs: [] }), { status: 200 })),
      headSha
        ? fetchImpl(`${resolved.apiBaseUrl}/repos/${resolved.owner}/${resolved.repo}/commits/${headSha}/status`, { headers })
        : Promise.resolve(new Response(JSON.stringify({ statuses: [] }), { status: 200 })),
      fetchImpl(`${resolved.apiBaseUrl}/repos/${resolved.owner}/${resolved.repo}/pulls/${number}/reviews`, { headers }),
    ]);
    const checksData = (await checksResponse.json().catch(() => ({}))) as Record<string, any>;
    const statusesData = (await statusesResponse.json().catch(() => ({}))) as Record<string, any>;
    const reviewsData = (await reviewsResponse.json().catch(() => [])) as any[];
    const checkRuns = Array.isArray(checksData.check_runs)
      ? checksData.check_runs.map((check: any) => ({
          name: String(check.name ?? 'check'),
          status: ['queued', 'in_progress', 'completed'].includes(check.status) ? check.status : 'unknown',
          conclusion: normalizeGithubCheckConclusion(check.conclusion),
          url: typeof check.html_url === 'string' ? check.html_url : undefined,
        }))
      : [];
    const commitStatuses = Array.isArray(statusesData.statuses)
      ? statusesData.statuses.map(normalizeGithubCommitStatus)
      : [];
    return {
      ok: true,
      provider: 'github',
      url: typeof prData.html_url === 'string' ? prData.html_url : input.url ?? undefined,
      number,
      id: prData.id !== undefined ? String(prData.id) : input.id ?? undefined,
      state: prData.merged_at ? 'merged' : prData.state === 'closed' ? 'closed' : prData.state === 'open' ? 'open' : 'unknown',
      mergeable: typeof prData.mergeable === 'boolean' ? prData.mergeable : null,
      mergedAt: typeof prData.merged_at === 'string' ? prData.merged_at : null,
      headSha,
      targetBranch: typeof prData.base?.ref === 'string' ? prData.base.ref : null,
      checks: [...checkRuns, ...commitStatuses],
      reviews: Array.isArray(reviewsData) ? latestEffectiveGithubReviews(reviewsData) : [],
    };
  }

  if (resolved.provider === 'gitlab') {
    const token = options.gitlabToken || process.env.GITLAB_TOKEN || process.env.GL_TOKEN || '';
    if (!token.trim()) return { ok: false, provider: 'gitlab', checks: [], reviews: [], error: 'provider_not_configured' };
    if (!resolved.projectPath || !resolved.apiBaseUrl) {
      return { ok: false, provider: 'gitlab', checks: [], reviews: [], error: 'repository_url_not_supported' };
    }
    const headers = { 'PRIVATE-TOKEN': token };
    const project = encodeURIComponent(resolved.projectPath);
    const mrResponse = await fetchImpl(`${resolved.apiBaseUrl}/projects/${project}/merge_requests/${number}`, { headers });
    const mrData = (await mrResponse.json().catch(() => ({}))) as Record<string, any>;
    if (!mrResponse.ok) {
      return { ok: false, provider: 'gitlab', checks: [], reviews: [], error: normalizeProviderError(mrData, `gitlab_api_${mrResponse.status}`) };
    }
    const [pipelinesResponse, approvalsResponse] = await Promise.all([
      fetchImpl(`${resolved.apiBaseUrl}/projects/${project}/merge_requests/${number}/pipelines`, { headers }),
      fetchImpl(`${resolved.apiBaseUrl}/projects/${project}/merge_requests/${number}/approvals`, { headers }),
    ]);
    const pipelines = (await pipelinesResponse.json().catch(() => [])) as any[];
    const approvals = (await approvalsResponse.json().catch(() => ({}))) as Record<string, any>;
    return {
      ok: true,
      provider: 'gitlab',
      url: typeof mrData.web_url === 'string' ? mrData.web_url : input.url ?? undefined,
      number,
      id: mrData.id !== undefined ? String(mrData.id) : input.id ?? undefined,
      state: mrData.merged_at || mrData.state === 'merged' ? 'merged' : mrData.state === 'closed' ? 'closed' : mrData.state === 'opened' ? 'open' : 'unknown',
      mergeable: mrData.merge_status === 'can_be_merged',
      mergedAt: typeof mrData.merged_at === 'string' ? mrData.merged_at : null,
      headSha: typeof mrData.sha === 'string' ? mrData.sha : null,
      targetBranch: typeof mrData.target_branch === 'string' ? mrData.target_branch : null,
      checks: Array.isArray(pipelines)
        ? selectCurrentGitlabPipelines(pipelines, mrData).map((pipeline: any) => ({
            name: `pipeline #${pipeline.id ?? 'unknown'}`,
            status: ['success', 'failed', 'canceled', 'skipped'].includes(pipeline.status) ? 'completed' : 'in_progress',
            conclusion: normalizeGitlabPipelineConclusion(pipeline.status),
            url: typeof pipeline.web_url === 'string' ? pipeline.web_url : undefined,
          }))
        : [],
      reviews: normalizeGitlabApprovalReviews(approvals),
    };
  }

  return { ok: false, provider: resolved.provider, checks: [], reviews: [], error: 'provider_not_supported' };
}
