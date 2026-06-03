import { MonitorSmartphone, ShieldCheck, Zap } from 'lucide-react';

import { DevicesSection } from '../components/settings/AgentLinksSection';

export function DevicesPage() {
  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8 space-y-6">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-muted/20 p-6 lg:p-8">
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-primary/10 to-transparent" />
          <div className="relative max-w-2xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <MonitorSmartphone className="size-3.5" />
              Devices
            </div>
            <div>
              <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
                设备管理
              </h1>
              <p className="mt-2 text-sm text-muted-foreground leading-6">
                将 octodeck-daemon 客户端注册为可信设备。Claude 后端会把本地工具调用转发到设备执行；
                非 Claude 后端会把完整运行上下文交给设备上的本地 agent。
              </p>
            </div>
            <div className="grid gap-2 pt-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="flex items-center gap-2 rounded-xl bg-background/70 px-3 py-2 border border-border/60">
                <ShieldCheck className="size-4 text-emerald-500" />
                Token 只展示一次，支持随时重置
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-background/70 px-3 py-2 border border-border/60">
                <Zap className="size-4 text-amber-500" />
                在线状态自动刷新，可作为执行节点
              </div>
            </div>
          </div>
        </div>

        <DevicesSection />
      </div>
    </div>
  );
}

export default DevicesPage;
