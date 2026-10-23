/**
 * incentive_files.js — 올린 공지 파일을 AI가 읽을 수 있는 형태로 바꿉니다.
 *   PDF·이미지 → AI에 그대로 첨부(표·이미지 포함)
 *   Excel·Word·PowerPoint·한글(hwpx) → 글자로 추출해서 전달
 *   예전 한글(.hwp) 등 → 지원하지 않음(PDF로 저장 안내)
 */
const JSZip = require('jszip');
const XLSX = require('xlsx');

const MAX_TEXT = 350000;

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function wordXmlToText(xml) {
  return decodeXml(xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>\s*<\/w:tc>/g, ' | ').replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}
function slideXmlToText(xml) {
  return decodeXml(xml
    .replace(/<\/a:p>\s*<\/a:txBody>\s*<a:tcPr[^>]*\/>\s*<\/a:tc>/g, ' | ').replace(/<\/a:tc>/g, ' | ')
    .replace(/<\/a:tr>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<a:br\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}
function hwpxXmlToText(xml) {
  return decodeXml(xml
    .replace(/<\/hp:p>\s*<\/hp:subList>\s*(?:<hp:cellAddr[^>]*\/>\s*)?(?:<hp:cellSpan[^>]*\/>\s*)?(?:<hp:cellSz[^>]*\/>\s*)?(?:<hp:cellMargin[^>]*\/>\s*)?<\/hp:tc>/g, ' | ').replace(/<\/hp:tc>/g, ' | ')
    .replace(/<\/hp:tr>/g, '\n')
    .replace(/<\/hp:p>/g, '\n')
    .replace(/<hp:lineBreak\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}
const num = f => Number((f.match(/(\d+)\.xml$/) || [0, 0])[1]);

// 슬라이드의 글상자들을 "위치 순서"로 읽습니다. (표가 아니라 떠 있는 글상자로 만든 공지에서
// '20년납 미만' 같은 조건 글상자가 어느 상품·% 와 한 줄인지 알 수 있게, 같은 높이의 글상자를 한 줄로 묶습니다.)
function slidePositionalText(xml) {
  const items = [];
  const re = /<p:(sp|graphicFrame|pic)\b[\s\S]*?<\/p:\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const blk = m[0];
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(blk);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(blk);
    const text = slideXmlToText(blk).replace(/\{[0-9A-Fa-f-]{36}\}/g, '').replace(/[ \t]+/g, ' ').split('\n').map(x => x.trim()).filter(Boolean).join(' / ');
    if (!text || !off) continue;
    const x = +off[1], y = +off[2], cy = ext ? +ext[2] : 0, cx = ext ? +ext[1] : 0;
    items.push({ x, yc: y + cy / 2, cx, text });
  }
  if (!items.length) return '';
  items.sort((a, b) => a.yc - b.yc || a.x - b.x);
  const TOL = 230000; // 약 0.25인치
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.yc - last.yc) <= TOL) { last.parts.push(it); last.yc = (last.yc * (last.parts.length - 1) + it.yc) / last.parts.length; }
    else lines.push({ yc: it.yc, parts: [it] });
  }
  return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.text).join('   ⟷   ')).join('\n');
}

async function toInput(buffer, filename, mimetype) {
  const name = String(filename || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [, ''])[1];
  const warnings = [];

  if (ext === 'pdf' || mimetype === 'application/pdf') {
    return { kind: 'pdf', filePart: { type: 'input_file', filename: filename || 'notice.pdf', file_data: 'data:application/pdf;base64,' + buffer.toString('base64') }, warnings };
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    return { kind: 'image', imagePart: { type: 'input_image', image_url: `data:${mime};base64,${buffer.toString('base64')}` }, warnings };
  }
  if (['xlsx', 'xlsm', 'xls', 'csv'].includes(ext)) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    let text = '';
    for (const sn of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sn], { blankrows: false });
      if (csv.trim()) text += `\n=== 시트: ${sn} ===\n${csv}\n`;
    }
    return { kind: 'text', text: text.slice(0, MAX_TEXT), warnings };
  }
  if (ext === 'docx') {
    const zip = await JSZip.loadAsync(buffer);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('Word 파일 내용을 읽지 못했습니다.');
    const text = wordXmlToText(await f.async('string'));
    if (zip.file(/word\/media\//).length && text.replace(/\s/g, '').length < 300) {
      throw new Error('글자가 거의 없고 이미지로 된 Word 파일입니다. PDF로 저장해서 올려 주세요.');
    }
    if (zip.file(/word\/media\//).length) warnings.push('Word 파일 안의 그림(이미지)은 읽지 못했습니다. 그림에 시책 내용이 있다면 PDF로 저장해서 다시 올려 주세요.');
    return { kind: 'text', text: text.slice(0, MAX_TEXT), warnings };
  }
  if (ext === 'pptx') {
    const zip = await JSZip.loadAsync(buffer);
    const slides = zip.file(/^ppt\/slides\/slide\d+\.xml$/).sort((a, b) => num(a.name) - num(b.name));
    let text = '', emptyWithPic = 0;
    for (const s of slides) {
      const xml = await s.async('string');
      const t = (slidePositionalText(xml) || slideXmlToText(xml)).trim();
      if (!t && /<p:pic>/.test(xml)) emptyWithPic++;
      text += `\n=== 슬라이드 ${num(s.name)} (글상자를 위→아래, 같은 줄은 왼쪽→오른쪽 순서로 나열; ⟷ 는 같은 줄의 다른 글상자) ===\n${t}\n`;
    }
    const plain = text.replace(/=== 슬라이드 \d+ ===/g, '').replace(/\s/g, '');
    if (plain.length < 200 && zip.file(/ppt\/media\//).length) throw new Error('이미지로 된 PowerPoint 파일입니다. PDF로 저장해서 올려 주세요.');
    if (emptyWithPic) warnings.push(`PowerPoint ${emptyWithPic}개 슬라이드는 이미지라 읽지 못했습니다. PDF로 저장해서 올리면 모두 읽을 수 있습니다.`);
    warnings.push('PowerPoint는 글상자 위치 정보가 일부 사라져 "20년납 미만" 같은 조건이 엉뚱한 상품·%에 붙을 수 있습니다. PDF로 저장해서 올리면 가장 정확합니다.');
    return { kind: 'text', text: text.slice(0, MAX_TEXT), warnings };
  }
  if (ext === 'hwpx') {
    const zip = await JSZip.loadAsync(buffer);
    const secs = zip.file(/^Contents\/section\d+\.xml$/).sort((a, b) => num(a.name) - num(b.name));
    if (!secs.length) throw new Error('한글(hwpx) 파일 내용을 읽지 못했습니다.');
    let text = '';
    for (const s of secs) text += hwpxXmlToText(await s.async('string')) + '\n';
    if (zip.file(/^BinData\//).length && text.replace(/\s/g, '').length < 300) throw new Error('글자가 거의 없고 이미지로 된 한글 파일입니다. PDF로 저장해서 올려 주세요.');
    return { kind: 'text', text: text.slice(0, MAX_TEXT), warnings };
  }
  if (ext === 'hwp' || ext === 'doc' || ext === 'ppt') {
    throw new Error(`예전 형식(.${ext}) 파일은 읽을 수 없습니다. 한글/Word/PowerPoint에서 "PDF로 저장"하거나 최신 형식(.hwpx/.docx/.pptx)으로 저장해서 올려 주세요.`);
  }
  throw new Error('지원하지 않는 파일 형식입니다. (PDF, Excel, Word, PowerPoint, 한글(hwpx), 이미지)');
}

module.exports = { toInput };
