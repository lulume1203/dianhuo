// =====================================================
// 司機出車資料：讀取 + 下載 Excel
// 收件人電話只有超級管理者拿得到，其他人下載的清單不會有電話欄
// =====================================================
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { db, can } from './app.js';

// 取得某司機某天的出車明細（依刷單順序）
export async function fetchDriverStops(date, driverId) {
  const { data, error } = await db.from('dispatch_items')
    .select(`waybill_no, system_pieces, actual_pieces, created_at, shipment_id,
             dispatch_batches!inner(work_date, driver_id),
             shipments(id, waybill_no, sender, receiver, address,
                       payment_type, is_cod, cod_amount, collect_amount, remark, lat, lng, geocode_status,
                       carriers(name))`)
    .eq('dispatch_batches.work_date', date)
    .eq('dispatch_batches.driver_id', driverId)
    .order('created_at');
  if (error) throw error;

  // 超級管理者：另外取電話
  const phones = new Map();
  if (can('admin')) {
    const ids = data.map(d => d.shipment_id).filter(Boolean);
    if (ids.length) {
      const { data: ph } = await db.rpc('get_receiver_phones', { ids });
      (ph || []).forEach(p => phones.set(p.id, p.receiver_phone || ''));
    }
  }

  return data.map(d => {
    const s = d.shipments || {};
    return {
      shipment_id: d.shipment_id,
      carrier: s.carriers?.name || '',
      waybill_no: d.waybill_no,
      sender: s.sender || '',
      receiver: s.receiver || '',
      phone: phones.get(d.shipment_id) || '',
      address: s.address || '',
      system_pieces: d.system_pieces,
      actual_pieces: d.actual_pieces,
      payment: s.is_cod ? '到付' : (s.payment_type || ''),
      cod: s.is_cod ? Number(s.cod_amount) || 0 : 0,
      collect: Number(s.collect_amount) || 0,
      lat: s.lat, lng: s.lng, geocode_status: s.geocode_status,
      remark: s.remark || '',
      notFound: !d.shipment_id,
    };
  });
}

// 一位司機一張工作表
function buildSheet(driverName, date, rows) {
  const withPhone = can('admin');
  const pieces = rows.reduce((a, r) => a + r.actual_pieces, 0);
  const money = rows.reduce((a, r) => a + r.cod + r.collect, 0);

  const cols = [
    ['順序', 6, (r, i) => r.stop ?? i + 1],
    ['快遞', 8, r => r.carrier],
    ['單號', 16, r => r.waybill_no],
    ['寄件人', 14, r => r.sender],
    ['收件人', 16, r => r.receiver],
    ...(withPhone ? [['電話', 13, r => r.phone]] : []),
    ['地址', 36, r => r.address],
    ['備註', 20, r => r.remark],
    ['系統件數', 8, r => r.system_pieces ?? ''],
    ['出車件數', 8, r => r.actual_pieces],
    ['付款', 10, r => (r.notFound ? '版單查無此號' : r.payment)],
    ['到付金額', 9, r => r.cod || ''],
    ['代收款', 9, r => r.collect || ''],
    ['簽收', 10, () => ''],
  ];

  const aoa = [
    [`${driverName}　${date}　出車清單`],
    [`共 ${rows.length} 筆、${pieces} 件${money ? `，到付／代收合計 $${money.toLocaleString()}` : ''}`],
    [],
    cols.map(c => c[0]),
    ...rows.map((r, i) => cols.map(c => c[2](r, i))),
  ];

  // 防止 Excel 公式注入：文字開頭是 = + - @ 的，前面加 ' 當成純文字
  const safeAoa = aoa.map(r => r.map(v => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v)));
  const ws = XLSX.utils.aoa_to_sheet(safeAoa);
  const last = cols.length - 1;
  ws['!cols'] = cols.map(c => ({ wch: c[1] }));
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: last } }, { s: { r: 1, c: 0 }, e: { r: 1, c: last } }];
  return ws;
}

const safe = s => String(s).replace(/[\\/?*[\]:]/g, '').slice(0, 31) || '司機';

// drivers: [{ id, name, rows? }]，rows 有給就直接用（例如依路線排序後）
export async function downloadDriversExcel(date, drivers) {
  const wb = XLSX.utils.book_new();
  for (const d of drivers) {
    const rows = d.rows || await fetchDriverStops(date, d.id);
    if (!rows.length) continue;
    XLSX.utils.book_append_sheet(wb, buildSheet(d.name, date, rows), safe(d.name));
  }
  if (!wb.SheetNames.length) throw new Error('沒有出車資料');
  const name = drivers.length === 1 ? `出車清單_${date}_${drivers[0].name}.xlsx` : `出車清單_${date}.xlsx`;
  XLSX.writeFile(wb, name);
}
