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

// PDF → 쪽별 고해상도 PNG (가로 약 1900px, 가로로 긴 띠로 겹치게 나눔) + 글자 층 텍스트
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
  const images = []; let text = ''; const pageInfo = [];
  const n = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const pi = { i, from: images.length, to: images.length, text: '', thumb: null }; pageInfo.push(pi);
    const textBefore = text.length;
    try {
      const tc = await page.getTextContent();
      const line = tc.items.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
      if (line) text += `\n=== ${i}쪽 글자 층 ===\n${line}\n`;
    } catch (e) { /* 글자 층 없음 */ }
    const v1 = page.getViewport({ scale: 1 });
    // 작은 글씨(각주·상품명)까지 읽도록 가로 약 1900px 로 그리고, 가로로 긴 띠로 잘라 보냅니다.
    // (그림 한 장이 세로로 길면 AI 쪽에서 가로 768px 정도로 줄어들어 작은 글씨가 뭉개집니다)
    const scale = Math.min(4, Math.max(1.5, 1900 / v1.width));
    const vp = page.getViewport({ scale });
    const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
    const cv = createCanvas(w, h), ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: cv }).promise;
    const BH = n > 8 ? 1300 : n > 4 ? 900 : 640, OV = 110;
    const slices = h <= BH * 1.2 ? [[0, h]] : [];
    if (!slices.length) for (let y = 0; y < h; y += BH - OV) { slices.push([y, Math.min(h, y + BH)]); if (y + BH >= h) break; }
    if (slices.length > 1) {
      // 전체 모양(표 배치)을 보도록 줄인 전체 그림을 먼저 한 장
      const ow = 900, oh = Math.round(h * ow / w), co = createCanvas(ow, oh);
      co.getContext('2d').drawImage(cv, 0, 0, w, h, 0, 0, ow, oh);
      images.push({ type: 'input_image', image_url: 'data:image/png;base64,' + co.toBuffer('image/png').toString('base64'), detail: 'high' });
      images.push({ type: 'input_text', text: `(위 그림: ${i}쪽 전체를 줄여 놓은 것 — 표의 배치를 보는 용도입니다. 글자와 숫자는 아래 확대 조각에서 읽으세요)` });
    }
    slices.forEach(([y0, y1], k) => {
      const sh = y1 - y0, c2 = createCanvas(w, sh);
      c2.getContext('2d').drawImage(cv, 0, y0, w, sh, 0, 0, w, sh);
      images.push({ type: 'input_image', image_url: 'data:image/png;base64,' + c2.toBuffer('image/png').toString('base64'), detail: 'high' });
      images.push({ type: 'input_text', text: `(위 그림: ${i}쪽 ${slices.length > 1 ? `확대 ${k + 1}/${slices.length}번째 띠 — 띠 경계에서 표가 이어질 수 있고 위아래 일부가 겹칩니다` : '전체'})` });
    });
    pi.to = images.length; pi.text = text.slice(textBefore);
    try { const tw = 560, th = Math.max(1, Math.round(h * tw / w)), ct = createCanvas(tw, th); ct.getContext('2d').drawImage(cv, 0, 0, w, h, 0, 0, tw, th); pi.thumb = 'data:image/png;base64,' + ct.toBuffer('image/png').toString('base64'); } catch (e) { /* 쪽 분류 없이 진행 */ }
    page.cleanup();
  }
  const pages = doc.numPages; await doc.destroy();
  return { images, text: text.trim(), pages, pageInfo };
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
// ── PowerPoint: 도형(글상자·표·묶음)의 위치를 반영해 읽기 ──
// 슬라이드 XML 의 도형 순서는 화면 위치와 무관합니다. 그냥 이어 붙이면 "7년~12년납" 같은 납입기간 라벨이 엉뚱한 표 행에 붙어 읽힙니다.
// 그래서 모든 도형의 위치(EMU)를 계산해서, 표 위에 겹쳐 놓인 라벨은 그 표의 해당 행에 넣고 나머지는 위→아래, 왼→오른 순서로 정렬합니다.
function xmlTree(xml) {
  const root = { tag: '#root', attrs: '', kids: [], text: '' }; const st = [root];
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g; let m;
  while ((m = re.exec(xml))) {
    if (m[5] != null) { st[st.length - 1].text += m[5]; continue; }
    if (m[1]) { if (st.length > 1) st.pop(); continue; }
    const n = { tag: m[2], attrs: m[3] || '', kids: [], text: '' };
    st[st.length - 1].kids.push(n); if (!m[4]) st.push(n);
  }
  return root;
}
const kid = (n, tag) => n.kids.find(k => k.tag === tag);
const attr = (n, a) => { const x = n && new RegExp('\\b' + a + '="(-?\\d+)"').exec(n.attrs); return x ? Number(x[1]) : null; };
function nodeText(n) {   // 문단 단위 글자
  const out = [];
  (function walk(x) {
    if (x.tag === 'a:p') { let t = ''; (function w2(y) { if (y.tag === 'a:t') t += decodeXml(y.text); else if (y.tag === 'a:br') t += ' '; else y.kids.forEach(w2); })(x); if (t.trim()) out.push(t.trim()); return; }
    x.kids.forEach(walk);
  })(n);
  return out.join(' ');
}
function slideShapes(xml) {
  const tree = xmlTree(xml); const items = [];
  const spTree = (function find(n) { if (n.tag === 'p:spTree') return n; for (const k of n.kids) { const r = find(k); if (r) return r; } return null; })(tree);
  if (!spTree) return null;
  // 묶음(grpSp)의 좌표 변환
  const walk = (node, tf) => {
    node.kids.forEach(ch => {
      if (ch.tag === 'p:grpSp') {
        const x = kid(kid(ch, 'p:grpSpPr') || { kids: [] }, 'a:xfrm');
        if (!x) return walk(ch, tf);
        const off = kid(x, 'a:off'), ext = kid(x, 'a:ext'), cho = kid(x, 'a:chOff'), che = kid(x, 'a:chExt');
        const ox = attr(off, 'x') || 0, oy = attr(off, 'y') || 0, ex = attr(ext, 'cx') || 1, ey = attr(ext, 'cy') || 1;
        const cx = attr(cho, 'x') || 0, cy = attr(cho, 'y') || 0, cex = attr(che, 'cx') || ex, cey = attr(che, 'cy') || ey;
        const sx = ex / cex, sy = ey / cey;
        const t2 = { map: (x0, y0) => tf.map(ox + (x0 - cx) * sx, oy + (y0 - cy) * sy), sx: tf.sx * sx, sy: tf.sy * sy };
        return walk(ch, t2);
      }
      if (ch.tag === 'p:sp' || ch.tag === 'p:graphicFrame') {
        const x = ch.tag === 'p:sp' ? kid(kid(ch, 'p:spPr') || { kids: [] }, 'a:xfrm') : kid(ch, 'p:xfrm');
        const off = x && kid(x, 'a:off'), ext = x && kid(x, 'a:ext');
        const px = attr(off, 'x'), py = attr(off, 'y'); if (px == null || py == null) { items.push({ x: null, y: null, ch }); return; }
        const [ax, ay] = tf.map(px, py);
        items.push({ x: ax, y: ay, w: (attr(ext, 'cx') || 0) * tf.sx, h: (attr(ext, 'cy') || 0) * tf.sy, ch, sy: tf.sy });
      }
    });
  };
  walk(spTree, { map: (a, b) => [a, b], sx: 1, sy: 1 });
  return items;
}
function slideXmlToTextPositioned(xml) {
  const items = slideShapes(xml); if (!items || !items.length) return null;
  const tables = [], boxes = [];
  items.forEach(it => {
    if (it.ch.tag === 'p:graphicFrame') {
      const tbl = (function f(n) { if (n.tag === 'a:tbl') return n; for (const k of n.kids) { const r = f(k); if (r) return r; } return null; })(it.ch);
      if (!tbl) return;
      let y = it.y; const rows = [];
      tbl.kids.filter(k => k.tag === 'a:tr').forEach(tr => {
        const h = (attr(tr, 'h') || 0) * (it.sy || 1);
        const cells = tr.kids.filter(k => k.tag === 'a:tc').map(tc => nodeText(tc));
        rows.push({ y0: y, y1: y + h, cells, labels: [] }); y += h;
      });
      tables.push({ x0: it.x, x1: it.x + it.w, y0: it.y, y1: y, rows });
    } else {
      const t = nodeText(it.ch); if (t) boxes.push({ x: it.x, y: it.y, w: it.w, h: it.h, t });
    }
  });
  const rest = [];
  boxes.forEach(b => {
    if (b.x == null) { rest.push(b); return; }
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const tb = tables.find(t => cx >= t.x0 && cx <= t.x1 && cy >= t.y0 && cy <= t.y1);
    const row = tb && tb.rows.find(r => cy >= r.y0 && cy <= r.y1);
    if (row) row.labels.push(b); else rest.push(b);
  });
  const out = [];
  tables.forEach(t => t.rows.forEach(r => out.push({ y: r.y0, x: t.x0, t: (r.cells.join(' | ') + (r.labels.length ? '   ◀ 이 행에 겹쳐 적힌 라벨: ' + r.labels.sort((a, b) => a.x - b.x).map(l => `[${l.t}]`).join(' ') : '')).trim() })));
  rest.forEach(b => out.push({ y: b.y == null ? 1e15 : b.y, x: b.x || 0, t: b.t }));
  out.sort((a, b) => (Math.abs(a.y - b.y) > 90000 ? a.y - b.y : a.x - b.x));
  return out.map(o => o.t).filter(Boolean).join('\n');
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
        return { kind: 'pdf', filePart: r.pages > MAX_PDF_PAGES ? filePart : null, imageParts: r.images, text: r.text, warnings, pageInfo: r.pageInfo };
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
    const media = zip.file(/word\/media\//);
    if (media.length) {
      // Word 안의 그림(표를 그림으로 붙여 넣은 공지)을 문서에 나온 순서대로 꺼내 AI가 읽게 합니다
      let imgOk = true;
      try {
        const relsF = zip.file('word/_rels/document.xml.rels'); const docXml = await f.async('string');
        const rels = {}; if (relsF) { const rx = await relsF.async('string'); rx.replace(/<Relationship\b[^>]*>/g, m => { const id = /\bId="([^"]+)"/.exec(m), tg = /\bTarget="([^"]+)"/.exec(m); if (id && tg) rels[id[1]] = tg[1]; }); }
        const order = []; docXml.replace(/r:embed="([^"]+)"/g, (m, id) => { const t = rels[id]; if (t) { const nm = 'word/' + String(t).replace(/^\.?\//, '').replace(/^\.\.\//, ''); if (!order.includes(nm)) order.push(nm); } });
        zip.file(/word\/media\//).forEach(m => { if (!order.includes(m.name)) order.push(m.name); });
        const { createCanvas, loadImage } = require('@napi-rs/canvas');
        const imageParts = []; let skipped = 0;
        for (const nm of order) {
          const ent = zip.file(nm); if (!ent) continue;
          if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(nm)) { skipped++; continue; }
          const buf = await ent.async('nodebuffer'); if (buf.length < 6000) continue;   // 로고·구분선 같은 작은 그림은 건너뜀
          const im = await loadImage(buf); const W = im.width, H = im.height; if (W < 200 || H < 120 || W / H > 6) continue;   // 회사 로고·띠 모양 머리글 그림은 건너뜀
          const sc = W > 1800 ? 1800 / W : 1, w = Math.round(W * sc), h = Math.round(H * sc);
          const slice = Math.round(w * 1.25), step = Math.round(slice * 0.92);
          for (let y = 0; y < h && imageParts.length < 14; y += step) {
            const sh = Math.min(slice, h - y), cv = createCanvas(w, sh), cx = cv.getContext('2d');
            cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, sh); cx.drawImage(im, 0, y / sc, W, sh / sc, 0, 0, w, sh);
            imageParts.push({ type: 'input_image', image_url: 'data:image/png;base64,' + cv.toBuffer('image/png').toString('base64'), detail: 'high' });
            if (y + sh >= h) break;
          }
        }
        if (imageParts.length) {
          if (skipped) warnings.push(`Word 안의 그림 ${skipped}개는 형식(EMF/WMF 등)을 읽을 수 없어 건너뛰었습니다. 그 그림에 시책이 있으면 PDF로 저장해 올려 주세요.`);
          return { kind: 'docx', imageParts, text: text.slice(0, MAX_TEXT), warnings };
        }
      } catch (e) { imgOk = false; console.error('[시책읽기] Word 그림 추출 실패:', e.message); }
      if (text.replace(/\s/g, '').length < 300) throw new Error('글자가 거의 없고 이미지로 된 Word 파일입니다. PDF로 저장해서 올려 주세요.');
      if (!imgOk) warnings.push('Word 파일 안의 그림(이미지)은 읽지 못했습니다. 그림에 시책 내용이 있다면 PDF로 저장해서 다시 올려 주세요.');   // 로고뿐인 파일은 경고하지 않음
    }
    return { kind: 'text', text: text.slice(0, MAX_TEXT), warnings };
  }
  if (ext === 'pptx') {
    const zip = await JSZip.loadAsync(buffer);
    const slides = zip.file(/^ppt\/slides\/slide\d+\.xml$/).sort((a, b) => num(a.name) - num(b.name));
    let text = '', emptyWithPic = 0;
    for (const s of slides) {
      const xml = await s.async('string');
      let t = '';
      try { t = (slideXmlToTextPositioned(xml) || '').trim(); } catch (e) { console.error('[시책읽기] 슬라이드 위치 분석 실패 → 기본 방식:', e.message); }
      if (!t) t = slideXmlToText(xml).trim();
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
