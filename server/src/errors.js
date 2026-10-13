// 统一的业务错误：message 是直接给学生看的中文提示
export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const MSG = {
  NEED_USER_KEY: '这个功能需要绑定你自己的 API Key。可以到“我 → 模型与 API Key”绑定；不绑定也不影响结课考核。',
  QUOTA_DAILY: '今天的基础额度用完了，明天恢复；你也可以绑定自己的 Key 继续使用。',
  QUOTA_MONTHLY: '本月班级的基础模块额度已经用完，基础模块暂停使用，请联系老师；你也可以绑定自己的 Key 继续使用。',
  PLATFORM_NOT_CONFIGURED: '平台模型还没有配置好，请联系老师。',
  USER_KEY_INVALID: '你的 API Key 无效或已失效，请到“我 → 模型与 API Key”检查后再试。',
  USER_NO_BALANCE: '你的 API 余额可能不足，请到中转站充值后再试',
  RATE_LIMITED: '请求太频繁或中转站正在限流，请稍等一会儿再试。',
  PLATFORM_FAILED: '平台模型暂时不可用，请稍后再试；如果一直这样，请告诉老师。',
  NETWORK: '连接模型服务失败，请检查网络后重试。',
};
