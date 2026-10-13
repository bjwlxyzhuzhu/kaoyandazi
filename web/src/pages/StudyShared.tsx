// 书房公共小组件：核验状态徽章、空状态、文件读取
import type { PaperRow } from '../api/types2';

/** 文献核验状态徽章（PRD M11：✅ 已核验 / ⚠️ 待核验 / ❌ 核验失败） */
export function VerifyBadge({ status, info }: { status: PaperRow['verify_status']; info?: PaperRow['verify_info'] }) {
  const map = {
    verified: { cls: 'badge badge-ok', text: '✅ 已核验' },
    failed: { cls: 'badge badge-pause', text: '❌ 核验失败' },
    unverified: { cls: 'badge badge-muted', text: '⚠️ 待核验' },
  } as const;
  const m = map[status] || map.unverified;
  return (
    <span className={m.cls} title={info?.reason || '点“核验”去核对这篇文献是不是真的'}>
      {m.text}
    </span>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="muted" style={{ padding: 'var(--s-4) 0' }}>{children}</p>;
}

/** 把文件读成 base64（去掉 data: 前缀，后端自己会处理） */
export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:.*?;base64,/, ''));
    fr.onerror = () => reject(new Error('文件读取失败。'));
    fr.readAsDataURL(file);
  });
}

/** 把文件读成文本（知网导出的 GBK 交给后端自动识别，这里按二进制转 base64 传过去） */
export function downloadUrl(path: string) {
  window.location.href = `/api${path}`;
}
