import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Download, Eye, ExternalLink, FileCode2, Loader2, Search, ShieldQuestion, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import {
  useAgentDefinitionsStore,
  type MarketplaceAgent,
  type MarketplaceAgentDetail,
} from '@/stores/agent-definitions';

interface InstallAgentMarketplaceDialogProps {
  open: boolean;
  onClose: () => void;
}

const DEPT_LOCALIZED: Record<string, string> = {
  academic: '学术研究',
  design: '设计',
  engineering: '工程',
  finance: '金融',
  'game-development': '游戏开发',
  hr: '人力资源',
  legal: '法务合规',
  marketing: '营销运营',
  'paid-media': '付费媒介',
  product: '产品',
  'project-management': '项目管理',
  sales: '销售',
  'spatial-computing': '空间计算',
  specialized: '专业垂直',
  strategy: '战略',
  'supply-chain': '供应链',
  support: '客户支持',
  testing: '测试',
};

function deptLabel(dept: string): string {
  return DEPT_LOCALIZED[dept] || dept;
}

function AgentCardItem({
  agent,
  expanded,
  onToggle,
  onOpenPreview,
  onOpenInstall,
}: {
  agent: MarketplaceAgent;
  expanded: boolean;
  onToggle: () => void;
  onOpenPreview: (agent: MarketplaceAgent) => void;
  onOpenInstall: (agent: MarketplaceAgent) => void;
}) {
  const {
    marketplaceDetails,
    marketplaceDetailLoading,
    marketplaceInstalling,
    getMarketplaceDetail,
  } = useAgentDefinitionsStore();

  const loading = marketplaceDetailLoading[agent.id];
  const detail = marketplaceDetails[agent.id];
  const installing = marketplaceInstalling[agent.id];

  const handleToggle = () => {
    if (!expanded && !detail) {
      void getMarketplaceDetail(agent.id).catch((err) => {
        toast.error(err instanceof Error ? err.message : '加载详情失败');
      });
    }
    onToggle();
  };

  return (
    <div className="rounded-lg border border-border hover:bg-muted/40 transition-colors overflow-hidden">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={handleToggle}
          className="flex-1 min-w-0 flex items-center gap-2 p-3 text-left"
        >
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-foreground truncate">
                {agent.name}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {deptLabel(agent.dept)}
              </span>
              {agent.installed && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success">
                  <CheckCircle2 className="size-3" />
                  已安装
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1 flex items-center gap-2 flex-wrap">
              <span className="truncate">{agent.description || agent.id}</span>
              <button
                type="button"
                className="text-primary/80 hover:text-primary underline shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenPreview(agent);
                }}
              >
                预览 Markdown →
              </button>
            </div>
          </div>
        </button>
        <div className="shrink-0 pr-2 py-3 flex items-center gap-2">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPreview(agent);
                  }}
                  className="text-primary hover:text-primary"
                >
                  <Eye className="size-3.5" />
                  <span className="ml-1">预览</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                查看商店中的完整 Agent Markdown 内容
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant={agent.installed ? 'outline' : 'default'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInstall(agent);
                  }}
                  disabled={installing}
                >
                  {installing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  <span className="ml-1">
                    {agent.installed ? '重装' : '安装'}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                安装前会先弹出预览确认
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50">
          {loading && !detail && (
            <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
              <Loader2 className="size-3 animate-spin" />
              从 GitHub 加载详情...
            </div>
          )}
          {!loading && detail && detail.content && (
            <div className="pt-2">
              <div className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1">
                <ShieldQuestion className="size-3" />
                Agent 指令预览（点击安装会写入本地 ~/.claude/agents/）
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-3">
                <MarkdownRenderer content={detail.content} variant="docs" />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="text-[10px] text-muted-foreground">
                  来源：
                  <a
                    href={`https://github.com/jnMetaCode/agency-agents-zh/blob/main/${agent.path}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-primary"
                  >
                    jnMetaCode/agency-agents-zh · {agent.path}
                  </a>
                </div>
                <Button
                  size="sm"
                  variant="default"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInstall(agent);
                  }}
                >
                  <Download className="size-3.5" />
                  <span className="ml-1">安装</span>
                </Button>
              </div>
            </div>
          )}
          {!loading && detail && !detail.content && (
            <p className="text-xs text-muted-foreground py-2">
              详情加载失败，请稍后重试或检查网络。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function computeTargetId(agentId: string, keepOriginal: boolean): string {
  if (keepOriginal) return agentId;
  const safe = agentId.replace(/[^\w\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `mp-${safe}`;
}

function extractPreviewText(content: string, maxLen = 320): string {
  // Skip frontmatter block for human-readable preview.
  const withoutFm = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const raw = withoutFm || content;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen) + '…';
}

/**
 * Read-only dialog for previewing the exact Markdown file from the marketplace.
 */
function MarketplaceMarkdownPreviewDialog({
  agent,
  open,
  onClose,
  onInstall,
}: {
  agent: MarketplaceAgent | null;
  open: boolean;
  onClose: () => void;
  onInstall: (agent: MarketplaceAgent) => void;
}) {
  const {
    marketplaceDetails,
    marketplaceDetailLoading,
    getMarketplaceDetail,
  } = useAgentDefinitionsStore();

  const [detail, setDetail] = useState<MarketplaceAgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !agent) return;

    const cached = marketplaceDetails[agent.id];
    const loading = marketplaceDetailLoading[agent.id];

    setError(null);
    if (cached?.content) {
      setDetail(cached);
      return;
    }

    setDetail(null);
    if (loading) return;

    let cancelled = false;
    void getMarketplaceDetail(agent.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载 Markdown 预览失败');
      });
    return () => {
      cancelled = true;
    };
  }, [open, agent, getMarketplaceDetail, marketplaceDetails, marketplaceDetailLoading]);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      setError(null);
    }
  }, [open]);

  if (!agent) return null;

  const loading = !detail && !error && !!marketplaceDetailLoading[agent.id];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Markdown 预览：{agent.name}</DialogTitle>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
          <DialogDescription className="text-xs">
            来自 <span className="text-foreground">{deptLabel(agent.dept)}</span> 分部 · {agent.description || agent.id}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <Label className="text-muted-foreground">商店 ID</Label>
            <div className="font-mono break-all">{agent.id}</div>
            <Label className="text-muted-foreground">文件路径</Label>
            <a
              href={`https://github.com/jnMetaCode/agency-agents-zh/blob/main/${agent.path}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary inline-flex items-center gap-1 w-fit break-all"
            >
              {agent.path}
              <ExternalLink className="size-3" />
            </a>
            {detail?.content && (
              <>
                <Label className="text-muted-foreground">文件大小</Label>
                <div>{new TextEncoder().encode(detail.content).length.toLocaleString()} 字节</div>
              </>
            )}
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-muted/10 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在加载商店 Markdown...
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/5 px-3 py-3 text-sm text-error">
              <AlertTriangle className="size-4 mt-0.5 shrink-0" />
              <div>Markdown 预览加载失败：{error}</div>
            </div>
          )}

          {!loading && !error && detail?.content && (
            <div className="rounded-lg border border-border/60 bg-background p-4">
              <MarkdownRenderer content={detail.content} variant="docs" />
            </div>
          )}
        </div>

        <DialogFooter className="pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            type="button"
            onClick={() => {
              onClose();
              onInstall(agent);
            }}
          >
            <Download className="size-4" />
            安装此 Agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Preview & confirm dialog shown before actually writing the agent file.
 * Fetches content lazily if not already cached, then displays meta + summary.
 */
function InstallPreviewDialog({
  agent,
  keepOriginalId,
  onToggleKeepOriginal,
  open,
  onClose,
}: {
  agent: MarketplaceAgent | null;
  keepOriginalId: boolean;
  onToggleKeepOriginal: (v: boolean) => void;
  open: boolean;
  onClose: () => void;
}) {
  const {
    marketplaceDetails,
    marketplaceDetailLoading,
    getMarketplaceDetail,
    installMarketplaceAgent,
  } = useAgentDefinitionsStore();

  const [detail, setDetail] = useState<MarketplaceAgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [force, setForce] = useState(false);

  // Reset state when a new agent is opened
  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setError(null);
    setInstalling(false);
    setForce(!!agent?.installed);
  }, [open, agent]);

  // (Re)load detail whenever the agent changes (and open).
  useEffect(() => {
    if (!open || !agent) return;

    const cached = marketplaceDetails[agent.id];
    const loading = marketplaceDetailLoading[agent.id];

    if (cached?.content) {
      setDetail(cached);
      return;
    }
    if (loading) return;

    let cancelled = false;
    setError(null);
    setDetail(null);
    void getMarketplaceDetail(agent.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载预览失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, agent, getMarketplaceDetail, marketplaceDetails, marketplaceDetailLoading]);

  if (!agent) return null;
  const targetId = computeTargetId(agent.id, keepOriginalId);
  const loading = !detail && !error && !!marketplaceDetailLoading[agent.id];
  const previewText = detail?.content ? extractPreviewText(detail.content) : '';

  const handleConfirm = async () => {
    if (!agent) return;
    setInstalling(true);
    try {
      const result = await installMarketplaceAgent(agent.id, {
        force,
        keepOriginalId,
      });
      if (result?.success) {
        toast.success(
          result.overwrote
            ? `已覆盖安装 Agent「${agent.name}」 → ${result.id}`
            : `已安装 Agent「${agent.name}」 → ${result.id}`,
        );
        onClose();
      } else if (result?.conflict) {
        // Offer to turn on force right inside the dialog.
        setForce(true);
        toast.warning('目标 ID 已存在，已自动勾选「覆盖本地同名文件」，请再次确认。');
      } else {
        toast.error(result?.error || '安装失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '安装失败');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !installing && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>安装预览：{agent.name}</DialogTitle>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClose}
              disabled={installing}
            >
              <X className="size-4" />
            </Button>
          </div>
          <DialogDescription className="text-xs">
            来自 <span className="text-foreground">{deptLabel(agent.dept)}</span> 分部 · {agent.description || agent.id}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm min-h-0 flex-1 overflow-y-auto pr-1">
          {/* Meta card */}
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              <Label className="text-muted-foreground">市场 ID</Label>
              <div className="font-mono break-all">{agent.id}</div>

              <Label className="text-muted-foreground">保存文件名</Label>
              <div className="font-mono break-all text-foreground">{targetId}.md</div>

              <Label className="text-muted-foreground">写入位置</Label>
              <div className="font-mono break-all">~/.claude/agents/{targetId}.md</div>

              <Label className="text-muted-foreground">上游来源</Label>
              <a
                href={`https://github.com/jnMetaCode/agency-agents-zh/blob/main/${agent.path}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary inline-flex items-center gap-1 w-fit"
              >
                {agent.path}
                <ExternalLink className="size-3" />
              </a>

              {detail?.content && (
                <>
                  <Label className="text-muted-foreground">文件大小</Label>
                  <div>
                    {new TextEncoder().encode(detail.content).length.toLocaleString()} 字节
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Naming option */}
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label className="text-xs font-normal">
              保留原始文件名（不使用 <span className="font-mono">mp-</span> 前缀）
            </Label>
            <Switch
              checked={keepOriginalId}
              onCheckedChange={onToggleKeepOriginal}
              disabled={installing}
            />
          </div>

          {/* Conflict / force option */}
          <div
            className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 ${
              force || agent.installed
                ? 'border-warning bg-warning/5'
                : 'border-border'
            }`}
          >
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-xs">
                {agent.installed && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-success/10 text-success">
                    <CheckCircle2 className="size-3" />
                    已安装
                  </span>
                )}
                <Label className="font-normal">
                  覆盖本地同名文件
                </Label>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                勾选后会直接写入 <span className="font-mono">{targetId}.md</span>，
                已有的本地修改会丢失。
              </p>
            </div>
            <Switch
              checked={force}
              onCheckedChange={setForce}
              disabled={installing}
            />
          </div>

          {/* Content preview */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileCode2 className="size-3.5" />
              <span>内容预览（首段摘要）</span>
            </div>
            {loading && (
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-3 py-4 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                从 GitHub 拉取 Agent 内容...
              </div>
            )}
            {!loading && error && (
              <div className="flex items-start gap-2 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">
                <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                <div>
                  <div>预览加载失败：{error}</div>
                  <div className="text-[11px] mt-0.5 opacity-80">
                    不影响安装，确认后会在写入时重新从 GitHub 拉取。
                  </div>
                </div>
              </div>
            )}
            {!loading && !error && detail?.content && (
              <div className="space-y-2">
                <p className="rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-xs leading-5 text-foreground/90 whitespace-pre-wrap">
                  {previewText}
                </p>
                <details className="rounded-md border border-border/60 bg-muted/5">
                  <summary className="px-3 py-1.5 text-xs text-muted-foreground cursor-pointer list-none hover:text-foreground">
                    查看完整指令正文
                  </summary>
                  <div className="max-h-72 overflow-y-auto border-t border-border/50 p-3">
                    <MarkdownRenderer content={detail.content} variant="docs" />
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="ghost" onClick={onClose} disabled={installing}>
            取消
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={installing || !open}
            variant={force || agent.installed ? 'destructive' : 'default'}
          >
            {installing && <Loader2 className="size-4 animate-spin" />}
            {force || agent.installed ? '确认覆盖安装' : '确认安装'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstallAgentMarketplaceDialog({
  open,
  onClose,
}: InstallAgentMarketplaceDialogProps) {
  const {
    marketplaceAgents,
    marketplaceDepartments,
    marketplaceLoading,
    marketplaceError,
    marketplaceInstalling,
    loadMarketplaceCatalog,
  } = useAgentDefinitionsStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('');
  const [showInstalledOnly, setShowInstalledOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [keepOriginalId, setKeepOriginalId] = useState(false);

  // Read-only markdown preview dialog state
  const [previewAgent, setPreviewAgent] = useState<MarketplaceAgent | null>(null);
  // Preview confirm dialog state
  const [installAgent, setInstallAgent] = useState<MarketplaceAgent | null>(null);

  const installingCount = useMemo(
    () => Object.values(marketplaceInstalling).filter(Boolean).length,
    [marketplaceInstalling],
  );

  useEffect(() => {
    if (open) {
      void loadMarketplaceCatalog();
    }
    if (!open) {
      // Close preview when parent closes
      setPreviewAgent(null);
      setInstallAgent(null);
    }
  }, [open, loadMarketplaceCatalog]);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    await loadMarketplaceCatalog(searchQuery.trim(), deptFilter);
  };

  const handleDeptChange = async (nextDept: string) => {
    setDeptFilter(nextDept);
    await loadMarketplaceCatalog(searchQuery.trim(), nextDept);
  };

  const filtered = useMemo(() => {
    let list = marketplaceAgents;
    if (showInstalledOnly) list = list.filter((a) => a.installed);
    // Additional local search beyond the backend query (for dept filter etc.)
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          a.dept.toLowerCase().includes(q),
      );
    }
    return list;
  }, [marketplaceAgents, searchQuery, showInstalledOnly]);

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && installingCount === 0 && onClose()}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>从商店添加 Agent</DialogTitle>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClose}
              disabled={installingCount > 0}
            >
              <X className="size-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            来源：
            <a
              href="https://github.com/jnMetaCode/agency-agents-zh"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              jnMetaCode/agency-agents-zh
            </a>
            · 共 197 个中文专家角色，写入 ~/.claude/agents 后由 Claude Code / SDK 自动发现。
          </p>
        </DialogHeader>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-end">
          <form onSubmit={handleSearch} className="flex gap-2">
            <Input
              type="text"
              placeholder="搜索名称、关键词、部门..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={marketplaceLoading}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={marketplaceLoading}
            >
              {marketplaceLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
            </Button>
          </form>
          <select
            value={deptFilter}
            onChange={(e) => void handleDeptChange(e.target.value)}
            disabled={marketplaceLoading}
            className="h-9 px-3 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">全部分部</option>
            {marketplaceDepartments.map((d) => (
              <option key={d} value={d}>
                {deptLabel(d)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 px-3 py-2 border border-border rounded-md text-sm">
            <Switch
              checked={showInstalledOnly}
              onCheckedChange={setShowInstalledOnly}
              disabled={marketplaceLoading}
            />
            <span className="whitespace-nowrap">仅看已装</span>
          </label>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            共 {filtered.length} / {marketplaceAgents.length}
          </span>
          <label className="flex items-center gap-1.5 select-none">
            <Switch
              checked={keepOriginalId}
              onCheckedChange={setKeepOriginalId}
            />
            <span>保留原始文件名（不使用 mp- 前缀）</span>
          </label>
        </div>

        {/* List */}
        <div className="overflow-y-auto space-y-2 min-h-0 flex-1 pr-1">
          {!marketplaceLoading && !marketplaceError && filtered.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-primary">
              <span className="flex items-center gap-1.5">
                <Eye className="size-3.5" />
                每个 Agent 卡片右侧都有 <b>预览</b> 和 <b>安装</b> 两个按钮：预览可先查看完整 Markdown，安装会确认保存位置后再写入本地。
              </span>
              {expandedId && (
                <button
                  type="button"
                  className="underline hover:text-primary/80 shrink-0"
                  onClick={() => setExpandedId(null)}
                >
                  收起全部
                </button>
              )}
            </div>
          )}
          {marketplaceLoading && marketplaceAgents.length === 0 && (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin mr-2" />
              加载目录...
            </div>
          )}
          {!marketplaceLoading && marketplaceError && (
            <div className="py-8 text-center text-sm text-error">
              {marketplaceError}
            </div>
          )}
          {!marketplaceLoading && !marketplaceError && filtered.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              没有匹配的 Agent
            </div>
          )}
          {filtered.map((agent) => (
            <AgentCardItem
              key={agent.id}
              agent={agent}
              expanded={expandedId === agent.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === agent.id ? null : agent.id))
              }
              onOpenPreview={(a) => setPreviewAgent(a)}
              onOpenInstall={(a) => setInstallAgent(a)}
            />
          ))}
        </div>

        <DialogFooter className="pt-2">
          <div className="w-full flex items-center justify-between text-xs text-muted-foreground">
            <Label className="text-xs font-normal">
              安装的 Agent 会出现在左侧列表中，并被 Claude Code / SDK 在下次会话中自动发现。
            </Label>
            <Button type="button" variant="ghost" onClick={onClose} disabled={installingCount > 0}>
              关闭
              {installingCount > 0 && (
                <span className="ml-1">（{installingCount} 安装中）</span>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <MarketplaceMarkdownPreviewDialog
      agent={previewAgent}
      open={!!previewAgent}
      onClose={() => setPreviewAgent(null)}
      onInstall={(agent) => setInstallAgent(agent)}
    />

    <InstallPreviewDialog
      agent={installAgent}
      open={!!installAgent}
      keepOriginalId={keepOriginalId}
      onToggleKeepOriginal={setKeepOriginalId}
      onClose={() => setInstallAgent(null)}
    />
    </>
  );
}
