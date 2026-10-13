// 前后端共享的数据形状

export interface Me {
  id: number;
  role: 'student' | 'teacher';
  student_no: string;
  name: string;
  email: string | null;
  major: string | null;
  major_group: string | null;
  grade: string | null;
  persona: string | null;
  email_remind: boolean;
  remind_hour: number;
  consent_at: string | null;
  is_demo: boolean;
  expires_at?: string | null;
  class: { id: number; name: string; is_sandbox: boolean } | null;
  key_saved_on_server: boolean;
  key_mask: string;
  use_own_key_basic: boolean;
  prepare_done: boolean;
}

export interface AgentInfo {
  key: string;
  role: string | null;
  name: string;
  duty: string;
  module: string;
  group: string;
  icon: string;
  aliases: string[];
  summary: string;
  chat: boolean;
  worker: boolean;
  version?: string | null;
}

export interface OptionItem {
  key: string;
  label: string;
  hint?: string;
}

/** 选项协议（PRD 4.2） */
export interface OptionsBlock {
  options: OptionItem[];
  multi: boolean;
  free_text: boolean;
  stage_done: boolean;
  artifact: unknown;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  options: OptionsBlock | null;
  agent_key: string | null;
  created_at: string;
}

export interface ModuleRow {
  id: string;
  name: string;
  module: string;
  tier: 'basic' | 'advanced';
  note: string;
  route: string | null;
  open: boolean;
  status: 'available' | 'need_key' | 'quota_exhausted';
}

export interface Quota {
  used: number;
  limit: number;
  remaining: number;
  daily_exhausted: boolean;
  monthly_blocked: boolean;
}
