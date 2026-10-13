// 导师符号与“名字｜职责”标识，始终和“AI导师”标识一起出现
import type { AgentInfo } from '../api/types';
import { displayName } from '../registry';
import { MentorGlyph } from './icons';

export function MentorIcon({ agent, size = 36 }: { agent: AgentInfo | null; size?: number }) {
  return (
    <span className="mentor-icon" style={{ width: size, height: size }} aria-hidden="true">
      <MentorGlyph icon={agent?.icon || ''} />
    </span>
  );
}

export function MentorLabel({ agent }: { agent: AgentInfo | null }) {
  return (
    <span className="mentor-chip">
      <MentorIcon agent={agent} />
      <span>
        <span className="mentor-name">{displayName(agent)}</span>{' '}
        <span className="ai-tag">AI导师</span>
      </span>
    </span>
  );
}
