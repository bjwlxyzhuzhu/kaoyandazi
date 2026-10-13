// 清理演练账号及其全部数据（只删学号以指定前缀开头的学生，不动正式班级与教师账号）
// 用法：node server/scripts/cleanup-e2e.mjs [前缀…]   默认前缀：e2e grp res twn lab
const { db } = await import('../src/db.js');
const { purgeUsers } = await import('../src/userdata.js');

const prefixes = process.argv.slice(2);
const use = prefixes.length ? prefixes : ['e2e', 'grp', 'res', 'twn', 'lab'];
const where = use.map(() => 'student_no LIKE ?').join(' OR ');
const users = db.prepare(`SELECT id, student_no FROM users WHERE role = 'student' AND (${where})`).all(...use.map((p) => `${p}%`));
if (!users.length) {
  console.log('没有匹配的演练账号。');
} else {
  console.log(`将删除 ${users.length} 个演练账号：${users.map((u) => u.student_no).join('、')}`);
  const counts = purgeUsers(users.map((u) => u.id));
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
}
const left = db.prepare('SELECT student_no, role FROM users ORDER BY id').all();
console.log('数据库里剩下的账号：', left.map((u) => `${u.student_no}(${u.role})`).join('、') || '（无）');
