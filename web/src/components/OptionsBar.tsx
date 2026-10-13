// 选项按钮（PRD 4.2）：单选点一下即发送；多选勾好后点“发送所选”
import { useState } from 'react';
import type { OptionItem, OptionsBlock } from '../api/types';

export function choiceText(opts: OptionItem[]): string {
  return opts.map((o) => `【选择】${o.key}：${o.label}`).join('\n');
}

interface Props {
  block: OptionsBlock;
  disabled?: boolean;
  onChoose: (text: string) => void;
}

export function OptionsBar({ block, disabled, onChoose }: Props) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sentKey, setSentKey] = useState<string | null>(null);

  if (!block.multi) {
    return (
      <div className="options" role="group" aria-label="可选回答">
        {block.options.map((o) => (
          <button
            key={o.key}
            type="button"
            className="option"
            disabled={disabled}
            aria-pressed={sentKey === o.key}
            onClick={() => { setSentKey(o.key); onChoose(choiceText([o])); }}
          >
            <span className="k">{o.key}</span>
            <span>{o.label}{o.hint && <span className="hint">{o.hint}</span>}</span>
          </button>
        ))}
      </div>
    );
  }

  const toggle = (k: string) => setPicked((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]));
  return (
    <div className="options" role="group" aria-label="可多选的回答">
      {block.options.map((o) => (
        <button key={o.key} type="button" className="option" disabled={disabled} aria-pressed={picked.includes(o.key)} onClick={() => toggle(o.key)}>
          <span className="k">{picked.includes(o.key) ? '✓' : o.key}</span>
          <span>{o.label}{o.hint && <span className="hint">{o.hint}</span>}</span>
        </button>
      ))}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || !picked.length}
          onClick={() => onChoose(choiceText(block.options.filter((o) => picked.includes(o.key))))}
        >
          发送所选（{picked.length}）
        </button>
      </div>
    </div>
  );
}
