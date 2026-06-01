import { useState } from 'react';
import { toast } from 'sonner';

import { ClaudeProviderSection } from '../components/settings/ClaudeProviderSection';

export function ModelEndpointsPage() {
  const [, setNoticeState] = useState<string | null>(null);
  const [, setErrorState] = useState<string | null>(null);

  const setNotice = (msg: string | null) => {
    setNoticeState(msg);
    if (msg) toast.success(msg);
  };
  const setError = (msg: string | null) => {
    setErrorState(msg);
    if (msg) toast.error(msg);
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-6xl mx-auto p-4 lg:p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">模型端点</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理供应商连接、认证信息和可用模型列表。每个供应商下可维护模型，并可从供应商 API 自动拉取。
          </p>
        </div>
        <ClaudeProviderSection setNotice={setNotice} setError={setError} />
      </div>
    </div>
  );
}
