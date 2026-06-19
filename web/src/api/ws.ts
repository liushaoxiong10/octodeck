import { replaceInApp, withBasePath } from '../utils/url';
import type { OctoDeckEvent, OctoDeckEventDomain } from '../octodeck-event.types';
import { octodeckEventsFromWsMessage } from '../realtime-events';

type WsHandler = (data: any) => void;
type WsEventName = 'connected' | 'disconnected' | `octodeck_event:${OctoDeckEventDomain | 'any'}`;

export type { OctoDeckEvent };

class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<WsEventName, Set<WsHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;

  connect() {
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${withBasePath('/ws')}`,
    );
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = 1000;
      this.emit('connected', {});
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(event.data);
        for (const event of octodeckEventsFromWsMessage(data)) {
          this.emit('octodeck_event:any', { type: 'octodeck_event', event, raw: data });
          this.emit(`octodeck_event:${event.domain}`, { type: 'octodeck_event', event, raw: data });
        }
      } catch {}
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.emit('disconnected', {});
      // 1008 = Policy Violation (backend auth failure), 4001 = custom auth error
      if (event.code === 1008 || event.code === 4001) {
        this.ws = null;
        replaceInApp('/login');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      ws.close();
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  on(type: WsEventName, handler: WsHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  private emit(type: WsEventName, data: any) {
    this.handlers.get(type)?.forEach(h => h(data));
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  /** Listen for network status changes to reconnect immediately or pause retries. */
  setupNetworkListeners() {
    window.addEventListener('online', () => {
      // Network restored — reconnect immediately, reset backoff
      if (!this.isConnected()) {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.reconnectDelay = 1000;
        this.connect();
      }
    });
    window.addEventListener('offline', () => {
      // Network lost — cancel pending reconnect to avoid wasted attempts
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });
  }
}

export const wsManager = new WsManager();
wsManager.setupNetworkListeners();
