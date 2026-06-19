import { useEffect } from 'react';
import { RefreshCw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAutopilotsStore } from '../stores/autopilots';

export function AutopilotsPage() {
  const {
    autopilots,
    templates,
    runs,
    loading,
    error,
    loadAutopilots,
    loadTemplates,
    loadRuns,
    installTemplate,
    retryRun,
  } = useAutopilotsStore();

  useEffect(() => {
    loadAutopilots();
    loadTemplates();
  }, [loadAutopilots, loadTemplates]);

  const latestAutopilot = autopilots[0];
  const latestRuns = latestAutopilot ? (runs[latestAutopilot.id] ?? []) : [];

  return (
    <div className="min-h-screen bg-background p-4 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Autopilot</h1>
            <p className="text-sm text-muted-foreground">
              让 Agent 从被动响应升级为按计划、webhook 或 API 主动工作。
            </p>
          </div>
          <Button variant="outline" onClick={() => { loadAutopilots(); loadTemplates(); }} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {error && <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-sm text-error">{error}</div>}

        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <Card>
            <CardContent>
              <div className="mb-3">
                <div className="text-sm font-semibold text-foreground">内置模板</div>
                <div className="text-xs text-muted-foreground">
                  每日 repo health check、每周 dependency/TODO scan、webhook code review
                </div>
              </div>
              <div className="space-y-2">
                {templates.map((template) => (
                  <div key={template.id} className="rounded-xl border border-border bg-muted/20 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">{template.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{template.description}</div>
                        <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                          <span className="rounded bg-background px-2 py-1">{template.triggerType}</span>
                          <span className="rounded bg-background px-2 py-1">{template.actionType}</span>
                        </div>
                      </div>
                      <Button size="sm" onClick={() => installTemplate(template.id, template.name)}>
                        <Zap className="size-3.5" />
                        启用
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-foreground">运行历史</div>
                  <div className="text-xs text-muted-foreground">保存 autopilot run、触发 payload、失败原因与结果摘要</div>
                </div>
                {latestAutopilot && (
                  <Button variant="outline" size="sm" onClick={() => loadRuns(latestAutopilot.id)}>
                    加载历史
                  </Button>
                )}
              </div>

              <div className="mb-3 space-y-2">
                {autopilots.slice(0, 6).map((autopilot) => (
                  <button
                    key={autopilot.id}
                    onClick={() => loadRuns(autopilot.id)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left text-xs"
                  >
                    <div className="font-medium text-foreground">{autopilot.name}</div>
                    <div className="text-muted-foreground">
                      {autopilot.trigger.type} · {autopilot.action.type} · {autopilot.last_run_status ?? 'never'}
                    </div>
                    {autopilot.trigger.type === 'api' && (
                      <div className="mt-1 rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        API Endpoint: /api/autopilots/${autopilot.id}/api · Authorization: Bearer &lt;token&gt;
                      </div>
                    )}
                  </button>
                ))}
                {autopilots.length === 0 && <div className="text-sm text-muted-foreground">暂无 Autopilot</div>}
              </div>

              <div className="space-y-2">
                {latestRuns.slice(0, 5).map((run) => (
                  <div key={run.id} className="rounded-lg bg-muted/30 px-3 py-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-foreground">{run.status} · {run.trigger_type}</div>
                        <div className="text-[11px] text-muted-foreground">第 {run.attempt} 次</div>
                      </div>
                      {latestAutopilot && run.status === 'error' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => retryRun(latestAutopilot.id, run.id)}
                        >
                          重试
                        </Button>
                      )}
                    </div>
                    {run.retry_of && <div className="text-muted-foreground">Retry of: {run.retry_of}</div>}
                    <div className="text-muted-foreground">
                      {run.skip_reason
                        ? `Skip reason: ${run.skip_reason}`
                        : run.error ?? JSON.stringify(run.result ?? run.payload ?? {})}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
