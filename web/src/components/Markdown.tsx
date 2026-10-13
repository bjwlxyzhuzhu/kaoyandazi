// Markdown 渲染：marked 转 HTML，DOMPurify 过滤 XSS（PRD 第12章“安全”）
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'img'],
  }), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 流式输出过程中隐藏末尾的选项 JSON 代码块，避免把 JSON 展示给学生 */
export function visibleStreamText(text: string): string {
  const fence = text.search(/```\s*json/i);
  let out = fence >= 0 ? text.slice(0, fence) : text;
  const bare = out.search(/\{\s*"options"\s*:/);
  if (bare >= 0) out = out.slice(0, bare);
  // 正在输出的代码块开头（例如只到了 ``` 或 ``）也先不显示
  return out.replace(/`{1,3}\s*j?s?o?n?\s*$/i, '');
}
