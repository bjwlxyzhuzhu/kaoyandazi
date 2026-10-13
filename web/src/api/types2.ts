// 阶段2新增的数据形状（主线、菜单、问卷、画像、择校、方案、打卡、课堂）

export interface StationRow {
  station: number;
  key: string;
  name: string;
  full: string;
  chapter: string;
  product: string;
  goal: string;
  route: string;
  open: boolean;
  status: 'not_started' | 'in_progress' | 'done';
  updated_at: string | null;
}

export interface FlowResp {
  stations: StationRow[];
  current: number;
  done_count: number;
}

export interface TodayResp {
  current: number;
  station: StationRow;
  next_step: string;
  action: string;
  action_route: string;
  stats: {
    done_stations: number;
    total_stations: number;
    today_tasks: number;
    today_tasks_done: number;
    today_checked: boolean;
    pending_interventions: number;
  };
  mentors: { primary: AgentBrief | null; co: AgentBrief | null; primaryLabel: string; coLabel: string };
  handoff: { from: string; text: string } | null;
}

export interface AgentBrief { key: string; name: string; duty: string; icon: string; summary: string }

export type MenuQuestion =
  | { key: string; label: string; type: 'single'; options: string[]; required?: boolean }
  | { key: string; label: string; type: 'multi'; options: string[]; required?: boolean }
  | { key: string; label: string; type: 'slider'; min: number; max: number; step: number; required?: boolean }
  | { key: string; label: string; type: 'text'; placeholder?: string; max?: number; required?: boolean };

export interface MenuDef {
  flow: string;
  title: string;
  note: string;
  questions: MenuQuestion[];
  answers: Record<string, unknown> | null;
  saved_at: string | null;
}

export interface SurveyItem {
  key: string;
  label: string;
  type: 'scale' | 'multi' | 'single' | 'textarea';
  options?: string[];
  min?: number;
  max?: number;
  required?: boolean;
}

export interface SurveyDef {
  kind: string;
  title: string;
  desc: string;
  items: SurveyItem[];
  scaleLabels: Record<string, string>;
  answers: Record<string, unknown> | null;
  submitted_at: string | null;
}

export interface PrepareStep { no: number; key: string; title: string; done: boolean; at: string | null }

export interface PrepareResp { steps: PrepareStep[]; done: boolean; persona: string | null }

export interface PathCard {
  id: string;
  name: string;
  fit: string;
  cost: string;
  milestones: string[];
  achievements: string[];
  ai_leverage: string;
  first_step: string;
}

export interface ProfileData {
  summary: string;
  motivation: string;
  strengths: string[];
  gaps: string[];
  weekly_hours: number;
  interests: string[];
  career_goal: string;
  risk_style: string;
  existing_achievements: string[];
  unknowns: string[];
  paths: PathCard[];
  compare_dims: string[];
  socratic_question: string;
}

export interface ProfileResp {
  has_menu: boolean;
  menu_answers: Record<string, unknown> | null;
  profile: ProfileData | null;
  paths: PathCard[] | null;
  compare_dims: string[];
  chosen_path: string | null;
  choice_reason: string | null;
  path_scores: Record<string, Record<string, number>> | null;
  updated_at: string | null;
}

export interface SchoolFact {
  item: string;
  value: string;
  source: string;
  url: string;
  level: '官方' | '院校' | '经验帖' | 'AI推断';
  verified?: boolean;
  verified_at?: string | null;
}

export interface SchoolRow {
  id: number;
  school: string;
  major: string;
  tier: '冲刺' | '稳妥' | '保底';
  facts: SchoolFact[];
  basis: string;
  uncertainty: string;
  created_at: string;
}

export interface SchoolsResp {
  schools: SchoolRow[];
  stats: { total: number; verified: number; facts: number; facts_verified: number; missing_basis: number };
}

export interface Candidate {
  school: string;
  major: string;
  tier: '冲刺' | '稳妥' | '保底';
  reason: string;
  facts: SchoolFact[];
}

export interface PlanTask { title: string; kind: string; minutes: number }
export interface PlanDay { date: string; tasks: PlanTask[] }
export interface PlanData {
  goal: string;
  phases: { name: string; range: string; focus: string; milestone: string }[];
  week: PlanDay[];
  achievements: { type: string; name: string; when: string; why: string; ai_help: string }[];
  buffer_rule: string;
  check_rule: string;
  weekly_hours?: number;
}

export interface TaskRow {
  id: number;
  date: string;
  title: string;
  kind: string;
  minutes: number;
  done: number;
}

export interface PlanResp {
  plan: PlanData | null;
  plan_id: number | null;
  versions: { id: number; active: number; reduce_flag: number; created_at: string }[];
  latest_is_active: boolean;
  tasks: TaskRow[];
  tasks_by_date: Record<string, TaskRow[]>;
  reduce_flag: boolean;
}

export interface CheckinTodayResp {
  date: string;
  weekday: string;
  tasks: TaskRow[];
  checkin: { id: number; minutes: number; accuracy: number | null; done_count: number; total_count: number; reflection: string; mood: number } | null;
  cap_minutes: number | null;
  streak: number;
  can_edit: boolean;
}

export interface CheckinsResp {
  checkins: { id: number; date: string; minutes: number; accuracy: number | null; done_count: number; total_count: number; reflection: string; mood: number }[];
  total: number;
  streak: number;
  rate7: number;
  today: string;
  today_checked: boolean;
}

export interface WeeklyReviewResp {
  reviews: { id: number; week_start: string; rate: number; blockers: string[]; adjust: string[]; summary: string; created_at: string }[];
  current: {
    week_start: string;
    dates: string[];
    rate: number;
    done: number;
    all: number;
    checkins: { date: string; done_count: number; total_count: number; reflection: string; minutes: number; mood: number }[];
    reviewed: boolean;
  };
}

export interface CoursewarePage {
  no: number;
  layout: 'cover' | 'points' | 'cards' | 'timeline' | 'two-col' | 'pyramid';
  title: string;
  body?: string[];
  cards?: { title: string; text: string }[];
  timeline?: { when: string; what: string; tag?: string }[];
  left?: { title: string; items: string[] };
  right?: { title: string; items: string[] };
  levels?: { name: string; detail: string; strength: number }[];
  task?: string;
  source?: string;
  hasNote?: boolean;
  note?: string;
}

export interface ChapterMeta { chapter: number; title: string; subtitle: string; pages: number; unlocked: boolean }

export interface ChapterTask {
  id: string;
  type: 'poll' | 'quiz' | 'form';
  title: string;
  prompt?: string;
  submitted: boolean;
  score: number | null;
  content: Record<string, unknown> | null;
  def: {
    id: string;
    type: 'poll' | 'quiz' | 'form';
    title: string;
    prompt?: string;
    options?: { key: string; label: string }[];
    optionSet?: string[];
    questions?: { no: number; text: string }[];
    fields?: TaskField[];
    extra?: TaskField;
    showDistribution?: boolean;
    multi?: boolean;
  };
}

export interface TaskField {
  key: string;
  label: string;
  type: 'select' | 'multi' | 'text' | 'textarea';
  options?: string[];
  required?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
}

// ---------- 阶段3：长期记忆与干预（M9、M8） ----------

export interface MemoryRow {
  id: number;
  content: string;
  category: string;
  created_at: string;
}

export interface MemoriesResp {
  memories: MemoryRow[];
  count: number;
  limit: number;
  note: string;
}

export interface InterventionOption {
  key: string;
  label: string;
  effect: 'reduce' | 'goto' | 'talk' | 'pause' | 'keep' | 'done';
  route?: string;
  requireNote?: boolean;
}

export interface Intervention {
  id: number;
  rule: string;
  title: string;
  message: string;
  options: InterventionOption[];
  chosen: string | null;
  note: string;
  created_at: string;
  resolved_at: string | null;
}

export interface InterventionsResp {
  pending: Intervention[];
  done: Intervention[];
  pending_count: number;
}

export interface TeacherMemoryStatRow {
  id: number;
  name: string;
  student_no: string;
  memory_count: number;
  memory_last_at: string | null;
  last_message_at: string | null;
  pending_interventions: number;
  portfolio_missing: number;
}

// ---------- 阶段4：导师团（M18） ----------

export interface GroupMode {
  key: string;
  name: string;
  tier: 'basic' | 'advanced';
  question: string;
  desc: string;
  defaults: string[];
  product: string;
  stage?: number;
  available: boolean;
}

export interface GroupMentor {
  key: string;
  name: string;
  duty: string;
  summary: string;
  tone: string;
  icon: string;
  muted: boolean;
  style_pref: string;
}

export interface GroupMessage {
  id: number;
  speaker_type: 'user' | 'mentor' | 'host' | 'twin';
  speaker_key: string | null;
  content: string;
  sources: { title?: string; url?: string; level?: string }[];
  options: { options: { key: string; label: string }[]; multi: boolean; free_text: boolean } | null;
  is_draft: boolean;
  created_at: string;
}

export interface GroupActionItem {
  id: number;
  title: string;
  kind: string;
  minutes: number;
  confirmed: boolean;
}

export interface GroupSession {
  id: number;
  mode: string;
  mode_name: string;
  mentors: string[];
  twin_joined: boolean;
  summary: { points: string[]; decision: string; draft?: boolean; rejected?: boolean } | null;
  action_items: GroupActionItem[] | null;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
  messages: GroupMessage[];
  mentor_speech_count?: number;
}

export interface SessionsResp { sessions: GroupSession[] }

export interface GroupSummaryResp {
  consensus: string;
  divergence: string;
  decide: string;
  degraded: boolean;
}

// ---------- 阶段5：书房（M11 学术进阶、M12 知识库、M10 成果铺垫） ----------

export interface PaperRow {
  id: number;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  doi: string;
  url: string;
  abstract: string;
  lang: string;
  source: string;
  verify_status: 'verified' | 'unverified' | 'failed';
  verify_info: { reason?: string; similarity?: number | null; resolved_to?: string } | null;
  read_status: string;
  topic_id: number | null;
  tags: string[];
  has_fulltext: boolean;
  created_at: string;
  in_library?: boolean;
  work_id?: string;
  cited_by?: number | null;
}

export interface PapersResp { papers: PaperRow[] }

export interface SearchResp {
  query: string;
  total: number;
  works: PaperRow[];
  zh_coverage_low: boolean;
  mock_hint: string;
}

export interface ReadingCard {
  id: number;
  paper_id: number | null;
  question: string;
  method: string;
  evidence: string;
  conclusion: string;
  limitation: string;
  my_judgment: string;
  doubts: string[];
  ai_note: string;
  created_at: string;
  updated_at?: string | null;
  paper?: { id: number; title: string; year: number | null; verify_status: string } | null;
}

export interface CardsResp { cards: ReadingCard[] }

export interface TopicRow {
  id: number;
  name: string;
  parent_id: number | null;
  description: string;
  paper_count: number;
}

export interface TopicsResp { topics: TopicRow[] }

export interface ClassifySuggestion {
  topics: { name: string; parent: string | null; desc: string; paper_ids: number[] }[];
  tags: { paper_id: number; tags: string[] }[];
  gaps: { desc: string; evidence_ids: number[] }[];
  papers_count: number;
}

export interface TopicIdea {
  id: number;
  question: string;
  significance: string;
  feasibility: string;
  method: string;
  risks: string;
  paper_ids: number[];
  status: 'candidate' | 'chosen' | 'dropped';
  drop_reason: string;
  created_at: string;
}

export interface IdeasResp { ideas: TopicIdea[] }

export interface KbItem {
  id: number;
  space: 'prep' | 'research';
  type: 'knowledge' | 'mistake' | 'note';
  title: string;
  content: Record<string, string | number>;
  tags: string[];
  mastery: number | null;
  created_at: string;
  updated_at?: string | null;
}

export interface KbItemsResp {
  items: KbItem[];
  stats: { total: number; prep: number; research: number; mistakes: number };
  mistake_causes: string[];
}

export interface ImportReport {
  format: string;
  imported: number;
  duplicated: number;
  failed: number;
  doi_filled?: number;
  report: { ok?: string[]; dup?: string[]; papers?: number; cards?: number; kb_items?: number; topics?: number; topic_ideas?: number };
}

export interface KbReport {
  generated_at: string;
  student: { name: string; student_no: string; major: string | null; grade: string | null };
  counts: {
    papers: number; papers_verified: number; papers_unverified: number; cards: number;
    topics: number; ideas: number; kb_items: number; mistakes: number; knowledge: number;
    notes: number; reading_minutes: number;
  };
  mistake_causes: { name: string; count: number }[];
  topics: { name: string; description: string; papers: string[] }[];
  picks: { kind: string; ref_id: number; title: string; note: string }[];
  note: string;
}

export interface Achievement {
  id: number;
  type: string;
  name: string;
  deadline: string;
  stage: string;
  notes: string;
  created_at: string;
  days_left: number | null;
  urgent: boolean;
  overdue: boolean;
}

export interface AchievementsResp {
  achievements: Achievement[];
  stats: { total: number; active: number; done: number; urgent: number };
  stages: string[];
}

export interface AchievementCatalogItem {
  type: string;
  name: string;
  timing: string;
  who: string;
  ai_help: string;
  caution: string;
  tier: 'reach' | 'steady' | 'foundation';
  recommended: boolean;
  matches_major: boolean;
  matches_path: boolean;
}

export interface AchievementCatalogResp {
  catalog: AchievementCatalogItem[];
  stages: string[];
  types: string[];
  tiers: Record<string, string>;
  chosen_path: string | null;
  note: string;
}

export interface PdfExtractResp {
  text: string;
  pages: number[];
  page_count: number;
  chars: number;
  hasText: boolean;
  note?: string;
  suggested_title?: string;
}

export interface ReadingLogResp {
  last7: { entries: number; minutes: number };
  total: number;
}

// ---------- 阶段6：数字分身（M19）、API实验室（M15） ----------

export interface TwinItem {
  id: string;
  text: string;
  source: string;
  confidence: '原话' | '数据' | '推测';
  confirmed: boolean;
  locked: boolean;
}

export type TwinProfile = Record<string, TwinItem[]> & { open_questions: string[] };

export interface TwinInfo {
  exists: boolean;
  consented: boolean;
  consent_at?: string | null;
  name?: string;
  icon?: string;
  sources?: Record<string, boolean>;
  profile?: TwinProfile;
  built?: boolean;
  version?: number;
  updated_at?: string | null;
}

export interface TwinUpload {
  id: number;
  filename: string;
  kind: string;
  confirmed: boolean;
  chars: number;
  redaction_log: { type: string; count: number }[];
  created_at?: string;
}

export interface TwinResp {
  twin: TwinInfo;
  sources: { key: string; label: string }[];
  sections: { key: string; label: string }[];
  icons: string[];
  purposes: Record<string, string>;
  upload_kinds: string[];
  uploads: TwinUpload[];
  corrections: { id: number; field: string; before_text: string | null; after_text: string | null; created_at: string }[];
  suggestion: { text: string; weekly: boolean } | null;
  note: string;
  used_sources?: string[];
}

export interface TwinTalk {
  id: number;
  purpose: string;
  transcript: { role: 'user' | 'twin'; content: string; at: string; draft?: boolean }[];
  created_at: string;
}

export interface LabAgent {
  id: number;
  name: string;
  system_prompt: string;
  model: string;
  temperature: number;
  max_tokens: number;
  created_at: string;
  updated_at: string | null;
}

export interface LabAnatomy {
  formula: string;
  parts: { name: string; text: string }[];
  system_prompt: string;
  tool_call_example: { note: string; request: unknown; response: unknown; then: string };
}

// ---------- 阶段7：复试模拟（M13）、结课考核（M14）、互评（M2） ----------

export interface InterviewTurn {
  type: 'q' | 'a';
  text: string;
  examiner?: string;
  stage?: string;
  at: string;
  twin_answer?: string;
  from_qbank?: boolean;
}

export interface InterviewExaminerReview {
  key: string;
  name: string;
  scores: Record<string, number | null>;
  reasons: Record<string, string>;
  best_moment: string;
  worst_question: string;
}

export interface InterviewReview {
  examiners: InterviewExaminerReview[];
  english: Record<string, number | string | null> | null;
  top3: string[];
  retry_questions: string[];
  qbank_added?: number;
  note: string;
}

export interface InterviewSession {
  id: number;
  config: { tier: 'basic' | 'full'; target: string; form: string; difficulty: string; duration: number; examiners: string[]; rehearsal: boolean };
  stages: string[];
  stage_index: number;
  transcript: InterviewTurn[];
  review: InterviewReview | null;
  self_review: string;
  twin_rehearsal: { question: string; twin: string; me: string }[] | null;
  status: 'running' | 'ended' | 'reviewed' | 'closed';
  remaining_sec: number;
  created_at: string;
  disclaimer: string;
  question_count?: number;
}

export interface InterviewStatus {
  disclaimer: string;
  basic: { used: number; limit: number; left: number };
  suggested_target: string;
  twin_ready: boolean;
  qbank_pending: number;
}

export interface QbankItem { id: number; question: string; source: string; examiner: string; my_notes: string; status: '待重练' | '已重练'; created_at: string }

export interface PortfolioItem {
  key: string;
  name: string;
  weight: number;
  group: string;
  source: string;
  levels: Record<string, string>;
  indicators: string;
  status: 'done' | 'partial' | 'missing';
  products: string[];
  metrics: Record<string, string | number | Record<string, number>>;
  missing: string[];
}

export interface PortfolioResp {
  items: PortfolioItem[];
  missing_count: number;
  summary: string[];
  grades: { item: string; score: number | null; comment: string; updated_at: string }[];
  note: string;
}

export interface AiStats {
  categories: { category: string; calls: number; tokens: number; platform: number; own: number; first_at: string; last_at: string }[];
  total_calls: number;
  total_tokens: number;
  blocked_requests: number;
  verification: { school_facts: number; school_facts_verified: number; papers: number; papers_verified: number; papers_failed: number; verify_actions: number };
  adoption: { confirm: number; modify: number; reject: number; modify_rate: number | null };
}

export interface ActionPlanView {
  draft: { title: string; compiled_at: string; sections: { key: string; title: string; content: string }[] } | null;
  reflections: Record<string, string>;
  sections: { key: string; title: string }[];
  reflection_min: number;
  ai_statement: { draft: string; stats: AiStats; note: string; note_min: number };
  submitted_at: string | null;
}

export interface PeerAssigned {
  criteria: { key: string; label: string }[];
  min: number;
  max: number;
  items: { id: number; anonymous_label: string; chapter: number; task_title: string; fields: { label: string; value: string }[]; done: boolean; rubric: Record<string, number> | null; comment: string }[];
}

export interface PeerReceived { items: { chapter: number; task_title: string; received: number; assigned: number; averages: Record<string, number | null>; comments: string[] }[] }

export interface SurveyCompare {
  items: { key: string; label: string; pre: number | null; mid: number | null; post: number | null }[];
  done: { pre: string | null; mid: string | null; post: string | null; satisfaction: string | null };
  note: string;
}

export interface TeacherGradeRow {
  id: number;
  student_no: string;
  name: string;
  status: Record<string, 'done' | 'partial' | 'missing'>;
  missing_count: number;
  submitted_at: string | null;
  grades: Record<string, { score: number | null; comment: string; updated_at: string }>;
  total: number | null;
}
