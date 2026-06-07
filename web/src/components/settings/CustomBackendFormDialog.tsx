import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import {
  useCustomBackendsStore,
  type CustomBackendDef,
} from '../../stores/customBackends';
import { useAgentLinksStore } from '../../stores/agentLinks';
import { useAgentTeamsStore } from '../../stores/agentTeams';
import { getErrorMessage, type ProvidersListResponse } from './types';

type RuntimeMode = 'local-device' | 'server-side';
type WorkdirMode = 'auto' | 'custom';

interface CustomBackendFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 创建；非 null = 编辑现有 */
  backend: CustomBackendDef | null;
}

interface ModelInfo {
  id: string;
  displayName?: string;
}

interface FormState {
  id: string;
  displayName: string;
  runtime: RuntimeMode;
  timeoutMinutes: string;
  maxOutputMb: string;
  deviceLinkId: string;
  agentClientId: string;
  serverProviderId: string;
  model: string;
  agentMdId: string;
  workdirMode: WorkdirMode;
  workdir: string;
}

const INITIAL: FormState = {
  id: '',
  displayName: '',
  runtime: 'local-device',
  timeoutMinutes: '',
  maxOutputMb: '',
  deviceLinkId: '',
  agentClientId: '',
  serverProviderId: '',
  model: '',
  agentMdId: '',
  workdirMode: 'auto',
  workdir: '',
};

function backendToForm(b: CustomBackendDef): FormState {
  return {
    id: b.id,
    displayName: b.displayName,
    runtime: b.runtime ?? (b.deviceLinkId ? 'local-device' : 'server-side'),
    timeoutMinutes:
      typeof b.timeoutMs === 'number' ? String(Math.round(b.timeoutMs / 60000)) : '',
    maxOutputMb:
      typeof b.maxOutputBytes === 'number'
        ? String(Math.round(b.maxOutputBytes / 1048576))
        : '',
    deviceLinkId: b.deviceLinkId ?? '',
    agentClientId: b.agentClientId ?? '',
    serverProviderId: b.providerId ?? '',
    model: b.model ?? '',
    agentMdId: b.agentMdId ?? '',
    workdirMode: b.workdirMode ?? 'auto',
    workdir: b.workdir ?? '',
  };
}

export default function CustomBackendFormDialog({
  open,
  onOpenChange,
  backend,
}: CustomBackendFormDialogProps) {
  const { create, update } = useCustomBackendsStore();
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const { agentMdDefinitions, loadAgentMdDefinitions } = useAgentTeamsStore();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [serverModels, setServerModels] = useState<ModelInfo[]>([]);
  const [localModels, setLocalModels] = useState<ModelInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [serverProviders, setServerProviders] = useState<ProvidersListResponse['providers']>([]);
  const isEdit = backend !== null;
  const selectedDevice = devices.find((d) => d.id === form.deviceLinkId);
  const availableClients = selectedDevice?.agentClients ?? [];
  const selectedClient = availableClients.find((c) => c.id === form.agentClientId);

  useEffect(() => {
    if (!open) return;
    setForm(backend ? backendToForm(backend) : INITIAL);
    setServerModels([]);
    setLocalModels([]);
    void loadDevices();
    void loadAgentMdDefinitions();
    void loadServerProviders();
  }, [open, backend, loadDevices, loadAgentMdDefinitions]);

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const modelOptions = useMemo(() => {
    if (form.runtime === 'server-side') return serverModels;
    return localModels;
  }, [form.runtime, localModels, serverModels]);

  async function loadServerProviders() {
    setProvidersLoading(true);
    try {
      const data = await api.get<ProvidersListResponse>('/api/config/claude/providers');
      const enabled = (data.providers ?? []).filter((p) => p.enabled);
      setServerProviders(enabled);
      if (enabled.length > 0) {
        const models = Array.from(
          new Map(
            enabled.flatMap((p) => {
              const configured = p.anthropicModel
                ? [{ id: p.anthropicModel, displayName: p.anthropicModel }]
                : [];
              const fetched = (p.models ?? []).map((m) => ({ id: m.id, displayName: m.displayName || m.id }));
              return [...configured, ...fetched].map((m) => [m.id, m] as const);
            }),
          ).values(),
        );
        setServerModels(models);
        setForm((prev) => ({
          ...prev,
          serverProviderId: prev.serverProviderId || enabled[0].id,
          model: prev.runtime === 'server-side' && !prev.model ? models[0]?.id ?? '' : prev.model,
        }));
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 server-side 模型失败'));
    } finally {
      setProvidersLoading(false);
    }
  }

  async function loadLocalModels(deviceId = form.deviceLinkId, providerId = form.agentClientId) {
    if (!deviceId || !providerId) return;
    setModelsLoading(true);
    try {
      const data = await api.get<{ models: ModelInfo[] }>(
        `/api/agent-links/${encodeURIComponent(deviceId)}/providers/${encodeURIComponent(providerId)}/models`,
      );
      const models = data.models ?? [];
      setLocalModels(models);
      setForm((prev) => ({ ...prev, model: prev.model || models[0]?.id || '' }));
    } catch (err) {
      setLocalModels([]);
      toast.error(getErrorMessage(err, '从设备查询模型失败'));
    } finally {
      setModelsLoading(false);
    }
  }

  async function loadServerProviderModels(providerId = form.serverProviderId) {
    if (!providerId) return;
    setModelsLoading(true);
    try {
      const data = await api.post<{ models: ModelInfo[]; provider?: { anthropicModel?: string } }>(
        `/api/config/claude/providers/${encodeURIComponent(providerId)}/models/fetch`,
        {},
      );
      const models = data.models ?? [];
      setServerModels(models.map((m) => ({ id: m.id, displayName: m.displayName ?? m.id })));
      setForm((prev) => ({ ...prev, model: prev.model || data.provider?.anthropicModel || models[0]?.id || '' }));
    } catch (err) {
      toast.error(getErrorMessage(err, '从服务端模型端点拉取模型失败'));
    } finally {
      setModelsLoading(false);
    }
  }

  const handleSubmit = async () => {
    if (!form.displayName.trim()) {
      toast.error('显示名称不能为空');
      return;
    }
    if (form.runtime === 'local-device') {
      if (!form.deviceLinkId) {
        toast.error('请选择设备');
        return;
      }
      if (!form.agentClientId) {
        toast.error('请选择该设备上报的 Agent client');
        return;
      }
      if (!availableClients.some((c) => c.id === form.agentClientId)) {
        toast.error('只能添加客户端上报的 Agent client');
        return;
      }
    }
    if (!form.model.trim()) {
      toast.error('请选择模型');
      return;
    }
    if (form.runtime === 'server-side' && !form.serverProviderId) {
      toast.error('请选择 Server Side Provider');
      return;
    }
    if (form.workdirMode === 'custom' && !form.workdir.startsWith('/')) {
      toast.error('Workdir 必须是绝对路径');
      return;
    }

    const timeoutMs = form.timeoutMinutes.trim()
      ? Math.round(Number(form.timeoutMinutes) * 60000)
      : undefined;
    const maxOutputBytes = form.maxOutputMb.trim()
      ? Math.round(Number(form.maxOutputMb) * 1048576)
      : undefined;

    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 86_400_000)) {
      toast.error('超时时间必须在 1 分钟 ~ 24 小时之间');
      return;
    }
    if (maxOutputBytes !== undefined && (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1_048_576 || maxOutputBytes > 104_857_600)) {
      toast.error('单次输出上限必须在 1 ~ 100 MB 之间');
      return;
    }

    setSubmitting(true);
    try {
      const workspaceOverride =
        form.workdirMode === 'custom'
          ? { workdirMode: 'custom' as const, workdir: form.workdir.trim() }
          : isEdit
            ? { workdirMode: 'auto' as const, workdir: undefined }
            : {};
      const common = {
        displayName: form.displayName.trim(),
        timeoutMs,
        maxOutputBytes,
        runtime: form.runtime,
        model: form.model.trim(),
        agentMdId: form.agentMdId || null,
        providerId: form.runtime === 'server-side' ? form.serverProviderId : undefined,
        ...workspaceOverride,
        deviceLinkId: form.deviceLinkId.trim() || undefined,
        supportsHost: true,
      } as const;
      if (isEdit && backend) {
        await update(backend.id, {
          ...common,
          agentClientId: form.runtime === 'local-device' ? form.agentClientId : null,
          deviceLinkId: form.deviceLinkId.trim() || null,
          ...(form.runtime === 'server-side'
            ? { binary: 'claude', argvTemplate: ['-p', '{prompt}', '--model', form.model], outputProtocol: 'plain-text' as const }
            : {}),
        });
        toast.success('已更新 Agent');
      } else {
        await create({
          ...common,
          agentClientId: form.runtime === 'local-device' ? form.agentClientId : undefined,
          ...(form.runtime === 'server-side'
            ? { binary: 'claude', argvTemplate: ['-p', '{prompt}', '--model', form.model], outputProtocol: 'plain-text' as const, usesProviderPool: true }
            : {}),
        });
        toast.success('已创建 Agent');
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSubmitting(false);
    }
  };

  const applyProviderDefaults = (providerId: string) => {
    setForm((prev) => ({
      ...prev,
      agentClientId: providerId,
      model: '',
      displayName: prev.displayName || `${selectedDevice?.displayName ?? 'Device'} ${providerId}`,
    }));
    void loadLocalModels(form.deviceLinkId, providerId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `编辑 Agent: ${backend?.id}` : '新增 Agent'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <section className="rounded-2xl border border-border bg-muted/20 p-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-foreground">Agent 配置</div>
              <p className="mt-1 text-xs text-muted-foreground">
                所有字段在一个表单里完成；切换运行位置后只显示对应必填项。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['local-device', 'server-side'] as RuntimeMode[]).map((runtime) => (
                <button
                  key={runtime}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, runtime, agentClientId: '', model: '' }))}
                  className={`rounded-2xl border p-4 text-left transition ${form.runtime === runtime ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-background hover:bg-muted/30'}`}
                >
                  <div className="text-sm font-semibold">{runtime === 'local-device' ? 'LocalRuntime' : 'Server Side'}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {runtime === 'local-device'
                      ? 'Provider CLI 在选中 Device 上运行，模型列表实时从该设备/provider 查询。'
                      : '模型在服务端运行；可选绑定 Device，将文件/命令/Repo/Skill 放到设备侧执行。'}
                  </p>
                </button>
              ))}
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            {isEdit ? (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">ID</label>
                <Input value={form.id} disabled />
              </div>
            ) : null}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">显示名称</label>
              <Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="如 Mac Codex" />
            </div>
          </section>

          <section className="space-y-3">
            <div className="text-xs font-medium text-muted-foreground">运行位置</div>
            {form.runtime === 'local-device' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Device</label>
                  <select
                    value={form.deviceLinkId}
                    onChange={(e) => setForm((prev) => ({ ...prev, deviceLinkId: e.target.value, agentClientId: '', model: '' }))}
                    className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                  >
                    <option value="">请选择设备</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>{d.displayName} ({d.id}){d.online ? ' · online' : ' · offline'}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Provider CLI</label>
                  <select
                    value={form.agentClientId}
                    onChange={(e) => applyProviderDefaults(e.target.value)}
                    disabled={!form.deviceLinkId || availableClients.length === 0}
                    className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                  >
                    <option value="">{!form.deviceLinkId ? '请先选择设备' : availableClients.length === 0 ? '该设备尚未上报可用 Provider CLI' : '请选择 Provider CLI'}</option>
                    {availableClients.map((c) => <option key={c.id} value={c.id}>{c.displayName} ({c.id}){c.version ? ` · ${c.version}` : ''}</option>)}
                  </select>
                  {selectedClient ? <p className="mt-1 text-xs text-muted-foreground">权限模式：{selectedClient.permissionModes?.join(', ') || '—'}</p> : null}
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Device（可选）</label>
                  <select
                    value={form.deviceLinkId}
                    onChange={(e) => setForm((prev) => ({ ...prev, deviceLinkId: e.target.value }))}
                    className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                  >
                    <option value="">不绑定 Device</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>{d.displayName} ({d.id}){d.online ? ' · online' : ' · offline'}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">绑定后文件/命令/Repo/Skill 在 Device 的 Agent Root 下执行。</p>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-xs text-zinc-500">模型</label>
              {form.runtime === 'local-device' ? (
                <Button type="button" variant="outline" size="sm" onClick={() => loadLocalModels()} disabled={!form.deviceLinkId || !form.agentClientId || modelsLoading}>
                  {modelsLoading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  实时查询
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => loadServerProviderModels()} disabled={!form.serverProviderId || modelsLoading}>
                  {modelsLoading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  服务端拉取
                </Button>
              )}
            </div>
            {form.runtime === 'server-side' ? (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Server Side Provider</label>
                <select
                  value={form.serverProviderId}
                  onChange={(e) => {
                    const providerId = e.target.value;
                    const provider = serverProviders.find((p) => p.id === providerId);
                    setForm((prev) => ({
                      ...prev,
                      serverProviderId: providerId,
                      model: provider?.anthropicModel || prev.model,
                    }));
                  }}
                  disabled={providersLoading || serverProviders.length === 0}
                  className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
                >
                  <option value="">{providersLoading ? '加载中...' : '请选择 server-side provider'}</option>
                  {serverProviders.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.anthropicModel})</option>)}
                </select>
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <select
                value={modelOptions.some((m) => m.id === form.model) ? form.model : ''}
                onChange={(e) => set('model', e.target.value)}
                disabled={modelsLoading || modelOptions.length === 0}
                className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
              >
                <option value="">{modelsLoading ? '查询中...' : modelOptions.length === 0 ? '暂无模型，可手动输入' : '从列表选择模型'}</option>
                {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.displayName ?? m.id}</option>)}
              </select>
              <Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="或手动输入模型 ID" />
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-border bg-muted/20 p-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Agent 身份 agent.md（选填）</label>
              <select
                value={form.agentMdId}
                onChange={(e) => set('agentMdId', e.target.value)}
                className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
              >
                <option value="">不绑定 agent.md 身份</option>
                {agentMdDefinitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.name}{definition.createdByTeamName ? ` · Team: ${definition.createdByTeamName}` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                运行该 Agent 时会把所选 agent.md 内容作为身份说明注入到用户提示前。
              </p>
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground">默认运行位置</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Agent 创建时默认不绑定 Workdir；实际运行目录会在每次任务/会话启动时，按任务来源、Workspace、Repo 或设备侧 Agent Root 自动解析。
              </p>
            </div>
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
              当前策略：自动继承任务运行位置。运行 Agent 时系统会明确传入并记录 resolved workdir。
            </div>
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                高级：固定运行目录（仅用于兼容特殊 CLI）
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <button type="button" onClick={() => set('workdirMode', 'auto')} className={`rounded-xl border p-3 text-left ${form.workdirMode === 'auto' ? 'border-primary bg-primary/10' : 'border-border'}`}>
                  <div className="text-sm font-medium">不绑定目录</div>
                  <p className="mt-1 text-xs text-muted-foreground">推荐：运行时从任务/Workspace 解析。</p>
                </button>
                <button type="button" onClick={() => set('workdirMode', 'custom')} className={`rounded-xl border p-3 text-left ${form.workdirMode === 'custom' ? 'border-primary bg-primary/10' : 'border-border'}`}>
                  <div className="text-sm font-medium">固定绝对路径</div>
                  <p className="mt-1 text-xs text-muted-foreground">仅当该 Agent 必须始终在同一目录运行时使用。</p>
                </button>
              </div>
              {form.workdirMode === 'custom' ? <Input className="mt-3" value={form.workdir} onChange={(e) => set('workdir', e.target.value)} placeholder="/Users/me/project" /> : null}
            </details>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">超时（分钟，留空=默认）</label>
              <Input type="number" min={1} max={1440} value={form.timeoutMinutes} onChange={(e) => set('timeoutMinutes', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">输出上限（MB，留空=默认）</label>
              <Input type="number" min={1} max={100} value={form.maxOutputMb} onChange={(e) => set('maxOutputMb', e.target.value)} />
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? '保存中...' : isEdit ? '保存' : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
