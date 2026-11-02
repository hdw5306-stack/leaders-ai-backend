/**
 * incentive_files.js — 올린 공지 파일을 AI가 읽을 수 있는 형태로 바꿉니다.
 *   PDF·이미지 → AI에 그대로 첨부(표·이미지 포함)
 *   Excel·Word·PowerPoint·한글(hwpx) → 글자로 추출해서 전달
 *   예전 한글(.hwp) 등 → 지원하지 않음(PDF로 저장 안내)
 */
const JSZip = require('jszip');
const XLSX = require('xlsx');

const MAX_TEXT = 350000;
const MAX_PDF_PAGES = 14;

// PDF → 쪽별 고해상도 PNG (가로 약 1700px, 세로가 길면 겹치게 나눔) + 글자 층 텍스트
async function loadPdfjs() {
  try { const nc = require('@napi-rs/canvas'); ['DOMMatrix', 'ImageData', 'Path2D'].forEach(k => { if (!globalThis[k] && nc[k]) globalThis[k] = nc[k]; }); } catch (e) { /* 아래에서 처리 */ }
  // 서버에 설치된 pdfjs-dist 가 4.x(.mjs)이든 3.x(.js)이든 모두 사용
  try { return await import('pdfjs-dist/legacy/build/pdf.mjs'); } catch (e1) {
    try { const m = require('pdfjs-dist/legacy/build/pdf.js'); return m.getDocument ? m : (m.default || m); } catch (e2) { throw new Error('pdfjs-dist 를 불러오지 못했습니다: ' + String(e2.message || e2).slice(0, 80)); }
  }
}
async function rasterizePdf(buffer) {
  const pdfjs = await loadPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');
  class NapiCanvasFactory {
    create(w, h) { const canvas = createCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h))); return { canvas, context: canvas.getContext('2d') }; }
    reset(cc, w, h) { cc.canvas.width = Math.max(1, Math.ceil(w)); cc.canvas.height = Math.max(1, Math.ceil(h)); }
    destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0, canvasFactory: new NapiCanvasFactory(), CanvasFactory: NapiCanvasFactory }).promise;
  const images = []; let text = '';
  const n = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    try {
      const tc = await page.getTextContent();
      const line = tc.items.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
      if (line) text += `\n=== ${i}쪽 글자 층 ===\n${line}\n`;
    } catch (e) { /* 글자 층 없음 */ }
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(1.5, 1700 / v1.width));
    const vp = page.getViewport({ scale });
    const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
    const cv = createCanvas(w, h), ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: cv }).promise;
    const CH = 1500, OV = 120;
    const slices = h <= CH * 1.25 ? [[0, h]] : [];
    if (!slices.length) for (let y = 0; y < h; y += CH - OV) { slices.push([y, Math.min(h, y + CH)]); if (y + CH >= h) break; }
    slices.forEach(([y0, y1], k) => {
      const sh = y1 - y0, c2 = createCanvas(w, sh);
      c2.getContext('2d').drawImage(cv, 0, y0, w, sh, 0, 0, w, sh);
      images.push({ type: 'input_image', image_url: 'data:image/png;base64,' + c2.toBuffer('image/png').toString('base64'), detail: 'high' });
      images.push({ type: 'input_text', text: `(위 그림: ${i}쪽 ${slices.length > 1 ? `${k + 1}/${slices.length}번째 조각 — 조각 경계에서 표가 이어질 수 있음` : '전체'})` });
    });
    page.cleanup();
  }
  const pages = doc.numPages; await doc.destroy();
  return { images, text: text.trim(), pages };
}

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

async function toInput(buffer, filename, mimetype) {
  const name = String(filename || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [, ''])[1];
  const warnings = [];

  if (ext === 'pdf' || mimetype === 'application/pdf') {
    const filePart = { type: 'input_file', filename: filename || 'notice.pdf', file_data: 'data:application/pdf;base64,' + buffer.toString('base64') };
    // PDF 를 쪽마다 큰 그림으로 직접 그려서(고해상도, 길면 위·아래로 나눠서) 함께 보여 줍니다. 글자 층이 있으면 그 글자도 함께 줍니다.
    // 실패하면 예전처럼 PDF 파일만 첨부합니다(더 나빠지지 않음).
    let why = '';
    try {
      const r = await rasterizePdf(buffer);
      if (r && r.images.length) {
        if (r.pages > MAX_PDF_PAGES) warnings.push(`PDF가 ${r.pages}쪽이라 앞 ${MAX_PDF_PAGES}쪽만 그림으로 읽었습니다. 나머지는 파일 본문으로만 읽으니 나누어 올리면 더 정확합니다.`);
        return { kind: 'pdf', filePart: r.pages > MAX_PDF_PAGES ? filePart : null, imageParts: r.images, text: r.text, warnings };
      }
    } catch (e) { console.error('[시책읽기] PDF 그림 변환 실패 → 파일 그대로 첨부:', e.message); why = String(e.message || e).replace(/\s+/g, ' ').slice(0, 140); }
    warnings.push('PDF를 그림으로 바꾸지 못해 파일 그대로 읽었습니다(정확도가 낮을 수 있습니다).' + (why ? ' 원인: ' + why : ''));
    return { kind: 'pdf', filePart, warnings };
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
      const t = slideXmlToText(xml).trim();
      if (!t && /<p:pic>/.test(xml)) emptyWithPic++;
      text += `\n=== 슬라이드 ${num(s.name)} ===\n${t}\n`;
    }
    const plain = text.replace(/=== 슬라이드 \d+ ===/g, '').replace(/\s/g, '');
    if (plain.length < 200 && zip.file(/ppt\/media\//).length) throw new Error('이미지로 된 PowerPoint 파일입니다. PDF로 저장해서 올려 주세요.');
    if (emptyWithPic) warnings.push(`PowerPoint ${emptyWithPic}개 슬라이드는 이미지라 읽지 못했습니다. PDF로 저장해서 올리면 모두 읽을 수 있습니다.`);
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
