import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { db, toast, esc, today } from '../app.js';
import { PARSERS, detectCarrier, dedupe, PDF_PARSERS, detectPdfCarrier, itemsToLines } from '../parsers.js';

// PDF 讀取工具（用到時才載入）
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';
let pdfjsLib = null;

async function readPdf(buf) {
  if (!pdfjsLib) {
    pdfjsLib = await import(PDFJS + 'pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
  }
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(itemsToLines(tc.items.map(t => ({ str: t.str, x: t.transform[4], y: t.transform[5], w: t.width }))));
  }
  return pages;
}

let carriers = [];   // [{id, name}]
let parsed = [];     // 讀取後、尚未匯入的結果

export async function renderImport(page) {
  parsed = [];
  page.innerHTML = `
    <h2>版單匯入</h2>

    <div class="card">
      <div class="row">
        <label>到貨日期 <input type="date" id="imp-date" value="${today()}"></label>
        <span class="muted">（點貨的那一天，通常就是今天）</span>
      </div>
    </div>

    <div class="card">
      <div id="file-rows"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="add-row" type="button">＋ 再加一個檔案</button>
        <button class="btn primary" id="read-btn" type="button">讀取檔案</button>
      </div>
    </div>

    <div id="preview"></div>

    <div class="card">
      <h3 style="margin-top:0">這一天已匯入的檔案</h3>
      <div id="imported-list" class="muted">載入中…</div>
    </div>`;

  const { data, error } = await db.from('carriers')
    .select('id, name').eq('active', true).order('sort_order');
  if (error) { toast('讀取快遞公司失敗：' + error.message, 'error'); return; }
  carriers = data;

  addFileRow();
  document.getElementById('add-row').addEventListener('click', addFileRow);
  document.getElementById('read-btn').addEventListener('click', readAll);
  document.getElementById('imp-date').addEventListener('change', () => {
    document.getElementById('preview').innerHTML = '';
    parsed = [];
    loadImported();
  });
  loadImported();
}

// ---------- 檔案列：快遞公司下拉 + 檔案 ----------
function addFileRow() {
  const wrap = document.getElementById('file-rows');
  const div = document.createElement('div');
  div.className = 'file-row row';
  div.innerHTML = `
    <select class="f-carrier">
      <option value="">選擇快遞公司</option>
      ${carriers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
    </select>
    <input type="file" class="f-file" accept=".xls,.xlsx,.csv,.pdf">
    <button class="btn small f-remove" type="button">移除</button>`;
  div.querySelector('.f-remove').addEventListener('click', () => {
    if (wrap.children.length > 1) div.remove();
    else { div.querySelector('.f-file').value = ''; div.querySelector('.f-carrier').value = ''; }
  });
  wrap.appendChild(div);
}

// ---------- 讀取所有檔案 ----------
async function readAll() {
  const rowsEl = [...document.querySelectorAll('.file-row')];
  const jobs = rowsEl.map(el => ({
    carrierId: Number(el.querySelector('.f-carrier').value) || null,
    file: el.querySelector('.f-file').files[0],
  })).filter(j => j.file);

  if (!jobs.length) { toast('請先選擇檔案', 'warn'); return; }
  if (jobs.some(j => !j.carrierId)) { toast('每個檔案都要選快遞公司', 'warn'); return; }

  const btn = document.getElementById('read-btn');
  btn.disabled = true;
  parsed = [];

  for (const j of jobs) {
    const carrier = carriers.find(c => c.id === j.carrierId);
    const item = { carrier, file: j.file, rows: [], warnings: [], errors: [], sourceDate: null, existing: 0 };
    parsed.push(item);

    const isPdf = /\.pdf$/i.test(j.file.name);
    const parser = (isPdf ? PDF_PARSERS : PARSERS)[carrier.name];
    if (!parser) {
      item.errors.push(isPdf
        ? `「${carrier.name}」的 PDF 版單格式還沒設定，請提供樣本檔`
        : `「${carrier.name}」的 Excel 版單格式還沒設定，請提供樣本檔`);
      continue;
    }

    try {
      const buf = await j.file.arrayBuffer();
      let raw, detected;

      if (isPdf) {
        raw = await readPdf(buf);
        if (!raw.flat().length) {
          item.errors.push('這個 PDF 讀不到文字（可能是掃描的圖片檔），請改用系統直接匯出或列印的 PDF');
          continue;
        }
        detected = detectPdfCarrier(raw);
      } else {
        const wb = XLSX.read(buf, { type: 'array' });
        const sheetName = wb.SheetNames.includes('單據資料') ? '單據資料' : wb.SheetNames[0];
        raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
        detected = detectCarrier(raw);
      }

      if (detected && detected !== carrier.name) {
        item.errors.push(`這個檔案看起來是「${detected}」的格式，但你選的是「${carrier.name}」，請確認`);
        continue;
      }

      const result = parser.parse(raw);
      const { rows, dups } = dedupe(result.rows);
      item.rows = rows;
      item.sourceDate = result.sourceDate;
      item.warnings.push(...result.warnings);
      if (dups.length) item.warnings.push(`檔案內有重複單號，只保留第一筆：${dups.join('、')}`);
      if (!rows.length) item.errors.push('沒有讀到任何單號，檔案格式可能不同');
    } catch (e) {
      item.errors.push('檔案讀取失敗：' + e.message);
    }
  }

  // 檢查同一天、同一家是否已匯入過這些單號
  const workDate = document.getElementById('imp-date').value;
  for (const item of parsed) {
    if (!item.rows.length) continue;
    const nos = item.rows.map(s => s.waybill_no);
    let count = 0;
    for (let i = 0; i < nos.length; i += 300) {
      const { count: c } = await db.from('shipments')
        .select('id', { count: 'exact', head: true })
        .eq('work_date', workDate).eq('carrier_id', item.carrier.id)
        .in('waybill_no', nos.slice(i, i + 300));
      count += c || 0;
    }
    item.existing = count;
  }

  btn.disabled = false;
  renderPreview();
}

// ---------- 預覽 ----------
function money(n) {
  return n ? '$' + Number(n).toLocaleString() : '';
}

function payCell(s) {
  const parts = [];
  if (s.is_cod) parts.push(`<span class="cod">到付 ${money(s.cod_amount)}</span>`);
  else if (s.payment_type) parts.push(esc(s.payment_type));
  if (s.collect_amount) parts.push(`<span class="cod">代收 ${money(s.collect_amount)}</span>`);
  return parts.join('<br>');
}

function renderPreview() {
  const box = document.getElementById('preview');
  const workDate = document.getElementById('imp-date').value;
  const ok = parsed.filter(p => p.rows.length && !p.errors.length);

  box.innerHTML = parsed.map(p => {
    const pieces = p.rows.reduce((a, s) => a + s.pieces, 0);
    const cods = p.rows.filter(s => s.is_cod || s.collect_amount).length;
    const dateNote = p.sourceDate && p.sourceDate !== workDate
      ? `<span class="muted">（版單日期 ${p.sourceDate}）</span>` : '';

    return `
      <div class="card">
        <div class="row">
          <strong class="carrier-tag">${esc(p.carrier.name)}</strong>
          <span>${esc(p.file.name)}</span>
          ${dateNote}
        </div>
        ${p.errors.map(e => `<p class="msg error-msg">✖ ${esc(e)}</p>`).join('')}
        ${p.warnings.map(w => `<p class="msg warn-msg">⚠ ${esc(w)}</p>`).join('')}
        ${p.existing ? `<p class="msg warn-msg">⚠ 其中 ${p.existing} 筆這天已經匯入過，會用新檔案的資料更新（不影響已點貨的狀態）</p>` : ''}
        ${p.rows.length ? `
          <div class="stats">
            <div><b>${p.rows.length}</b><span>筆</span></div>
            <div><b>${pieces}</b><span>件</span></div>
            ${cods ? `<div class="stat-cod"><b>${cods}</b><span>筆到付/代收</span></div>` : ''}
          </div>
          <details>
            <summary>查看明細</summary>
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr>
                  <th>單號</th><th>發送站</th><th>寄件人</th><th>付款</th>
                  <th>收件人</th><th class="center">件數</th><th>地址</th>
                </tr></thead>
                <tbody>
                  ${p.rows.map(s => `
                    <tr>
                      <td class="mono">${esc(s.waybill_no)}</td>
                      <td>${esc(s.origin_station)}</td>
                      <td>${esc(s.sender)}</td>
                      <td>${payCell(s)}</td>
                      <td>${esc(s.receiver)}${s.remark ? `<br><span class="remark">📝 ${esc(s.remark)}</span>` : ''}</td>
                      <td class="center">${s.pieces}</td>
                      <td>${esc(s.address)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </details>` : ''}
      </div>`;
  }).join('') + (ok.length ? `
    <div class="card row">
      <button class="btn primary big" id="commit-btn">確認匯入 ${ok.length} 個檔案</button>
      <span class="muted">匯入到 ${workDate}</span>
    </div>` : '');

  document.getElementById('commit-btn')?.addEventListener('click', commit);
}

// ---------- 寫入資料庫 ----------
async function commit() {
  const btn = document.getElementById('commit-btn');
  btn.disabled = true;
  btn.textContent = '匯入中…';
  const workDate = document.getElementById('imp-date').value;
  let total = 0;

  for (const p of parsed.filter(x => x.rows.length && !x.errors.length)) {
    const pieces = p.rows.reduce((a, s) => a + s.pieces, 0);
    const { data: imp, error: e1 } = await db.from('imports').insert({
      work_date: workDate,
      carrier_id: p.carrier.id,
      file_name: p.file.name,
      row_count: p.rows.length,
      total_pieces: pieces,
      source_date: p.sourceDate,
    }).select('id').single();
    if (e1) { toast(`${p.carrier.name} 匯入失敗：${e1.message}`, 'error'); btn.disabled = false; return; }

    const payload = p.rows.map(s => ({
      ...s,
      work_date: workDate,
      carrier_id: p.carrier.id,
      import_id: imp.id,
      source_date: p.sourceDate,
    }));

    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await db.from('shipments')
        .upsert(payload.slice(i, i + 500), { onConflict: 'work_date,carrier_id,waybill_no' });
      if (error) {
        toast(`${p.carrier.name} 寫入失敗：${error.message}`, 'error');
        btn.disabled = false;
        return;
      }
    }
    total += payload.length;
  }

  toast(`匯入完成，共 ${total} 筆`, 'ok');
  parsed = [];
  document.getElementById('preview').innerHTML = '';
  document.querySelectorAll('.file-row').forEach((el, i) => i === 0
    ? (el.querySelector('.f-file').value = '', el.querySelector('.f-carrier').value = '')
    : el.remove());
  loadImported();
}

// ---------- 已匯入清單 ----------
async function loadImported() {
  const box = document.getElementById('imported-list');
  const workDate = document.getElementById('imp-date').value;
  const { data, error } = await db.from('imports')
    .select('id, file_name, row_count, total_pieces, created_at, carriers(name)')
    .eq('work_date', workDate)
    .order('created_at');

  if (error) { box.innerHTML = `<span class="error">讀取失敗：${esc(error.message)}</span>`; return; }
  if (!data.length) { box.innerHTML = '這一天還沒有匯入任何檔案。'; return; }

  box.classList.remove('muted');
  box.innerHTML = `
    <table class="tbl">
      <thead><tr><th>時間</th><th>快遞公司</th><th>檔案</th><th class="center">筆數</th><th class="center">件數</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${new Date(r.created_at).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })}</td>
            <td>${esc(r.carriers?.name)}</td>
            <td>${esc(r.file_name)}</td>
            <td class="center">${r.row_count}</td>
            <td class="center">${r.total_pieces}</td>
            <td><button class="btn small del-imp" data-id="${r.id}" data-name="${esc(r.file_name)}">刪除</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="muted">傳錯檔案可以刪除；已經開始點貨的檔案不能刪。</p>`;

  box.querySelectorAll('.del-imp').forEach(b => b.addEventListener('click', () => deleteImport(b.dataset.id, b.dataset.name)));
}

async function deleteImport(id, name) {
  const { count } = await db.from('shipments')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', id).neq('status', '待到貨');
  if (count) { toast(`這個檔案已有 ${count} 筆點過貨，不能刪除`, 'warn'); return; }
  if (!confirm(`確定刪除「${name}」匯入的所有單號？`)) return;

  const { error: e1 } = await db.from('shipments').delete().eq('import_id', id);
  if (e1) { toast('刪除失敗：' + e1.message, 'error'); return; }
  const { error: e2 } = await db.from('imports').delete().eq('id', id);
  if (e2) { toast('刪除失敗：' + e2.message, 'error'); return; }
  toast('已刪除', 'ok');
  loadImported();
}
