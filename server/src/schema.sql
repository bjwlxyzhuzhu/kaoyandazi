-- 山海问知 数据库结构（PRD 第8章，SQLite）
-- 时间字段统一保存为 Asia/Shanghai 本地时间字符串 'YYYY-MM-DD HH:MM:SS'。
-- 在第8章基础上的少量补充字段均以「补充」注明，并记录在 README。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  is_sandbox INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL DEFAULT 'student',          -- student | teacher
  student_no TEXT NOT NULL UNIQUE,               -- 教师用登录名
  name TEXT NOT NULL,
  email TEXT,
  major TEXT,
  major_group TEXT,
  grade TEXT,
  pw_hash TEXT NOT NULL,
  persona TEXT,                                  -- 陪伴导师稳定键，兼容旧中文人设
  email_remind INTEGER NOT NULL DEFAULT 1,
  remind_hour INTEGER NOT NULL DEFAULT 20,
  key_enc TEXT,                                  -- 学生主动选择加密保存时才有值
  consent_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT,
  class_id INTEGER REFERENCES classes(id),       -- 补充：所属班级（由邀请码决定）
  use_own_key_basic INTEGER NOT NULL DEFAULT 0   -- 补充：5.3「基础模块也用我的 Key」偏好
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS flow_status (
  user_id INTEGER NOT NULL,
  station INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',    -- not_started | in_progress | done
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, station)
);

CREATE TABLE IF NOT EXISTS menu_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  flow TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  profile_json TEXT,
  paths_json TEXT,
  chosen_path TEXT,
  choice_reason TEXT,
  path_scores_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS profile_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user_kind ON conversations(user_id, kind);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  role TEXT NOT NULL,                            -- user | assistant
  content TEXT NOT NULL,
  options_json TEXT,
  created_at TEXT NOT NULL,
  agent_key TEXT                                 -- 补充：本条回复冻结时使用的导师键
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id);

CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kind TEXT,
  purpose TEXT,
  model TEXT,
  key_source TEXT,                               -- platform | user | demo
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  ok INTEGER DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_calls(user_id, created_at);

CREATE TABLE IF NOT EXISTS ai_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  object_id INTEGER,
  action TEXT NOT NULL,                          -- confirm | modify | verify | reject
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  school TEXT NOT NULL,
  major TEXT,
  tier TEXT,
  facts_json TEXT,
  basis TEXT,
  uncertainty TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  reduce_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT,
  minutes INTEGER DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  minutes INTEGER DEFAULT 0,
  accuracy REAL,
  done_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  reflection TEXT,
  mood INTEGER,
  UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  rate REAL,
  blockers_json TEXT,
  adjust_json TEXT,
  summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chapter INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  content_json TEXT,
  score REAL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, chapter, task_id)
);

CREATE TABLE IF NOT EXISTS peer_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL,
  rubric_json TEXT,
  comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT,
  name TEXT NOT NULL,
  deadline TEXT,
  stage TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  rule TEXT NOT NULL,
  title TEXT,
  message TEXT,
  options_json TEXT,
  chosen TEXT,
  note TEXT,
  emailed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kind TEXT,
  date TEXT,
  ok INTEGER,
  info TEXT,
  created_at TEXT NOT NULL
);

-- 知识库
CREATE TABLE IF NOT EXISTS kb_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  space TEXT NOT NULL,                           -- prep | research
  type TEXT NOT NULL,                            -- knowledge | mistake | note
  title TEXT,
  content_json TEXT,
  tags_json TEXT,
  mastery INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  authors_json TEXT,
  year INTEGER,
  venue TEXT,
  doi TEXT,
  url TEXT,
  abstract TEXT,
  lang TEXT,
  source TEXT,
  verify_status TEXT,
  verify_info TEXT,
  read_status TEXT,
  topic_id INTEGER,
  tags_json TEXT,
  pdf_path TEXT,
  fulltext TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  paper_id INTEGER,
  question TEXT,
  method TEXT,
  evidence TEXT,
  conclusion TEXT,
  limitation TEXT,
  my_judgment TEXT,
  doubts TEXT,
  ai_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  description TEXT
);

CREATE TABLE IF NOT EXISTS topic_ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question TEXT,
  significance TEXT,
  feasibility TEXT,
  method TEXT,
  risks TEXT,
  paper_ids_json TEXT,
  status TEXT,
  drop_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  paper_id INTEGER,
  minutes INTEGER,
  created_at TEXT NOT NULL
);

-- 补充（阶段5）：考核用知识库报告里由学生自己挑选的精选条目（最多5条）
CREATE TABLE IF NOT EXISTS knowledge_report_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- paper | card | item | idea
  ref_id INTEGER NOT NULL,
  title TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

-- 复试与考核
CREATE TABLE IF NOT EXISTS mock_interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  config_json TEXT,
  transcript_json TEXT,
  scores_json TEXT,
  review_json TEXT,
  self_review TEXT,
  twin_rehearsal_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interview_qbank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  source TEXT,
  examiner_key TEXT,
  my_notes TEXT,
  status TEXT NOT NULL DEFAULT '待重练',          -- 待重练 | 已重练
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  draft_json TEXT,
  reflections_json TEXT,
  ai_statement_json TEXT,
  submitted_at TEXT
);

CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item TEXT NOT NULL,
  score REAL,
  rubric_json TEXT,
  comment TEXT,
  grader_id INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- pre | mid | post | satisfaction
  answers_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- v3.0 导师注册与学习（M20）
CREATE TABLE IF NOT EXISTS mentors (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT,
  stage_tags_json TEXT,
  current_version TEXT,
  status TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS mentor_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mentor_key TEXT NOT NULL,
  version TEXT NOT NULL,
  persona_json TEXT,
  change_note TEXT,
  eval_result_json TEXT,
  published_by INTEGER,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS mentor_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mentor_key TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  license_note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mentor_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  mentor_key TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS mentor_chunks_fts USING fts5(
  content, mentor_key UNINDEXED, doc_id UNINDEXED,
  content='mentor_chunks', content_rowid='id', tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS mentor_evalsets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mentor_key TEXT NOT NULL,
  question TEXT NOT NULL,
  expected_points_json TEXT
);

CREATE TABLE IF NOT EXISTS mentor_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mentor_key TEXT NOT NULL,
  message_ref TEXT,
  rating TEXT,
  reason_tags_json TEXT,
  comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mentor_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mentor_key TEXT NOT NULL,
  insight TEXT NOT NULL,
  evidence_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  approved_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mentor_student_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mentor_key TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mentor_prefs (
  user_id INTEGER NOT NULL,
  mentor_key TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  style_pref TEXT,
  PRIMARY KEY (user_id, mentor_key)
);

CREATE TABLE IF NOT EXISTS experience_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT,
  consent_note TEXT,
  anonymized INTEGER NOT NULL DEFAULT 0,
  approved_by INTEGER,
  created_at TEXT NOT NULL
);

-- v3.0 导师团（M18）
CREATE TABLE IF NOT EXISTS group_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  mentors_json TEXT,
  twin_joined INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  action_items_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  speaker_type TEXT NOT NULL,                    -- user | mentor | host | twin
  speaker_key TEXT,
  content TEXT NOT NULL,
  sources_json TEXT,
  options_json TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- v3.0 数字分身（M19）
CREATE TABLE IF NOT EXISTS twins (
  user_id INTEGER PRIMARY KEY,
  name TEXT,
  icon TEXT,
  profile_json TEXT,
  sources_json TEXT,
  locked_json TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS twin_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  filename TEXT,
  kind TEXT,
  text_redacted TEXT,
  redaction_log_json TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twin_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  field TEXT,
  before_text TEXT,
  after_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twin_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  purpose TEXT NOT NULL,                         -- meeting | rehearsal | future
  transcript_json TEXT,
  created_at TEXT NOT NULL
);

-- 补充（阶段6）：M15 API实验室“我的小智能体”（系统提示词 + 模型 + 参数，第六章课堂任务）。第8章未列此表。
CREATE TABLE IF NOT EXISTS lab_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  system_prompt TEXT,
  model TEXT,
  temperature REAL,
  max_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lab_agents_user ON lab_agents(user_id);
