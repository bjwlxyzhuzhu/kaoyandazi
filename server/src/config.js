// 读取环境变量与运行配置。接口地址、Key、模型名一律来自配置，禁止写死在代码里。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');
export const SHARED_DIR = path.join(ROOT_DIR, 'shared');

// 依次尝试加载项目根目录与 server 目录下的 .env（已存在的环境变量优先）
for (const p of [path.join(ROOT_DIR, '.env'), path.join(ROOT_DIR, 'server', '.env')]) {
  if (fs.existsSync(p)) {
    try { process.loadEnvFile(p); } catch { /* 忽略格式错误，交给默认值 */ }
  }
}

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

function parseTeachers(raw) {
  // 格式：用户名:密码,用户名:密码
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      return i > 0 ? { username: pair.slice(0, i).trim(), password: pair.slice(i + 1) } : null;
    })
    .filter(Boolean);
}

export const config = {
  port: num(env.PORT, 3000),
  siteUrl: env.SITE_URL || '',
  sessionSecret: env.SESSION_SECRET || '',
  keyEncSecret: env.KEY_ENC_SECRET || '',
  teacherAccounts: parseTeachers(env.TEACHER_ACCOUNTS),
  dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || 'data'),
  tz: env.APP_TZ || 'Asia/Shanghai',
  isProd: env.NODE_ENV === 'production',
  defaultInviteCode: env.DEFAULT_INVITE_CODE || '',

  llm: {
    baseUrl: env.LLM_BASE_URL || '',
    chatModel: env.LLM_CHAT_MODEL || '',
    reasonModel: env.LLM_REASON_MODEL || '',
    toolCalling: env.TOOL_CALLING || 'auto',
    thinking: env.LLM_THINKING || 'auto',
    platformKey: env.LLM_PLATFORM_KEY || '',
    basicDailyLimit: num(env.BASIC_DAILY_LIMIT, 60),
    monthlyTokenBudget: num(env.MONTHLY_TOKEN_BUDGET, 0),
    demoKey: env.DEMO_API_KEY || '',
  },

  search: {
    provider: env.SEARCH_PROVIDER || 'none',
    relayModel: env.SEARCH_RELAY_MODEL || '',
    bochaKey: env.BOCHA_API_KEY || '',
    bochaBaseUrl: (env.BOCHA_BASE_URL || 'https://api.bochaai.com/v1').replace(/\/+$/, ''),
    dailyLimitPerUser: (() => { const v = Number(env.SEARCH_DAILY_LIMIT_PER_USER); return Number.isFinite(v) && v > 0 ? v : 30; })(),
  },
};

// 开发环境下缺少密钥时给出提示，生产环境直接拒绝启动
export function checkSecrets() {
  const missing = [];
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  if (!config.keyEncSecret) missing.push('KEY_ENC_SECRET');
  if (missing.length) {
    if (config.isProd) {
      throw new Error(`缺少必需的环境变量：${missing.join('、')}`);
    }
    console.warn(`[配置] 未设置 ${missing.join('、')}，开发模式下自动生成并保存在数据目录 dev-secrets.json（正式部署必须在环境变量中配置）。`);
  }
}
