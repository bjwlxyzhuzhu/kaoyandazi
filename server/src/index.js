// 山海问知 后端入口
import { config, checkSecrets } from './config.js';
import { createApp } from './app.js';
import { getLlmConfig } from './llm/settings.js';
import { startScheduler } from './scheduler.js';
import { mailConfigured } from './mail.js';

checkSecrets();
const app = createApp();
app.listen(config.port, () => {
  const llm = getLlmConfig();
  console.log(`[山海问知] 后端已启动：http://localhost:${config.port}`);
  if (!config.teacherAccounts.length) console.warn('[配置] 未设置 TEACHER_ACCOUNTS，教师无法登录。');
  if (llm.mock) console.warn('[配置] 当前使用内置模拟模型（LLM_BASE_URL=mock），回复不是真实模型输出。');
  else if (!llm.baseUrl || !llm.platformKey) console.warn('[配置] 平台模型尚未配置（接口地址或平台 Key 为空），基础模块暂不可用。');
  if (!mailConfigured()) console.warn('[配置] 未配置 SMTP（需要 QQ 邮箱授权码），邮件提醒不会发送，站内提醒照常工作。');
  startScheduler();
});
