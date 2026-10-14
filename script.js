'use strict';
// ===== 設定 =====
const XLSX_FILE = 'AED.xlsx';
const CANDIDATES = 5;      // 直線距離上位N件を道路距離で再評価
const WALK_M_PER_MIN = 80; // 徒歩速度(m/分)
const ROUTE_API = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';

let map, aeds = [], origin = null, originMarker, layer;
const $ = id => document.getElementById(id);
const setStatus = (t, err) => { const s = $('status'); s.textContent = t; s.className = err ? 'error' : ''; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ===== 地図初期化 =====
map = L.map('map').setView([34.6937, 135.5022], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
layer = L.layerGroup().addTo(map);
map.on('click', e => search(e.latlng.lat, e.latlng.lng));

// ===== Excel読み込み =====
async function loadAEDs() {
  try {
    const res = await fetch(XLSX_FILE);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const wb = XLSX.read(await res.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    aeds = rows.map(r => ({
      name: r['名称'], address: r['住所'], place: r['設置場所'],
      hours: String(r['利用可能時間'] ?? '').trim(), note: r['備考'],
      lat: parseFloat(r['緯度']), lng: parseFloat(r['経度'])
    })).filter(a => a.name && isFinite(a.lat) && isFinite(a.lng));
    drawAll();
    setStatus(`AED ${aeds.length} 件を読み込みました。現在地ボタンか地図タップで検索できます。`);
    if (aeds.length) map.fitBounds(L.latLngBounds(aeds.map(a => [a.lat, a.lng])).pad(0.2));
  } catch (e) {
    setStatus('AED.xlsx を読み込めません。GitHub Pages等のWebサーバ経由で開いてください(file://では不可)。', true);
  }
}

const icon = best => L.divIcon({ className: 'aed-icon' + (best ? ' best' : ''), html: 'AED', iconSize: [34, 22] });
function drawAll() { aeds.forEach(a => L.marker([a.lat, a.lng], { icon: icon(), title: a.name }).bindPopup(popup(a)).addTo(map)); }
const popup = a => `<b>${esc(a.name)}</b><br>${esc(a.address)}<br>設置場所: ${esc(a.place) || '-'}<br>利用時間: ${esc(a.hours) || '不明'}`;

// ===== 利用可能時間判定 =====
function isOpen(hours, now = new Date()) {
  if (!hours || /24\s*時間|終日|常時/.test(hours)) return true;
  const m = hours.match(/(\d{1,2}):(\d{2})\s*[-~〜–ー]\s*(\d{1,2}):(\d{2})/);
  if (!m) return true; // 解釈不能なら利用可能扱い
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = +m[1] * 60 + +m[2], e = +m[3] * 60 + +m[4];
  return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e;
}

// ===== 距離計算 =====
function haversine(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function walkRoute(lat1, lng1, lat2, lng2) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`${ROUTE_API}${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await res.json();
    const r = j.routes[0];
    return { dist: r.distance, geometry: r.geometry.coordinates.map(c => [c[1], c[0]]), real: true };
  } catch {
    const d = haversine(lat1, lng1, lat2, lng2) * 1.3; // 迂回係数
    return { dist: d, geometry: [[lat1, lng1], [lat2, lng2]], real: false };
  }
}

// ===== 検索 =====
async function search(lat, lng) {
  if (!aeds.length) return setStatus('AEDデータがありません。', true);
  origin = { lat, lng };
  layer.clearLayers();
  L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(layer).bindTooltip('出発地点');
  setStatus('最短経路を計算中…');
  $('result').innerHTML = ''; $('list').innerHTML = '';

  const onlyOpen = $('onlyOpen').checked;
  let pool = aeds.map(a => ({ ...a, open: isOpen(a.hours), straight: haversine(lat, lng, a.lat, a.lng) }));
  if (onlyOpen) pool = pool.filter(a => a.open);
  if (!pool.length) return setStatus('現在利用可能なAEDが見つかりません。チェックを外して再検索してください。', true);

  const cands = pool.sort((a, b) => a.straight - b.straight).slice(0, CANDIDATES);
  const routes = await Promise.all(cands.map(a => walkRoute(lat, lng, a.lat, a.lng)));
  const res = cands.map((a, i) => ({ ...a, ...routes[i] })).sort((a, b) => a.dist - b.dist);
  const best = res[0];

  res.slice(1).forEach(r => L.marker([r.lat, r.lng], { icon: icon() }).bindPopup(popup(r)).addTo(layer));
  L.marker([best.lat, best.lng], { icon: icon(true), zIndexOffset: 1000 }).bindPopup(popup(best)).addTo(layer);
  const line = L.polyline(best.geometry, { color: '#d50000', weight: 6, opacity: .85, dashArray: best.real ? null : '8 8' }).addTo(layer);
  map.fitBounds(line.getBounds().pad(0.3));

  const min = d => Math.max(1, Math.round(d / WALK_M_PER_MIN));
  const fmt = d => d >= 1000 ? (d / 1000).toFixed(2) + ' km' : Math.round(d) + ' m';
  const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${best.lat},${best.lng}&travelmode=walking`;
  $('result').innerHTML = `<div class="best"><h2>最寄りのAED</h2>
    <div><b>${esc(best.name)}</b>${badge(best)}</div>
    <div class="big">${fmt(best.dist)} / 徒歩約${min(best.dist)}分</div>
    <small>${esc(best.address)}<br>設置場所: ${esc(best.place) || '-'}<br>利用時間: ${esc(best.hours) || '不明'}</small>
    <a href="${gmaps}" target="_blank" rel="noopener">Googleマップでナビ開始</a></div>`;
  $('list').innerHTML = res.map((r, i) => `<li data-i="${i}" class="${i ? '' : 'sel'}"><b>${i + 1}. ${esc(r.name)}</b>${badge(r)}<small>${fmt(r.dist)}・徒歩約${min(r.dist)}分</small></li>`).join('');
  $('list').onclick = e => { const li = e.target.closest('li'); if (li) { const r = res[li.dataset.i]; map.setView([r.lat, r.lng], 17); L.popup().setLatLng([r.lat, r.lng]).setContent(popup(r)).openOn(map); } };
  setStatus(best.real ? '道路ネットワークに基づく徒歩ルートです。' : '※経路APIに接続できないため、直線距離×1.3の概算です(点線)。', !best.real);
}
const badge = a => `<span class="badge ${a.open ? '' : 'closed'}">${a.open ? '利用可' : '時間外'}</span>`;

// ===== 現在地 =====
$('btnLocate').onclick = () => {
  if (!navigator.geolocation) return setStatus('このブラウザは位置情報に対応していません。地図をタップして指定してください。', true);
  const b = $('btnLocate'); b.disabled = true; setStatus('現在地を取得中…');
  navigator.geolocation.getCurrentPosition(
    p => { b.disabled = false; search(p.coords.latitude, p.coords.longitude); },
    () => { b.disabled = false; setStatus('現在地を取得できません。地図をタップして出発地点を指定してください。', true); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};
$('onlyOpen').onchange = () => origin && search(origin.lat, origin.lng);

loadAEDs();
