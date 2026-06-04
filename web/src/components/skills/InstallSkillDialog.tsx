import { useState } from 'react';
import { Loader2, Search, ExternalLink, Download, ChevronDown, ChevronUp, PackagePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSkillsStore, type SearchResult } from '@/stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import type { AgentLink } from '@/stores/agentLinks';
import type { InstallSkillOptions } from '@/stores/skills';
import type { CustomBackendDef } from '@/stores/customBackends';

interface InstallSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onInstall: (pkg: string, options?: InstallSkillOptions) => Promise<void>;
  installing: boolean;
  devices?: AgentLink[];
  agents?: CustomBackendDef[];
}

type Tab = 'search' | 'manual';

function packageBase(pkg: string): string {
  return pkg.split('@')[0]?.split('#')[0] ?? pkg;
}

function formatInstalls(n?: number): string {
  if (n === undefined || n === null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function SearchResultItem({
  result,
  isInstalling,
  installingPkg,
  onInstall,
}: {
  result: SearchResult;
  isInstalling: boolean;
  installingPkg: string | null;
  onInstall: (result: SearchResult) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { searchDetails, searchDetailLoading, fetchSearchDetail } = useSkillsStore();

  const key = result.package;
  const detail = searchDetails[key];
  const loading = searchDetailLoading[key];

  const handleToggle = () => {
    if (!expanded && !(key in searchDetails)) {
      fetchSearchDetail(result);
    }
    setExpanded(!expanded);
  };

  const installCount = formatInstalls(result.installs);

  return (
    <div className="rounded-lg border border-border hover:bg-muted/50 transition-colors overflow-hidden">
      <div className="flex items-center justify-between p-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left flex items-center gap-2"
          onClick={handleToggle}
        >
          {expanded
            ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground truncate block">
              {result.package}
            </span>
            {installCount && (
              <span className="text-xs text-muted-foreground">
                {installCount} 次安装
              </span>
            )}
          </div>
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onInstall(result)}
          disabled={isInstalling}
          className="ml-3 shrink-0"
        >
          {installingPkg === result.package ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          <span className="ml-1">安装</span>
        </Button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50">
          {loading && (
            <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
              <Loader2 className="size-3 animate-spin" />
              加载详情...
            </div>
          )}

          {!loading && detail && (
            <div className="space-y-2 pt-2">
              {detail.description && (
                <p className="text-xs text-foreground/80 leading-relaxed">{detail.description}</p>
              )}

              {detail.readme && (
                <div className="mt-2 border border-border/50 rounded-md p-3 max-h-64 overflow-y-auto bg-muted/30">
                  <MarkdownRenderer content={detail.readme} variant="docs" />
                </div>
              )}

              {!detail.readme && detail.features && detail.features.length > 0 && (
                <ul className="space-y-0.5">
                  {detail.features.map((f, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                      <span className="text-primary/60 shrink-0">-</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!loading && detail === null && (
            <p className="text-xs text-muted-foreground py-2">无法加载详情</p>
          )}

          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mt-2"
            >
              在 skills.sh 查看
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function InstallSkillDialog({
  open,
  onClose,
  onInstall,
  installing,
  devices = [],
  agents = [],
}: InstallSkillDialogProps) {
  const [tab, setTab] = useState<Tab>('search');
  const [pkg, setPkg] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);
  const [target, setTarget] = useState<'cloud' | 'device' | 'device-agent-workspace'>('cloud');
  const [deviceLinkId, setDeviceLinkId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [selectedPackages, setSelectedPackages] = useState<string[]>([]);

  const { searching, searchResults, searchSkills } = useSkillsStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    await searchSkills(trimmed);
  };

  const handleInstallFromSearch = async (result: SearchResult) => {
    try {
      setInstallingPkg(result.package);
      await onInstall(result.package, buildInstallOptions());
      setInstallingPkg(null);
      onClose();
    } catch (err) {
      setInstallingPkg(null);
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleInstallSelectedPackages = async () => {
    if (selectedPackages.length === 0) {
      toast.error('请选择要安装的技能包');
      return;
    }
    try {
      setInstallingPkg('__selected__');
      const options = buildInstallOptions();
      for (const selectedPkg of selectedPackages) {
        await onInstall(selectedPkg, options);
      }
      setSelectedPackages([]);
      setInstallingPkg(null);
      onClose();
    } catch (err) {
      setInstallingPkg(null);
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pkg.trim();
    if (!trimmed) {
      toast.error('请输入技能包名称');
      return;
    }

    try {
      await onInstall(trimmed, buildInstallOptions());
      setPkg('');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleClose = () => {
    if (!installing) {
      setPkg('');
      setSearchQuery('');
      setInstallingPkg(null);
      setTarget('cloud');
      setDeviceLinkId('');
      setAgentId('');
      setSelectedPackages([]);
      onClose();
    }
  };

  const isInstalling = installing || !!installingPkg;

  const onlineDevices = devices.filter((device) => device.online);
  const onlineDeviceIds = new Set(onlineDevices.map((device) => device.id));
  const workspaceAgents = agents.filter((agent) => agent.deviceLinkId && onlineDeviceIds.has(agent.deviceLinkId));
  const buildInstallOptions = (): InstallSkillOptions => {
    if (target === 'cloud') return { target: 'cloud' };
    if (target === 'device-agent-workspace') {
      if (!agentId) throw new Error('请选择安装目标 Agent Workspace');
      return { target: 'device-agent-workspace', agentId };
    }
    if (!deviceLinkId) throw new Error('请选择安装目标 Device');
    return { target: 'device', deviceLinkId };
  };

  const packageResults = Array.from(
    new Map(searchResults.map((result) => [packageBase(result.package), result])).values(),
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>安装技能</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <label className="block text-sm font-medium text-foreground">安装目标</label>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <input type="radio" name="skill-target" checked={target === 'cloud'} onChange={() => setTarget('cloud')} disabled={isInstalling} />
              云端
            </label>
            <label className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <input type="radio" name="skill-target" checked={target === 'device'} onChange={() => setTarget('device')} disabled={isInstalling || onlineDevices.length === 0} />
              指定 Device
            </label>
            <label className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <input type="radio" name="skill-target" checked={target === 'device-agent-workspace'} onChange={() => setTarget('device-agent-workspace')} disabled={isInstalling || workspaceAgents.length === 0} />
              Agent Workspace
            </label>
          </div>
          {target === 'device' && (
            <select
              value={deviceLinkId}
              onChange={(e) => setDeviceLinkId(e.target.value)}
              disabled={isInstalling}
              className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
            >
              <option value="" disabled>请选择在线 Device</option>
              {onlineDevices.map((device) => (
                <option key={device.id} value={device.id}>{device.displayName} ({device.id})</option>
              ))}
            </select>
          )}
          {target === 'device-agent-workspace' && (
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={isInstalling}
              className="h-9 w-full px-3 text-sm border border-border rounded-md bg-transparent"
            >
              <option value="" disabled>请选择绑定在线 Device 的 Agent</option>
              {workspaceAgents.map((agent) => {
                const device = devices.find((item) => item.id === agent.deviceLinkId);
                return (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName} ({agent.id}) · {device?.displayName || agent.deviceLinkId}
                  </option>
                );
              })}
            </select>
          )}
          {target === 'cloud' && (
            <p className="rounded-md bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
              云端 Skill 会安装为 Claude SDK / Claude Code 可用的格式，并保存到 OctoDeck Cloud Skills。
            </p>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'search'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('search'); }}
            disabled={isInstalling}
          >
            <Search className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            搜索市场
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'manual'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('manual'); }}
            disabled={isInstalling}
          >
            手动安装
          </button>
        </div>

        {/* Search Tab */}
        {tab === 'search' && (
          <div className="space-y-3 min-h-0 flex flex-col overflow-hidden">
            <form onSubmit={handleSearch} className="flex gap-2 shrink-0">
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索关键词..."
                disabled={searching || isInstalling}
                className="flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={searching || isInstalling || !searchQuery.trim()}
              >
                {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </Button>
            </form>

            {/* Results */}
            <div className="overflow-y-auto space-y-2 min-h-0 flex-1">
              {!searching && packageResults.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-muted-foreground">包级别多选安装</div>
                    <Button
                      size="sm"
                      type="button"
                      onClick={handleInstallSelectedPackages}
                      disabled={isInstalling || selectedPackages.length === 0}
                    >
                      {installingPkg === '__selected__' ? <Loader2 className="size-3.5 animate-spin" /> : <PackagePlus className="size-3.5" />}
                      安装选中 ({selectedPackages.length})
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {packageResults.map((result) => {
                      const pkg = packageBase(result.package);
                      const checked = selectedPackages.includes(pkg);
                      return (
                        <label key={pkg} className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isInstalling}
                            onChange={(event) => {
                              setSelectedPackages((current) =>
                                event.target.checked
                                  ? [...new Set([...current, pkg])]
                                  : current.filter((item) => item !== pkg),
                              );
                            }}
                          />
                          <span className="font-mono">{pkg}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              {searching && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin mr-2" />
                  搜索中...
                </div>
              )}

              {!searching && searchResults.length === 0 && searchQuery.trim() && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  未找到相关技能
                </div>
              )}

              {!searching && searchResults.map((result) => (
                <SearchResultItem
                  key={result.package}
                  result={result}
                  isInstalling={isInstalling}
                  installingPkg={installingPkg}
                  onInstall={handleInstallFromSearch}
                />
              ))}
            </div>

            {!searching && searchResults.length === 0 && !searchQuery.trim() && (
              <p className="text-xs text-muted-foreground text-center py-4">
                在 skills.sh 市场中搜索可用的技能包
              </p>
            )}
          </div>
        )}

        {/* Manual Tab */}
        {tab === 'manual' && (
          <form onSubmit={handleManualSubmit} className="space-y-4">
            <div>
              <label htmlFor="skill-pkg" className="block text-sm font-medium text-foreground mb-2">
                技能包名称
              </label>
              <Input
                id="skill-pkg"
                type="text"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder="owner/repo、owner/repo@skill 或 GitHub URL"
                disabled={isInstalling}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                支持格式：owner/repo、owner/repo@skill 或 GitHub URL
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleClose}
                disabled={isInstalling}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={isInstalling || !pkg.trim()}
              >
                {isInstalling && <Loader2 className="size-4 animate-spin" />}
                安装
              </Button>
            </div>
          </form>
        )}

      </DialogContent>
    </Dialog>
  );
}
