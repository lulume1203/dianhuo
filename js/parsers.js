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

// ---------- 註冊表 ----------
export const PARSERS = {
  '龍鐽':  { detect: detectLongjian, parse: parseLongjian },
  '來速捷': { detect: detectLaisuje,  parse: parseLaisuje },
  // '聯新': 等拿到樣本後加入
};

export function detectCarrier(rows) {
  for (const [name, p] of Object.entries(PARSERS)) {
    if (p.detect(rows)) return name;
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
