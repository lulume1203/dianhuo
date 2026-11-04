// =====================================================
// 司機出車資料：讀取 + 下載 Excel
// =====================================================
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { db } from './app.js';

// 取得某司機某天的出車明細（依刷單順序）
export async function fetchDriverStops(date, driverId) {
  const { data, error } = await db.from('dispatch_items')
    .select(`waybill_no, system_pieces, actual_pieces, created_at, shipment_id,
             dispatch_batches!inner(work_date, driver_id),
             shipments(id, waybill_no, sender, receiver, receiver_phone, address,
                       payment_type, is_cod, cod_amount, collect_amount, lat, lng, geocode_status,
                       carriers(name))`)
    .eq('dispatch_batches.work_date', date)
    .eq('dispatch_batches.driver_id', driverId)
    .order('created_at');
  if (error) throw error;

  return data.map(d => {
    const s = d.shipments || {};
    return {
      shipment_id: d.shipment_id,
      carrier: s.carriers?.name || '',
      waybill_no: d.waybill_no,
      sender: s.sender || '',
      receiver: s.receiver || '',
      phone: s.receiver_phone || '',
      address: s.address || '',
      system_pieces: d.system_pieces,
      actual_pieces: d.actual_pieces,
      payment: s.is_cod ? '到付' : (s.payment_type || ''),
      cod: s.is_cod ? Number(s.cod_amount) || 0 : 0,
      collect: Number(s.collect_amount) || 0,
      lat: s.lat, lng: s.lng, geocode_status: s.geocode_status,
      notFound: !d.shipment_id,
    };
  });
}

// 一位司機一張工作表
function buildSheet(driverName, date, rows) {
  const pieces = rows.reduce((a, r) => a + r.actual_pieces, 0);
  const money = rows.reduce((a, r) => a + r.cod + r.collect, 0);

  const aoa = [
    [`${driverName}　${date}　出車清單`],
    [`共 ${rows.length} 筆、${pieces} 件${money ? `，到付／代收合計 $${money.toLocaleString()}` : ''}`],
    [],
    ['順序', '快遞', '單號', '寄件人', '收件人', '電話', '地址', '系統件數', '出車件數', '付款', '到付金額', '代收款', '簽收'],
    ...rows.map((r, i) => [
      r.stop ?? i + 1,
      r.carrier,
      r.waybill_no,
      r.sender,
      r.receiver,
      r.phone,
      r.address,
      r.system_pieces ?? '',
      r.actual_pieces,
      r.notFound ? '版單查無此號' : r.payment,
      r.cod || '',
      r.collect || '',
      '',
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [6, 8, 16, 14, 16, 13, 36, 8, 8, 10, 9, 9, 10].map(w => ({ wch: w }));
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 12 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 12 } }];
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
