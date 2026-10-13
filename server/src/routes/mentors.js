// M18 GET /mentors：导师注册表与当前发布版本（含学生端可见的“学习”说明，PRD M20）
import { Router } from 'express';
import { requireLogin } from '../auth.js';
import { agents, publicAgent, DEFAULT_COMPANION } from '../registry.js';
import { mentorPublicInfo } from '../workshop.js';
import { ASK_AGENTS } from './conv.js';

const r = Router();

r.get('/mentors', requireLogin, (_req, res) => {
  res.json({
    default_companion: DEFAULT_COMPANION,
    ask_agents: ASK_AGENTS,
    training_note: '本平台的导师通过资料、记忆和反馈不断改进，不对大模型本身进行再训练；所有改进都由教师审核、有版本记录、可以回滚。',
    agents: agents.map((a) => {
      const info = a.worker ? null : mentorPublicInfo(a.key);
      return { ...publicAgent(a), version: info?.version || null, learning: info };
    }),
  });
});

export default r;
