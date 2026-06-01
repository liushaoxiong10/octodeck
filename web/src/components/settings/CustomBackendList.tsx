import { useEffect, useState } from 'react';
import { Loader2, Pencil, Trash2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  useCustomBackendsStore,
  type CustomBackendDef,
} from '../../stores/customBackends';
import { useAgentLinksStore } from '../../stores/agentLinks';
import CustomBackendFormDialog from './CustomBackendFormDialog';
import { getErrorMessage } from './types';

export default function CustomBackendList() {
  const { backends, loading, load, remove } = useCustomBackendsStore();
  const { links: devices, load: loadDevices } = useAgentLinksStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomBackendDef | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    load();
    loadDevices();
  }, [load, loadDevices]);

  const handleCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleEdit = (b: CustomBackendDef) => {
    setEditing(b);
    setDialogOpen(true);
  };

  const handleDelete = async (b: CustomBackendDef) => {
    if (!window.confirm(`确认删除 backend "${b.id}"？`)) return;
    setRemoving(b.id);
    try {
      await remove(b.id);
      toast.success(`已删除 ${b.id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '删除失败'));
    } finally {
      setRemoving(null);
    }
  };

  const deviceName = (id?: string | null) => {
    if (!id) return null;
    const device = devices.find((d) => d.id === id);
    return device ? `${device.displayName} (${id})` : id;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            自定义 Agent
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            把任意 CLI（codex / aider / coco fork…）注册成 HappyClaw Agent。
            可选择服务端本机或指定设备运行；保存即生效。
          </p>
        </div>
        <Button size="sm" onClick={handleCreate}>
          <Plus className="size-4" />
          新增 Agent
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : backends.length === 0 ? (
        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md py-6 text-center">
          还没有自定义 Agent，点右上角「新增 Agent」。
        </div>
      ) : (
        <div className="border border-border rounded-md divide-y divide-border">
          {backends.map((b) => (
            <div
              key={b.id}
              className="flex items-start gap-3 px-3 py-2.5 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{b.displayName}</span>
                  <span className="text-xs text-muted-foreground">
                    ({b.id})
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {b.outputProtocol}
                  </span>
                  {b.usesProviderPool ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      provider-pool
                    </span>
                  ) : null}
                  {b.deviceLinkId ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      device
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground mt-1 truncate">
                  <code>{b.binary}</code> {b.argvTemplate.join(' ')}
                </div>
                {b.deviceLinkId ? (
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">
                    运行设备：{deviceName(b.deviceLinkId)}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleEdit(b)}
                  aria-label="编辑"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removing === b.id}
                  onClick={() => handleDelete(b)}
                  aria-label="删除"
                >
                  {removing === b.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CustomBackendFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        backend={editing}
      />
    </div>
  );
}
