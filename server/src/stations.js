// 11站主线（PRD 4.3、7.6）：站点定义与流程状态
import fs from 'node:fs';
import path from 'node:path';
import { SHARED_DIR } from './config.js';
import { db } from './db.js';
import { nowLocal } from './time.js';
import { getAgent, displayName, resolvePersona } from './registry.js';

const data = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'stations.json'), 'utf8'));

export const stations = data.stations;
export const FIRST_STATION = 1;
export const LAST_STATION = 11;

export function getStation(no) {
  return stations.find((s) => s.no === Number(no)) || null;
}

/** 本阶段实现的站（其余站在界面上隐藏入口，不展示半成品） */
export function isStationOpen(no, currentStage) {
  const s = getStation(no);
  return !!s && s.stage <= currentStage;
}

/** 统一取流程状态；未设置过的站返回 not_started */
export function allFlowStatus(userId) {
  const rows = db.prepare('SELECT station, status, updated_at FROM flow_status WHERE user_id = ?').all(userId);
  const map = new Map(rows.map((r) => [r.station, r]));
  return stations.map((s) => ({
    station: s.no,
    key: s.key,
    name: s.name,
    status: map.get(s.no)?.status || 'not_started',
    updated_at: map.get(s.no)?.updated_at || null,
  }));
}

export function flowStatusOf(userId, no) {
  const row = db.prepare('SELECT status FROM flow_status WHERE user_id = ? AND station = ?').get(userId, Number(no));
  return row?.status || 'not_started';
}

export function setFlowStatus(userId, no, status) {
  db.prepare(`INSERT INTO flow_status(user_id, station, status, updated_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(user_id, station) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
    .run(userId, Number(no), status, nowLocal());
}

/**
 * 当前站：第一个未完成的站；全部完成则为最后一站。
 * 允许提前查看后面的站，但查看不等于解锁或完成。
 */
export function currentStation(userId) {
  const list = allFlowStatus(userId);
  const pending = list.find((s) => s.status !== 'done');
  return pending ? pending.station : LAST_STATION;
}

/** 该站的主讲导师：第6站用学生自己选的陪伴导师 */
export function stationMentors(user, no) {
  const s = getStation(no);
  if (!s) return { primary: null, co: null };
  const primaryKey = s.mentorPrimary || resolvePersona(user.persona);
  const primary = getAgent(primaryKey);
  const co = getAgent(s.mentorCo);
  return { primary, co, primaryLabel: displayName(primary), coLabel: displayName(co) };
}
