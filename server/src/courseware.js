// 第1章课件与课堂任务（PRD 附录A、M2）
// 课件与课堂任务放在 server 侧：测验答案不随页面下发。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, SHARED_DIR } from './config.js';

const coursewareDir = path.join(SHARED_DIR, 'courseware');
const taskDir = path.join(ROOT_DIR, 'server', 'data');

export function chapterMeta() {
  const files = fs.readdirSync(coursewareDir).filter((f) => /^chapter\d+\.json$/.test(f));
  return files
    .map((f) => {
      const c = JSON.parse(fs.readFileSync(path.join(coursewareDir, f), 'utf8'));
      return { chapter: c.chapter, title: c.title, subtitle: c.subtitle || '', pages: c.pages?.length || 0 };
    })
    .sort((a, b) => a.chapter - b.chapter);
}

export function getCourseware(no) {
  const file = path.join(coursewareDir, `chapter${Number(no)}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 学生端课件：去掉教师备注 */
export function studentCourseware(no) {
  const c = getCourseware(no);
  if (!c) return null;
  return {
    chapter: c.chapter, title: c.title, subtitle: c.subtitle,
    pages: c.pages.map(({ note, ...rest }) => ({ ...rest, hasNote: !!note })),
  };
}

function taskFile(no) {
  return path.join(taskDir, `chapter${Number(no)}-tasks.json`);
}

export function getTaskDefs(no) {
  const f = taskFile(no);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** 学生端任务定义：测验去掉答案与解析 */
export function studentTaskDef(no, id) {
  const def = getTaskDefs(no);
  const t = def?.tasks?.find((x) => x.id === id);
  if (!t) return null;
  if (t.type === 'quiz') {
    const { questions, ...rest } = t;
    return { ...rest, questions: questions.map(({ answer, why, ...q }) => q) };
  }
  return t;
}

/** 服务端评分：返回 { correct, total, detail } */
export function gradeQuiz(no, id, answers) {
  const def = getTaskDefs(no);
  const t = def?.tasks?.find((x) => x.id === id);
  if (!t || t.type !== 'quiz') return null;
  let correct = 0;
  const detail = t.questions.map((q) => {
    const got = answers?.[String(q.no)] ?? answers?.[q.no] ?? '';
    const ok = String(got).trim() === q.answer;
    if (ok) correct += 1;
    return { no: q.no, correctAnswer: q.answer, got: String(got), ok, why: q.why };
  });
  return { correct, total: t.questions.length, detail };
}
