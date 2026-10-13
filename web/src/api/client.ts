// 前端接口封装。学生 Key 只保存在本机浏览器的专用存储项中，仅在需要时通过 X-User-Key 发送。

const KEY_STORE = 'swz.userKey';

export const userKeyStore = {
  get(): string {
    try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
  },
  set(key: string) {
    try { localStorage.setItem(KEY_STORE, key); } catch { /* 隐私模式下无法保存 */ }
  },
  clear() {
    try { localStorage.removeItem(KEY_STORE); } catch { /* 忽略 */ }
  },
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  /** 是否附带学生自己的 Key（只用于需要判断 Key 的接口） */
  withKey?: boolean;
  /** 显式指定要测试的 Key（不从本地存储读取） */
  key?: string;
}

function headersFor(opts: ApiOptions): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) h['Content-Type'] = 'application/json';
  const k = opts.key ?? (opts.withKey ? userKeyStore.get() : '');
  if (k) h['X-User-Key'] = k;
  return h;
}

async function toError(res: Response): Promise<ApiError> {
  let data: { error?: string; code?: string } = {};
  try { data = await res.json(); } catch { /* 非 JSON */ }
  const fallback = res.status === 401 ? '请先登录。' : res.status >= 500 ? '服务器出了点问题，请稍后重试。' : '请求没有成功，请重试。';
  return new ApiError(res.status, data.code || `HTTP_${res.status}`, data.error || fallback);
}

/**
 * 写请求去重：同一个写操作（方法 + 路径 + 内容都相同）还没返回时再次发起，直接复用同一个结果。
 * 连点、双击、回车加点击都只会真正提交一次。
 */
const inflight = new Map<string, Promise<unknown>>();

export function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  if (method === 'GET') return request<T>(path, opts);
  const key = `${method} ${path} ${opts.body === undefined ? '' : JSON.stringify(opts.body)}`;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = request<T>(path, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function request<T>(path: string, opts: ApiOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: headersFor(opts),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络连接失败，请检查网络后重试。');
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export interface SseHandlers {
  onEvent: (event: string, data: any) => void;
}

/** POST + SSE：后端在开始流式输出前出错时返回 JSON 错误，这里转为 ApiError 抛出 */
export async function streamPost(path: string, body: unknown, handlers: SseHandlers, opts: { withKey?: boolean } = {}) {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...headersFor({ body, withKey: opts.withKey }), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络连接失败，请检查网络后重试。');
  }
  if (!res.ok) throw await toError(res);
  if (!res.body || !(res.headers.get('Content-Type') || '').includes('text/event-stream')) {
    throw new ApiError(500, 'BAD_STREAM', '回复格式异常，请重试。');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { handlers.onEvent(event, JSON.parse(data)); } catch { /* 单个事件解析失败不中断 */ }
    }
  }
}
