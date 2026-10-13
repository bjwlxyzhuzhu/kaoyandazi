// 最小 .docx 生成器：用已有的 ZIP 写入器拼出 Word 能打开的文档（标题、段落、加粗），不引新依赖
import { makeZip } from './research/zip.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function run(text, { bold = false, size = 21, color = '' } = {}) {
  const props = `<w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="SimSun" w:hAnsi="SimSun"/>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  return `<w:r>${props}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/**
 * blocks: [{ type: 'title'|'h1'|'h2'|'p'|'note', text, bold? }]
 * 段落里的换行拆成多段。
 */
export function makeDocx(blocks) {
  const paras = [];
  for (const b of blocks) {
    const style = { title: { size: 36, bold: true, align: 'center' }, h1: { size: 28, bold: true }, h2: { size: 24, bold: true }, note: { size: 18, color: '59665F' }, p: { size: 21 } }[b.type] || { size: 21 };
    for (const line of String(b.text ?? '').split('\n')) {
      const ppr = `<w:pPr>${style.align ? `<w:jc w:val="${style.align}"/>` : ''}<w:spacing w:after="${b.type === 'p' ? 80 : 160}" w:line="360" w:lineRule="auto"/></w:pPr>`;
      paras.push(`<w:p>${ppr}${run(line, { bold: style.bold || b.bold, size: style.size, color: style.color })}</w:p>`);
    }
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: doc },
  ]);
}
