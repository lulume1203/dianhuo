// 加價區域：偏遠／特殊地區加價表
// 有「加價區域」權限的人可以查詢、新增、修改、刪除、下載
// 下載的 Excel 依「縣市 → 行政區 → 金額」排好，可以直接印給客人
import { db, toast, esc, today, can } from '../app.js';

const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const CITY_ORDER = ['全台', '基隆', '台北', '新北', '桃園', '新竹市', '新竹', '苗栗', '台中', '彰化', '南投', '雲林',
  '嘉義市', '嘉義', '台南', '高雄', '屏東', '宜蘭', '花蓮', '台東', '澎湖', '金門', '馬祖'];
const CITY_FULL = {
  全台: '特殊機關／單位（全台適用）', 基隆: '基隆市', 台北: '台北市', 新北: '新北市', 桃園: '桃園市',
  新竹市: '新竹市', 新竹: '新竹縣', 苗栗: '苗栗縣', 台中: '台中市', 彰化: '彰化縣', 南投: '南投縣',
  雲林: '雲林縣', 嘉義市: '嘉義市', 嘉義: '嘉義縣', 台南: '台南市', 高雄: '高雄市', 屏東: '屏東縣', 宜蘭: '宜蘭縣',
  花蓮: '花蓮縣', 台東: '台東縣', 澎湖: '澎湖縣', 金門: '金門縣', 馬祖: '連江縣（馬祖）',
};
const KINDS = ['加價', '自取', '不配送'];

let rules = [];
let notesSetting = { title: '偏遠及特殊地區加價表', notes: [] };
let editable = false;

export async function renderSurcharge(el) {
  editable = can('surcharge');
  el.innerHTML = `
    <h2>加價區域</h2>

    <div class="split fill wide-left">
      <div class="card">
        <h3 class="sub">加價區查詢</h3>
        <div class="fields fields-row">
          <label>縣市<select id="sc-city"><option value="">全部縣市</option></select></label>
          <label class="grow">找地點<input id="sc-q" placeholder="例如 三峽、大埔路、醫院"></label>
          <label>顯示
            <select id="sc-show">
              <option value="">全部</option>
              <option value="review">只看「待確認」</option>
              <option value="nodist">只看「未分區」</option>
            </select>
          </label>
          ${editable ? `<button class="btn" id="sc-add">＋ 新增一筆</button>` : ''}
        </div>
        <p class="muted" id="sc-count" style="margin:8px 0 4px"></p>
        <div class="scroll" id="sc-list">載入中…</div>
      </div>

      <div class="card">
        <h3 class="sub">加價表下載</h3>
        <div class="fields">
          <label>下載範圍<select id="sc-xcity"><option value="">全部縣市（整本）</option></select></label>
        </div>
        <button class="btn primary big" id="sc-xlsx" style="margin-top:12px;width:100%">下載 Excel</button>
        <p class="muted" style="margin:10px 0 0">依「縣市 → 行政區 → 金額」排好，A4 直印。待確認、資料來源這些內部欄位不會印出來。</p>

        <div id="sc-summary" style="margin-top:18px"></div>

        ${editable ? `
        <details id="sc-notes-box" style="margin-top:16px">
          <summary><b>Excel 標題與注意事項</b></summary>
          <label style="display:block;margin-top:10px">標題<input id="sc-title" style="width:100%"></label>
          <label style="display:block;margin-top:10px">注意事項（一行一條）
            <textarea id="sc-notes" rows="6" style="width:100%"></textarea></label>
          <button class="btn" id="sc-notes-save" style="margin-top:8px">儲存</button>
        </details>` : ''}
      </div>
    </div>

    <div id="sc-modal" class="modal" hidden></div>`;

  document.getElementById('sc-city').addEventListener('change', () => {
    document.getElementById('sc-xcity').value = document.getElementById('sc-city').value;   // 下載範圍跟著查詢的縣市
    draw();
  });
  document.getElementById('sc-show').addEventListener('change', draw);
  let t;
  document.getElementById('sc-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 200); });
  document.getElementById('sc-xlsx').addEventListener('click', exportExcel);
  if (editable) {
    document.getElementById('sc-add').addEventListener('click', () => openEditor(null));
    document.getElementById('sc-notes-save').addEventListener('click', saveNotes);
  }
  document.getElementById('sc-list').addEventListener('click', onListClick);

  await Promise.all([loadRules(), loadNotes()]);
  fillCities();
  draw();
}

// ---------- 讀資料 ----------
async function loadRules() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('surcharge_rules')
      .select('id, city, district, place, kind, fee, note, review, src, sort, updated_at, updated_by')
      .order('sort').order('id').range(from, from + 999);
    if (error) { document.getElementById('sc-list').textContent = '讀取失敗：' + error.message; return; }
    all.push(...data);
    if (data.length < 1000) break;
  }
  rules = all;
}

async function loadNotes() {
  const { data } = await db.from('app_settings').select('value').eq('key', 'surcharge_notes').maybeSingle();
  if (data?.value) notesSetting = { title: data.value.title || notesSetting.title, notes: data.value.notes || [] };
  if (editable) {
    document.getElementById('sc-title').value = notesSetting.title;
    document.getElementById('sc-notes').value = notesSetting.notes.join('\n');
  }
}

async function saveNotes() {
  const title = document.getElementById('sc-title').value.trim() || '偏遠及特殊地區加價表';
  const notes = document.getElementById('sc-notes').value.split('\n').map(s => s.trim()).filter(Boolean);
  const { error } = await db.from('app_settings').upsert({ key: 'surcharge_notes', value: { title, notes }, updated_at: new Date().toISOString() });
  if (error) { toast('儲存失敗：' + error.message, 'error'); return; }
  notesSetting = { title, notes };
  toast('已儲存', 'ok');
}

// ---------- 排序、分組 ----------
const cityRank = c => { const i = CITY_ORDER.indexOf(c); return i < 0 ? 99 : i; };
const kindRank = r => (r.kind === '加價' ? 0 : r.kind === '自取' ? 1 : 2);

function sortRules(list) {
  // 行政區照第一次出現的順序（＝原本表上的順序），未分區放最後
  const dOrder = new Map();
  for (const r of list) {
    const k = r.city + '|' + r.district;
    if (!dOrder.has(k)) dOrder.set(k, r.sort ?? 1e9);
  }
  return [...list].sort((a, b) =>
    cityRank(a.city) - cityRank(b.city) ||
    (a.district === '') - (b.district === '') ||
    dOrder.get(a.city + '|' + a.district) - dOrder.get(b.city + '|' + b.district) ||
    a.district.localeCompare(b.district, 'zh-Hant') ||
    kindRank(a) - kindRank(b) || (a.fee ?? 0) - (b.fee ?? 0) ||
    (a.place !== '') - (b.place !== '') || (a.sort ?? 0) - (b.sort ?? 0));
}

function fillCities() {
  const sel = document.getElementById('sc-city');
  const cities = [...new Set(rules.map(r => r.city))].sort((a, b) => cityRank(a) - cityRank(b));
  const opts = cities.map(c => `<option value="${esc(c)}">${esc(CITY_FULL[c] || c)}</option>`).join('');
  sel.innerHTML = `<option value="">全部縣市</option>` + opts;
  document.getElementById('sc-xcity').innerHTML = `<option value="">全部縣市（整本）</option>` + opts;
}

function filtered() {
  const city = document.getElementById('sc-city').value;
  const q = document.getElementById('sc-q').value.trim().replace(/臺/g, '台');
  const show = document.getElementById('sc-show').value;
  return sortRules(rules.filter(r =>
    (!city || r.city === city) &&
    (!show || (show === 'review' ? r.review : (!r.district && r.city !== '全台'))) &&
    (!q || [r.city, r.district, r.place, r.note].some(v => String(v || '').replace(/臺/g, '台').includes(q)))));
}

const feeText = r => (r.kind === '加價' ? (r.fee == null ? '（未填）' : `+${r.fee} 元`) : r.kind);
const feeClass = r => (r.kind === '加價' ? (r.fee == null ? 'sc-fee-none' : 'sc-fee-add') : r.kind === '自取' ? 'sc-fee-self' : 'sc-fee-no');

// ---------- 畫面 ----------
function draw() {
  const list = filtered();
  const nReview = rules.filter(r => r.review).length;
  const nNoDist = rules.filter(r => !r.district && r.city !== '全台').length;
  document.getElementById('sc-count').textContent = `找到 ${list.length} 筆`;
  document.getElementById('sc-summary').innerHTML = `
    <div class="sc-stats">
      <div><span>全部</span><b>${rules.length}</b> 筆</div>
      <div class="${nReview ? 'warn' : ''}"><span>待確認</span><b>${nReview}</b> 筆</div>
      <div><span>未分區</span><b>${nNoDist}</b> 筆</div>
    </div>
    <p class="muted" style="margin:8px 0 0;font-size:15px">「待確認」：舊版和媽媽版金額不一樣、或同一頁寫了兩次，目前先用媽媽版的金額。確認後按「確認無誤」。</p>
    <p class="muted" style="margin:4px 0 0;font-size:15px">「未分區」：還沒填行政區的地點，Excel 會放在該縣市最後的「其他地點」。</p>`;

  const box = document.getElementById('sc-list');
  if (!list.length) { box.innerHTML = `<p class="muted">沒有符合的資料。</p>`; return; }

  let html = '';
  let city = null;
  for (const r of list) {
    if (r.city !== city) {
      if (city !== null) html += `</tbody></table></div>`;
      city = r.city;
      html += `<div class="sc-city"><h3>${esc(CITY_FULL[city] || city)}</h3>
        <table class="tbl sc-table"><thead><tr>
          <th style="width:110px">行政區</th><th>地點／路段</th><th style="width:100px">金額</th><th>備註</th>
          <th style="width:${editable ? 210 : 120}px"></th></tr></thead><tbody>`;
    }
    html += `<tr class="${r.review ? 'sc-review' : ''}" data-id="${r.id}">
      <td>${r.district ? esc(r.district) : (city === '全台' ? '' : '<span class="muted">未分區</span>')}</td>
      <td>${r.place ? esc(r.place) : '<b>全區</b>'}</td>
      <td><span class="sc-fee ${feeClass(r)}">${esc(feeText(r))}</span></td>
      <td>${esc(r.note || '')}${r.review ? `<div class="sc-why">⚠ ${esc(r.review)}</div>` : ''}</td>
      <td class="sc-ops">${editable ? `
        ${r.review ? `<button class="btn small" data-act="ok">確認無誤</button>` : ''}
        <button class="btn small" data-act="edit">修改</button>
        <button class="btn small danger" data-act="del">刪除</button>` : ''}
        <div class="sc-meta">${r.updated_by ? esc(r.updated_by) + ' ' : ''}${r.updated_at ? esc(r.updated_at.slice(5, 10).replace('-', '/')) : ''}</div>
      </td></tr>`;
  }
  html += `</tbody></table></div>`;
  box.innerHTML = html;
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('tr').dataset.id);
  const r = rules.find(x => x.id === id);
  if (!r) return;
  if (btn.dataset.act === 'edit') return openEditor(r);
  if (btn.dataset.act === 'ok') {
    if (r.kind === '加價' && r.fee == null) { toast('這筆還沒填金額，請按「修改」補上', 'warn'); return; }
    const { data, error } = await db.from('surcharge_rules').update({ review: null }).eq('id', id).select().single();
    if (error) { toast('更新失敗：' + error.message, 'error'); return; }
    Object.assign(r, data); draw(); toast('已確認', 'ok');
  }
  if (btn.dataset.act === 'del') {
    if (!confirm(`確定刪除「${r.city} ${r.district} ${r.place || '全區'} ${feeText(r)}」？`)) return;
    const { error } = await db.from('surcharge_rules').delete().eq('id', id);
    if (error) { toast('刪除失敗：' + error.message, 'error'); return; }
    rules = rules.filter(x => x.id !== id); draw(); toast('已刪除', 'ok');
  }
}

// ---------- 新增／修改 ----------
function openEditor(r) {
  const m = document.getElementById('sc-modal');
  const cities = [...new Set([...CITY_ORDER, ...rules.map(x => x.city)])];
  const cur = r || { city: document.getElementById('sc-city').value || '', district: '', place: '', kind: '加價', fee: '', note: '' };
  m.innerHTML = `
    <div class="modal-box">
      <h3>${r ? '修改' : '新增'}加價地點</h3>
      <div class="sc-form">
        <label>縣市<select id="e-city">${cities.map(c => `<option value="${esc(c)}" ${c === cur.city ? 'selected' : ''}>${esc(CITY_FULL[c] || c)}</option>`).join('')}</select></label>
        <label>行政區<input id="e-district" list="e-dlist" value="${esc(cur.district)}" placeholder="例如 三峽區（可空白）"><datalist id="e-dlist"></datalist></label>
        <label class="full">地點／路段<input id="e-place" value="${esc(cur.place)}" placeholder="空白＝整個行政區都加價，例如 大埔路、長庚醫院"></label>
        <div class="full">類別
          <div class="row" style="gap:16px;margin-top:4px">${KINDS.map(k => `<label class="row" style="gap:4px"><input type="radio" name="e-kind" value="${k}" ${k === cur.kind ? 'checked' : ''}>${k}</label>`).join('')}</div>
        </div>
        <label id="e-fee-wrap">加價金額（元）<input id="e-fee" type="number" min="0" step="10" inputmode="numeric" value="${cur.fee ?? ''}"></label>
        <label class="full">備註（會印在 Excel 上）<input id="e-note" value="${esc(cur.note || '')}" placeholder="例如 首件100元、雪霸休閒農場也不配送"></label>
        ${r?.review ? `<div class="full sc-why">⚠ ${esc(r.review)}<br><label class="row" style="gap:6px;margin-top:6px"><input type="checkbox" id="e-ok" checked>儲存後標記為「已確認」</label></div>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn" id="e-cancel">取消</button>
        <button class="btn primary" id="e-save">儲存</button>
      </div>
    </div>`;
  m.hidden = false;

  const fillDistricts = () => {
    const c = document.getElementById('e-city').value;
    const ds = [...new Set(rules.filter(x => x.city === c && x.district).map(x => x.district))];
    document.getElementById('e-dlist').innerHTML = ds.map(d => `<option value="${esc(d)}">`).join('');
  };
  const syncFee = () => {
    const k = m.querySelector('input[name=e-kind]:checked').value;
    document.getElementById('e-fee-wrap').hidden = k !== '加價';
  };
  fillDistricts(); syncFee();
  document.getElementById('e-city').addEventListener('change', fillDistricts);
  m.querySelectorAll('input[name=e-kind]').forEach(x => x.addEventListener('change', syncFee));
  document.getElementById('e-cancel').addEventListener('click', () => { m.hidden = true; });
  document.getElementById('e-save').addEventListener('click', async () => {
    const kind = m.querySelector('input[name=e-kind]:checked').value;
    const feeRaw = document.getElementById('e-fee').value.trim();
    const row = {
      city: document.getElementById('e-city').value,
      district: document.getElementById('e-district').value.trim().replace(/臺/g, '台'),
      place: document.getElementById('e-place').value.trim(),
      kind,
      fee: kind === '加價' ? Number(feeRaw) : null,
      note: document.getElementById('e-note').value.trim() || null,
    };
    if (kind === '加價' && (feeRaw === '' || !(row.fee >= 0))) { toast('請填加價金額', 'warn'); return; }
    if (!row.district && !row.place && row.city !== '全台') { toast('行政區和地點至少要填一個', 'warn'); return; }
    const ok = document.getElementById('e-ok');
    if (!r || (ok && ok.checked)) row.review = null;

    const q = r
      ? db.from('surcharge_rules').update(row).eq('id', r.id).select().single()
      : db.from('surcharge_rules').insert({ ...row, src: '系統新增', sort: nextSort(row) }).select().single();
    const { data, error } = await q;
    if (error) { toast('儲存失敗：' + error.message, 'error'); return; }
    if (r) Object.assign(r, data); else rules.push(data);
    m.hidden = true;
    draw();
    toast('已儲存', 'ok');
  });
}

// 新增的放在同一區最後面
function nextSort(row) {
  const same = rules.filter(x => x.city === row.city && x.district === row.district);
  const pool = same.length ? same : rules.filter(x => x.city === row.city);
  return pool.length ? Math.max(...pool.map(x => x.sort ?? 0)) : (rules.length ? Math.max(...rules.map(x => x.sort ?? 0)) + 1 : 1);
}

// =====================================================
// Excel：縣市 → 行政區 → 金額，一列一個金額，地點用「、」串起來
// =====================================================
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS;
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => reject(new Error('Excel 工具載入失敗'));
    document.head.appendChild(s);
  });
}

const FONT = '微軟正黑體';
const C = {   // 莫蘭迪色：紫＋霧金，白底
  navy: 'FF6B5B7B', navyDark: 'FF4B3F58', gold: 'FFB39A6B', line: 'FFD9D4DC', head: 'FFF1EDF4', zebra: 'FFFAF9FB',
  addBg: 'FFEFEAF3', addFg: 'FF5A4A6B', selfBg: 'FFF6EFDF', selfFg: 'FF7F5D1F', noBg: 'FFF6E3E0', noFg: 'FF8A3B34',
};
const thin = { style: 'thin', color: { argb: C.line } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

// 估算文字需要幾行（中文字算 1、英數算 0.55）
function lines(text, capacity) {
  let n = 1, w = 0;
  for (const part of String(text).split('\n')) {
    w = 0;
    for (const ch of part) {
      w += /[\x00-\xff]/.test(ch) ? 0.55 : 1;
      if (w > capacity) { n++; w = /[\x00-\xff]/.test(ch) ? 0.55 : 1; }
    }
  }
  return n + (String(text).split('\n').length - 1);
}

function tierOf(r) { return r.kind === '加價' ? `加價|${r.fee ?? ''}` : r.kind; }
function tierLabel(r) { return r.kind === '加價' ? (r.fee == null ? '待補' : `+${r.fee}`) : r.kind; }
function placeText(r) {
  const p = r.place || '全區';
  return r.note ? `${p}（${r.note}）` : p;
}

async function exportExcel() {
  const btn = document.getElementById('sc-xlsx');
  const city = document.getElementById('sc-xcity').value;
  const list = sortRules(rules.filter(r => (!city || r.city === city) && !(r.kind === '加價' && r.fee == null)));
  if (!list.length) { toast('沒有資料可以下載', 'warn'); return; }
  btn.disabled = true; btn.textContent = '產生中…';
  try {
    const ExcelJS = await loadExcelJS();
    const { data: ct } = await db.from('app_settings').select('value').eq('key', 'public_contact').maybeSingle();
    const phone = ct?.value?.phone || '';

    const wb = new ExcelJS.Workbook();
    wb.creator = '寬豐點貨系統';
    const ws = wb.addWorksheet(city ? (CITY_FULL[city] || city).replace(/[\\/?*[\]:（）()]/g, '').slice(0, 28) : '加價總表', {
      views: [{ showGridLines: false }],
    });
    ws.columns = [{ width: 14 }, { width: 11 }, { width: 66 }];
    const CAP = 30;   // C 欄一行大約放 30 個中文字

    ws.pageSetup = {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 },
    };
    const upd = today().replace(/-/g, '/');
    ws.headerFooter.oddFooter = `&L&9${notesSetting.title}　更新日期 ${upd}&R&9第 &P 頁／共 &N 頁`;

    const f = (size, bold, color) => ({ name: FONT, size, bold: !!bold, color: color ? { argb: color } : undefined });
    let r = 1;

    // 標題
    ws.mergeCells(r, 1, r, 3);
    Object.assign(ws.getCell(r, 1), { value: notesSetting.title + (city ? `－${CITY_FULL[city] || city}` : '') });
    ws.getCell(r, 1).font = f(20, true, C.navyDark);
    ws.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(r).height = 36; r++;

    ws.mergeCells(r, 1, r, 3);
    ws.getCell(r, 1).value = `寬豐　｜　更新日期 ${upd}${phone ? `　｜　洽詢電話 ${phone}` : ''}`;
    ws.getCell(r, 1).font = f(11, false, 'FF555555');
    ws.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(r, 1).border = { bottom: { style: 'medium', color: { argb: C.gold } } };
    ws.getCell(r, 2).border = ws.getCell(r, 1).border; ws.getCell(r, 3).border = ws.getCell(r, 1).border;
    ws.getRow(r).height = 22; r++;

    // 圖例
    ws.getRow(r).height = 8; r++;
    ws.mergeCells(r, 1, r, 3);
    ws.getCell(r, 1).value = {
      richText: [
        { text: '查詢方式：', font: f(11, true) },
        { text: '先找縣市、再找行政區。「全區」＝整個行政區都加價。\n', font: f(11) },
        { text: ' +100 ', font: f(11, true, C.addFg) }, { text: '每件加價金額（元）　', font: f(11) },
        { text: ' 自取 ', font: f(11, true, C.selfFg) }, { text: '不配送到府，請收件人到站所自取　', font: f(11) },
        { text: ' 不配送 ', font: f(11, true, C.noFg) }, { text: '不收此地區貨件', font: f(11) },
      ],
    };
    ws.getCell(r, 1).alignment = { wrapText: true, vertical: 'middle' };
    ws.getRow(r).height = 36; r++;

    // 各縣市
    const byCity = new Map();
    for (const x of list) { if (!byCity.has(x.city)) byCity.set(x.city, []); byCity.get(x.city).push(x); }

    for (const [c, items] of byCity) {
      ws.getRow(r).height = 10; r++;
      // 縣市標題列
      ws.mergeCells(r, 1, r, 3);
      const band = ws.getCell(r, 1);
      band.value = CITY_FULL[c] || c;
      band.font = f(15, true, C.navyDark);
      band.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.head } };
      band.alignment = { vertical: 'middle', indent: 1 };
      ws.getRow(r).height = 28;
      band.border = { left: { style: 'thick', color: { argb: C.gold } }, bottom: { style: 'thin', color: { argb: C.gold } } };
      r++;
      // 表頭
      const heads = c === '全台' ? ['範圍', '金額', '機關／單位'] : ['行政區', '金額', '加價地點／路段'];
      heads.forEach((h, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = h; cell.font = f(11, true, C.navy);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: i === 2 ? 'left' : 'center', vertical: 'middle', indent: i === 2 ? 1 : 0 };
        cell.border = BORDER;
      });
      ws.getRow(r).height = 22; r++;

      // 行政區 → 金額分組
      const groups = new Map();
      for (const x of items) {
        const d = c === '全台' ? '' : (x.district || '其他地點');
        if (!groups.has(d)) groups.set(d, new Map());
        const g = groups.get(d);
        const k = tierOf(x);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(x);
      }

      let zebra = false;
      for (const [d, tiers] of groups) {
        const start = r;
        for (const [, xs] of tiers) {
          const rep = xs[0];
          // 全區放最前面
          const sorted = [...xs].sort((a, b) => (a.place !== '') - (b.place !== ''));
          const text = c === '全台'
            ? sorted.map(placeText).join('\n')
            : sorted.map(placeText).join('、');
          const a = ws.getCell(r, 1), b = ws.getCell(r, 2), t = ws.getCell(r, 3);
          a.value = c === '全台' ? '全台適用' : d;
          b.value = tierLabel(rep);
          t.value = text;
          const tone = rep.kind === '加價' ? [C.addBg, C.addFg] : rep.kind === '自取' ? [C.selfBg, C.selfFg] : [C.noBg, C.noFg];
          a.font = f(12, true, C.navyDark);
          b.font = f(12, true, tone[1]);
          t.font = f(12);
          b.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone[0] } };
          if (zebra) [a, t].forEach(x => { x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.zebra } }; });
          a.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
          b.alignment = { horizontal: 'center', vertical: 'middle' };
          t.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
          [a, b, t].forEach(x => { x.border = BORDER; });
          ws.getRow(r).height = Math.max(22, lines(text, CAP) * 18 + 6);
          r++;
        }
        if (r - start > 1) ws.mergeCells(start, 1, r - 1, 1);
        zebra = !zebra;
      }
    }

    // 注意事項
    if (notesSetting.notes.length) {
      ws.getRow(r).height = 14; r++;
      ws.mergeCells(r, 1, r, 3);
      ws.getCell(r, 1).value = '注意事項';
      ws.getCell(r, 1).font = f(13, true, C.navyDark);
      ws.getCell(r, 1).border = { bottom: { style: 'thin', color: { argb: C.gold } } };
      ws.getRow(r).height = 24; r++;
      notesSetting.notes.forEach((n, i) => {
        ws.mergeCells(r, 1, r, 3);
        const cell = ws.getCell(r, 1);
        cell.value = `${i + 1}. ${n}`;
        cell.font = f(11);
        cell.alignment = { wrapText: true, vertical: 'top' };
        ws.getRow(r).height = Math.max(20, lines(cell.value, 44) * 17 + 4);
        r++;
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `加價表${city ? '_' + (CITY_FULL[city] || city).replace(/[（）()／/]/g, '') : ''}_${today()}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    const skipped = rules.filter(x => (!city || x.city === city) && x.kind === '加價' && x.fee == null).length;
    toast(skipped ? `已下載（${skipped} 筆沒填金額的沒有印出來）` : '已下載', skipped ? 'warn' : 'ok');
  } catch (e) {
    toast('產生 Excel 失敗：' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '下載 Excel';
  }
}
