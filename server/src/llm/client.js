// OpenAI 兼容接口客户端（TokenONE 中转站 / DeepSeek），支持流式输出；接口地址为 mock 时使用内置模拟模型
import { AppError, MSG } from '../errors.js';
import { redact } from '../crypto.js';
import { isMock } from './settings.js';
import { config } from '../config.js';
import { mockStream, mockModels } from './mock.js';

const TIMEOUT_MS = 90_000;
// 带思考过程的模型会先花掉一大段 token 再输出正文，上限给小了正文就是空的。
// 所有调用统一留出思考预算，成本很低。
const MIN_MAX_TOKENS = 2000;

/**
 * 思考模式：DeepSeek 这类推理模型会先输出隐藏的 reasoning_content，
 * 正文可能因此为空或很慢。思考由教师配置控制：
 *   thinking  on  → 打开思考
 *           off → 完全关闭
 *           auto→ 由模型自己决定（默认）
 * 不同中转站接受不同的参数名，所以两个都带上，多传的字段会被忽略。
 */
function thinkingParams() {
  const mode = String(config.llm.thinking || 'auto').toLowerCase();
  if (mode === 'on') return {};
  if (mode === 'off') return { thinking: { type: 'disabled' }, reasoning_effort: 'none' };
  return { reasoning_effort: 'none' };
}

function mapError(status, bodyText, source) {
  const t = String(bodyText || '').toLowerCase();
  const own = source === 'user' || source === 'demo';
  if (status === 429) return new AppError(429, 'RATE_LIMITED', MSG.RATE_LIMITED);
  if (status === 402 || /insufficient|balance|quota|余额|额度不足/.test(t)) {
    return new AppError(402, own ? 'USER_NO_BALANCE' : 'PLATFORM_FAILED', own ? MSG.USER_NO_BALANCE : MSG.PLATFORM_FAILED);
  }
  if (status === 401 || status === 403) {
    return new AppError(401, own ? 'USER_KEY_INVALID' : 'PLATFORM_FAILED', own ? MSG.USER_KEY_INVALID : MSG.PLATFORM_FAILED);
  }
  return new AppError(502, own ? 'LLM_FAILED' : 'PLATFORM_FAILED', own ? '模型服务返回错误，请稍后重试。' : MSG.PLATFORM_FAILED);
}

/**
 * 发请求。中转站在冷启动时第一次连接可能超时（DNS/TLS 握手），
 * 所以网络层失败重试一次——重试只针对连不上，不针对接口返回的错误。
 */
async function request(url, init, { retry = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      const transient = e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || e?.message === 'fetch failed';
      if (attempt < retry && transient) {
        console.warn('[LLM] 连接失败，正在重试一次：', redact(e?.cause?.code || e?.message));
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      console.warn('[LLM] 网络错误：', redact(e?.message));
      throw new AppError(504, 'NETWORK', MSG.NETWORK);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** GET /models：测试连通并拉取模型列表 */
export async function listModels({ baseUrl, key, source = 'user' }) {
  if (isMock(baseUrl)) return mockModels(key, source);
  if (!baseUrl) throw new AppError(503, 'PLATFORM_NOT_CONFIGURED', MSG.PLATFORM_NOT_CONFIGURED);
  const res = await request(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[LLM] /models 返回 ${res.status}：${redact(text).slice(0, 200)}`);
    throw mapError(res.status, text, source);
  }
  try {
    const data = JSON.parse(text);
    return (data.data || []).map((m) => m.id).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/**
 * 流式对话。onDelta(text) 逐段回调；返回 { content, usage, model }。
 * 失败抛出 AppError（message 为中文提示）。
 */
export async function streamChat({ baseUrl, key, model, messages, temperature = 0.7, maxTokens = 1200, source, onDelta, jsonMode = false }) {
  if (isMock(baseUrl)) return mockStream({ key, source, model, messages, onDelta, jsonMode });
  const body = {
    model, messages, temperature, max_tokens: Math.max(maxTokens, MIN_MAX_TOKENS), stream: true,
    stream_options: { include_usage: true },
    ...thinkingParams(),
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await request(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    console.warn(`[LLM] chat 返回 ${res.status}：${redact(text).slice(0, 200)}`);
    throw mapError(res.status, text, source);
  }

  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let usage = null;
  let usedModel = model;
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.model) usedModel = j.model;
        if (j.usage) usage = j.usage;
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onDelta?.(delta);
        }
      }
    }
  } catch (e) {
    console.warn('[LLM] 流读取中断：', redact(e?.message));
    if (!content) throw new AppError(504, 'NETWORK', MSG.NETWORK);
  }
  if (!usage) {
    // 中转站未返回用量时按字符粗略估算，并在留痕中保持可追溯（error 字段注明为估算）
    usage = { prompt_tokens: estimateTokens(messages.map((m) => m.content).join('')), completion_tokens: estimateTokens(content), estimated: true };
  }
  return { content, usage, model: usedModel };
}

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 1.5);
}
