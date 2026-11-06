// =====================================================
// 各家快遞版單解析規則
// 每個解析器收到「一列一列的陣列」，回傳統一格式：
//   { rows: [...版單], sourceDate, warnings: [...] }
// =====================================================

const clean = v => String(v ?? '').replace(/[\s　]+/g, ' ').trim();
const noSpace = v => String(v ?? '').replace(/[\s　]+/g, '');
const toInt = v => {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
};
const toNum = v => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
};
const toDate = v => {
  const m = String(v ?? '').match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const isWaybill = s => /^[A-Za-z0-9-]{4,}$/.test(s);

function blank() {
  return {
    waybill_no: '',
    origin_station: null,
    sender: null,
    payment_type: null,
    is_cod: false,
    cod_amount: null,
    collect_amount: null,
    remark: null,
    receiver: null,
    receiver_phone: null,
    address: null,
    pieces: 1,
    barcodes: [],
  };
}

// ---------- 龍鐽：依發送站分段，每段有「發送站 / 提單號碼 / 送件人…」表頭 ----------
function detectLongjian(rows) {
  const flat = rows.slice(0, 15).flat().map(clean);
  return flat.some(s => s.includes('龍鐽')) ||
    (flat.includes('提單號碼') && flat.includes('送件人'));
}

function parseLongjian(rows) {
  const out = [];
  const warnings = [];
  let station = '';
  let cols = null;
  let sourceDate = null;
  let declaredTotal = null;

  for (const r of rows) {
    const c0 = clean(r[0]);

    if (!sourceDate) {
      const k = r.findIndex(x => clean(x) === '送件日期');
      if (k >= 0) sourceDate = toDate(r[k + 1]);
    }

    if (c0 === '發送站') {
      station = clean(r[1]);
      const idx = name => r.findIndex(x => clean(x) === name);
      cols = {
        no: idx('提單號碼'),
        sender: idx('送件人'),
        receiver: idx('收件人'),
        pieces: idx('件數'),
        address: idx('收件地址'),
      };
      continue;
    }
    if (c0 === '總計件數') { declaredTotal = toInt(r[1]); continue; }
    if (!cols || c0 === '小計件數') continue;

    let no = cols.no >= 0 ? noSpace(r[cols.no]) : '';
    if (!no) no = noSpace(c0).replace(/\*/g, '');
    if (!isWaybill(no)) continue;

    const s = blank();
    s.waybill_no = no;
    s.origin_station = station || null;
    s.sender = clean(r[cols.sender]) || null;
    s.receiver = clean(r[cols.receiver]) || null;
    s.address = clean(r[cols.address]) || null;
    s.pieces = Math.max(1, toInt(r[cols.pieces]));
    s.barcodes = [no];
    out.push(s);
  }

  if (declaredTotal !== null) {
    const sum = out.reduce((a, s) => a + s.pieces, 0);
    if (sum !== declaredTotal) {
      warnings.push(`檔案寫總計 ${declaredTotal} 件，但讀到 ${sum} 件，請確認檔案是否完整`);
    }
  }
  return { rows: out, sourceDate, warnings };
}

// ---------- 來速捷：系統匯出檔，第 3 列是欄位代碼（t_no、tg_no…）----------
const LAISUJE_PAY = {
  '0': '', '1': '付現', '2': '月結', '3': '到付月結',
  '4': '到付付現', '5': '第三方支付', '6': '其他',
};

function detectLaisuje(rows) {
  return rows.slice(0, 10).some(r => r.map(clean).includes('t_no') && r.map(clean).includes('tg_no'));
}

function parseLaisuje(rows) {
  const out = [];
  const warnings = [];
  let sourceDate = null;

  const h = rows.findIndex(r => r.map(clean).includes('t_no'));
  if (h < 0) return { rows: out, sourceDate, warnings: ['找不到欄位代碼列（t_no），檔案格式可能不同'] };

  const map = {};
  rows[h].forEach((k, i) => { const key = clean(k); if (key && !(key in map)) map[key] = i; });
  const g = (r, k) => (k in map ? clean(r[map[k]]) : '');

  let cur = null;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const no = noSpace(g(r, 't_no'));
    const tg = noSpace(g(r, 'tg_no'));
    const qty = toInt(g(r, 'tg_num')) || 1;

    if (no) {
      let pay = g(r, 't_paykind');
      if (pay in LAISUJE_PAY) pay = LAISUJE_PAY[pay];
      if (pay === '無') pay = '';
      const shipfee = toNum(g(r, 't_shipfee'));
      const takefee = toNum(g(r, 't_takefee'));

      cur = blank();
      cur.waybill_no = no;
      cur.origin_station = g(r, 's_name_s') || null;
      cur.sender = g(r, 't_name_s') || g(r, 'c_name') || null;
      cur.payment_type = pay || null;
      cur.is_cod = pay.includes('到付') || shipfee > 0;
      cur.cod_amount = shipfee > 0 ? shipfee : null;
      cur.collect_amount = takefee > 0 ? takefee : null;
      cur.receiver = g(r, 't_name_r') || null;
      cur.receiver_phone = g(r, 't_tel_r') || null;
      cur.address = g(r, 't_addr_r') || null;
      cur.pieces = tg ? qty : 1;
      cur.barcodes = [...new Set([no, tg].filter(Boolean))];
      if (!sourceDate) sourceDate = toDate(g(r, 't_take_date'));
      out.push(cur);
    } else if (tg && cur) {
      // 同一張單的第 2、3…件貨物
      cur.pieces += qty;
      if (!cur.barcodes.includes(tg)) cur.barcodes.push(tg);
    }
  }
  return { rows: out, sourceDate, warnings };
}

// ---------- 來速捷「板單表」：每天點貨用，一列一筆 ----------
// 欄位：取件日 發送站 單據號碼 寄件者 收件者 件數 尺寸 到付款 代收款 站所運費 地址 備註 … 付款方式 …
function detectLaisujeBoard(rows) {
  return rows.slice(0, 10).some(r => {
    const c = r.map(clean);
    return c.includes('單據號碼') && c.includes('收件者') && c.includes('件數');
  });
}

function parseLaisujeBoard(rows) {
  const out = [];
  const warnings = [];
  let sourceDate = null;
  let declaredTotal = null;

  const h = rows.findIndex(r => r.map(clean).includes('單據號碼'));
  const head = rows[h].map(clean);
  const col = name => head.indexOf(name);
  const C = {
    date: col('取件日'), station: col('發送站'), no: col('單據號碼'),
    sender: col('寄件者'), receiver: col('收件者'), pieces: col('件數'),
    cod: col('到付款'), collect: col('代收款'), address: col('地址'),
    remark: col('備註'), pay: col('付款方式'),
  };
  const g = (r, k) => (C[k] >= 0 ? clean(r[C[k]]) : '');

  // 標題列的日期（例如「板單表(全部) 2026-11-03 ~ 2026-11-03」）
  for (const r of rows.slice(0, h)) { sourceDate ||= toDate(r.map(clean).join(' ')); }

  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.map(clean).includes('總計')) { declaredTotal = toInt(r[C.pieces]); continue; }
    const no = noSpace(g(r, 'no'));
    if (!isWaybill(no)) continue;

    const cod = toNum(g(r, 'cod'));
    const collect = toNum(g(r, 'collect'));
    let pay = g(r, 'pay');

    const s = blank();
    s.waybill_no = no;
    s.origin_station = g(r, 'station') || null;
    s.sender = g(r, 'sender') || null;
    s.receiver = g(r, 'receiver') || null;
    s.address = g(r, 'address') || null;
    s.pieces = Math.max(1, toInt(g(r, 'pieces')));
    s.remark = g(r, 'remark') || null;
    s.is_cod = cod > 0 || pay.includes('到付');
    s.cod_amount = cod > 0 ? cod : null;
    s.collect_amount = collect > 0 ? collect : null;
    s.payment_type = s.is_cod && !pay ? '到付' : (pay || null);
    s.barcodes = [no];
    if (!sourceDate) sourceDate = toDate(g(r, 'date'));
    out.push(s);
  }

  if (declaredTotal !== null) {
    const sum = out.reduce((a, s) => a + s.pieces, 0);
    if (sum !== declaredTotal) warnings.push(`檔案寫總計 ${declaredTotal} 件，但讀到 ${sum} 件，請確認檔案是否完整`);
  }
  return { rows: out, sourceDate, warnings };
}

// 來速捷有兩種檔案：板單表（每天點貨用）和系統匯出檔，自動判斷
const laisuje = {
  detect: rows => detectLaisujeBoard(rows) || detectLaisuje(rows),
  parse: rows => (detectLaisujeBoard(rows) ? parseLaisujeBoard(rows) : parseLaisuje(rows)),
};

// ---------- 註冊表 ----------
export const PARSERS = {
  '龍鐽':  { detect: detectLongjian, parse: parseLongjian },
  '來速捷': laisuje,
};

export function detectCarrier(rows) {
  for (const [name, p] of Object.entries(PARSERS)) {
    if (p.detect(rows)) return name;
  }
  return null;
}

// =====================================================
// PDF 版單
// pdf.js 讀出的文字片段會把好幾欄黏在一起，但版單是等寬字型
// （英數字一格、中文字兩格），所以把每個字依位置切回原本的欄位。
// =====================================================

const isWide = ch => /[⺀-￯]/.test(ch) && !/[｡-ﾟ]/.test(ch);

// items: [{ str, x, y, w }]（一頁）→ 依行排好的字元 [{ y, chars: [{ x, c }] }]
export function itemsToLines(items) {
  const map = new Map();
  for (const it of items) {
    if (!it.str) continue;
    const chars = [...it.str];
    const units = chars.reduce((a, c) => a + (isWide(c) ? 2 : 1), 0);
    const unit = units ? it.w / units : 0;
    const y = Math.round(it.y);
    if (!map.has(y)) map.set(y, []);
    let x = it.x;
    for (const c of chars) {
      if (c.trim()) map.get(y).push({ x, c });
      x += unit * (isWide(c) ? 2 : 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])                       // PDF 座標由下往上，反過來變成由上往下
    .map(([y, chars]) => ({ y, chars: chars.sort((a, b) => a.x - b.x) }))
    .filter(l => l.chars.length);
}

const lineText = l => l.chars.map(ch => ch.c).join('');

// 從「== ====== ======…」那一行算出每一欄的起點
function columnStarts(line) {
  const starts = [];
  let prev = null;
  for (const ch of line.chars) {
    if (ch.c !== '=') continue;
    if (prev === null || ch.x - prev > 6) starts.push(ch.x);   // 中間有空格 → 新的一欄
    prev = ch.x;
  }
  return starts;
}

function splitColumns(line, starts, names) {
  const out = Object.fromEntries(names.map(n => [n, '']));
  for (const ch of line.chars) {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= ch.x + 0.5) i++;
    out[names[i]] += ch.c;
  }
  for (const n of names) out[n] = out[n].trim();
  return out;
}

// ---------- 聯新：「傳輸未達到著站清單」----------
const LIANXIN_COLS = ['shift', 'station', 'no', 'sender', 'receiver', 'pieces', 'driver', 'address', 'collect', 's', 'remark', 'cod'];

function detectLianxin(pages) {
  const head = pages.flat().slice(0, 12).map(lineText).join('');
  return head.includes('聯新') || head.includes('查貨號碼');
}

function parseLianxin(pages) {
  const out = [];
  const warnings = [];
  let sourceDate = null;
  let code = '', station = '';
  let group = [];

  for (const lines of pages) {
    let starts = null;
    for (const line of lines) {
      const text = lineText(line);
      if (!sourceDate && text.includes('發送日期')) sourceDate = toDate(text);

      // 欄位分隔線（有好幾段 =），每頁都會有
      if (/^=+$/.test(text) && columnStarts(line).length >= LIANXIN_COLS.length) {
        starts = columnStarts(line);
        continue;
      }
      if (!starts) continue;
      if (/^[-=]+$/.test(text) || text.includes('=>')) continue;   // 分隔線、最後的統計

      const f = splitColumns(line, starts, LIANXIN_COLS);

      // 新的發送站，例如「41神岡」
      if (f.station) {
        const m = f.station.match(/^(\d+)(.*)$/);
        if (m) { code = m[1]; station = f.station; }
      }

      let no = f.no.replace(/\s/g, '');
      if (no && /^\d{1,3}-\d+$/.test(no)) {
        // 站名太長會蓋掉單號第一個字（例如 450-… 變成 50-…），用站號補回來
        const [pre, rest] = no.split('-');
        const expected = code ? code + '0' : '';
        if (expected && pre.length < expected.length && expected.endsWith(pre)) no = `${expected}-${rest}`;

        const s = blank();
        s.waybill_no = no;
        s.origin_station = station || null;
        s.sender = f.sender || null;
        s.receiver = f.receiver || null;
        s.pieces = Math.max(1, toInt(f.pieces));
        s.address = f.address || null;
        s.remark = f.remark || null;
        const collect = toNum(f.collect);
        const cod = toNum(f.cod);
        s.collect_amount = collect > 0 ? collect : null;
        s.is_cod = cod > 0;
        s.cod_amount = cod > 0 ? cod : null;
        s.payment_type = cod > 0 ? '到付' : null;
        s.barcodes = [...new Set([no, no.replace(/-/g, '')])];   // 條碼可能有或沒有「-」
        out.push(s);
        group.push(s);
        continue;
      }

      // 小計列：「神岡  2」→ 補正站名、核對件數
      if (!no && f.pieces && /^\d+$/.test(f.pieces) && (f.sender || f.receiver)) {
        const name = (f.sender + f.receiver).replace(/\s/g, '');
        const sum = group.reduce((a, s) => a + s.pieces, 0);
        if (sum !== toInt(f.pieces)) warnings.push(`${name} 小計 ${f.pieces} 件，但讀到 ${sum} 件，請核對`);
        if (code && name) group.forEach(s => { s.origin_station = code + name; });
        group = [];
      }
    }
  }
  return { rows: out, sourceDate, warnings };
}

export const PDF_PARSERS = {
  '聯新': { detect: detectLianxin, parse: parseLianxin },
};

export function detectPdfCarrier(pages) {
  for (const [name, p] of Object.entries(PDF_PARSERS)) {
    if (p.detect(pages)) return name;
  }
  return null;
}

// 同一份檔案裡重複的單號：保留第一筆並提醒
export function dedupe(rows) {
  const seen = new Map();
  const dups = [];
  for (const s of rows) {
    if (seen.has(s.waybill_no)) dups.push(s.waybill_no);
    else seen.set(s.waybill_no, s);
  }
  return { rows: [...seen.values()], dups: [...new Set(dups)] };
}
