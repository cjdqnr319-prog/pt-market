/* =========================================================
 * ui.js — 공통 UI: DOM 헬퍼, 효과음, 토스트, 모달, 평택 중심 지도
 * ========================================================= */
(function (global) {
  'use strict';
  const MD = global.MD, E = global.E;
  const UI = {};

  UI.$ = (s, r = document) => r.querySelector(s);
  UI.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  UI.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  UI.gColor = g => (MD.groupById(g) || {}).color || '#888';
  UI.gName = (room, g) => {
    const G = MD.groupById(g); const n = room && room.groups && room.groups[g] && room.groups[g].name;
    return G ? (n ? `${G.no}모둠 ${n}` : `${G.no}모둠`) : g;
  };
  UI.tags = o => (o.cold ? '<span class="tag cold">🧊냉장</span>' : '') + (o.haz ? '<span class="tag haz">☢️위험물</span>' : '') + (o.vip ? '<span class="tag vip">⭐VIP</span>' : '');

  // ───────────── 효과음 (WebAudio, 파일 없이)
  let ac = null, muted = false;
  UI.setMuted = m => { muted = m; };
  UI.unlockAudio = () => { try { ac = ac || new (global.AudioContext || global.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) { } };
  const tone = (f, t0, dur, type = 'sine', vol = .18) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, ac.currentTime + t0);
    g.gain.setValueAtTime(0, ac.currentTime + t0);
    g.gain.linearRampToValueAtTime(vol, ac.currentTime + t0 + .01);
    g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + t0 + dur);
    o.connect(g).connect(ac.destination); o.start(ac.currentTime + t0); o.stop(ac.currentTime + t0 + dur + .05);
  };
  UI.sfx = name => {
    if (muted || !ac) return;
    try {
      ({
        ding: () => { tone(1320, 0, .35); tone(1760, .06, .4, 'sine', .1); },
        take: () => { tone(520, 0, .12, 'triangle'); tone(780, .08, .18, 'triangle'); },
        good: () => { tone(660, 0, .12); tone(880, .1, .12); tone(1320, .2, .25); },
        bad: () => { tone(300, 0, .25, 'sawtooth', .1); tone(220, .18, .35, 'sawtooth', .1); },
        alert: () => { [0, .22, .44].forEach(t => tone(880, t, .16, 'square', .09)); },
        vip: () => { [0, .1, .2, .3].forEach((t, i) => tone(700 + i * 180, t, .2, 'triangle', .14)); },
        tick: () => tone(1000, 0, .05, 'square', .05),
        depart: () => { tone(220, 0, .3, 'sawtooth', .07); tone(330, .15, .3, 'sawtooth', .07); },
      }[name] || (() => { }))();
    } catch (e) { }
  };

  // ───────────── 토스트 / 모달
  UI.toast = (html, { color, ms = 3200 } = {}) => {
    let box = UI.$('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast'; t.innerHTML = html;
    if (color) t.style.borderLeftColor = color;
    box.appendChild(t);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
  };
  UI.modal = (html, buttons = [{ label: '확인', cls: 'primary', value: true }]) => new Promise(res => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">${html}<div class="row">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${b.label}</button>`).join('')}</div></div>`;
    bg.addEventListener('click', e => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i != null) { bg.remove(); res(buttons[+i].value); }
    });
    document.body.appendChild(bg);
    const first = bg.querySelector('input,textarea'); if (first) first.focus();
  });
  UI.confirm = (title, body, okLabel = '확인', cls = 'primary') => UI.modal(`<h3>${title}</h3><div class="muted" style="line-height:1.6">${body}</div>`, [{ label: '취소', value: false }, { label: okLabel, cls, value: true }]);

  // ───────────── 평택 중심 지도
  const LON0 = 125.7, LAT0 = 38.75, KX = 100, KY = 124;
  const P = (lon, lat) => [(lon - LON0) * KX, (LAT0 - lat) * KY];
  const KOREA = [
    [126.55, 37.77], [126.75, 37.95], [127.2, 38.05], [127.8, 38.3], [128.35, 38.6], [128.6, 38.2], [128.9, 37.8], [129.2, 37.4],
    [129.35, 37.0], [129.45, 36.5], [129.4, 36.05], [129.57, 35.98], [129.42, 35.5], [129.2, 35.15], [128.95, 35.05], [128.6, 34.9],
    [128.4, 34.85], [127.9, 34.75], [127.6, 34.65], [127.3, 34.5], [126.95, 34.4], [126.55, 34.3], [126.4, 34.55], [126.3, 34.9],
    [126.42, 35.3], [126.62, 35.6], [126.55, 35.95], [126.62, 36.2], [126.48, 36.5], [126.15, 36.78], [126.45, 36.95], [126.82, 36.93],
    [126.72, 37.2], [126.6, 37.45], [126.55, 37.77],
  ];
  const SEA = {
    '목포': [[126.83, 36.97], [125.95, 36.85], [125.85, 35.6], [126.05, 34.9], [126.39, 34.81]],
    '제주': [[126.83, 36.97], [125.95, 36.85], [125.85, 35.6], [125.95, 34.3], [126.45, 33.62]],
    '부산': [[126.83, 36.97], [125.95, 36.85], [125.85, 35.6], [125.95, 34.2], [127.0, 34.05], [128.3, 34.5], [129.05, 35.1]],
  };
  const polyLen = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
  const along = (pts, f) => {
    f = Math.max(0, Math.min(1, f));
    const L = polyLen(pts) * f; let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc + seg >= L) { const t = seg ? (L - acc) / seg : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
      acc += seg;
    }
    return pts[pts.length - 1];
  };
  const quad = (a, b, bend, n = 24) => { // 곡선 → 점 목록
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const c = [mx - dy / L * bend, my + dx / L * bend];
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]); }
    return pts;
  };
  const toD = pts => 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');

  UI.buildRoutes = () => {
    const O = P(MD.ORIGIN.lon, MD.ORIGIN.lat);
    const R = {};
    Object.entries(MD.DEST).forEach(([name, d]) => {
      const X = P(d.lon, d.lat);
      R[name] = {
        pos: X,
        truck: d.road ? [O, X] : null,
        rail: d.rail ? quad(O, X, 10) : null,
        air: d.air ? quad(O, X, -Math.max(40, Math.hypot(X[0] - O[0], X[1] - O[1]) * .28)) : null,
        sea: d.sea ? SEA[name].map(p => P(p[0], p[1])) : null,
      };
    });
    return { O, R };
  };

  UI.Map = function (host, { showLabels = true } = {}) {
    const { O, R } = UI.buildRoutes();
    const land = toD(KOREA.map(p => P(p[0], p[1]))) + 'Z';
    const jeju = P(126.55, 33.38);
    const routes = Object.entries(R).map(([n, r]) =>
      (r.truck ? `<path class="route-road" d="${toD(r.truck)}"/>` : '') +
      (r.rail ? `<path class="route-rail" d="${toD(r.rail)}"/>` : '') +
      (r.sea ? `<path class="route-sea" d="${toD(r.sea)}"/>` : '') +
      (r.air ? `<path class="route-air" d="${toD(r.air)}"/>` : '')).join('');
    const dests = Object.entries(R).map(([n, r]) => {
      const [x, y] = r.pos; const lx = n === '인천' ? -12 : 12, anchor = n === '인천' ? 'end' : 'start';
      return `<g class="dest" data-d="${n}"><circle cx="${x}" cy="${y}" r="6"/>${showLabels ? `<text x="${x + lx}" y="${y + 5}" text-anchor="${anchor}">${n}</text>` : ''}</g>`;
    }).join('');
    host.innerHTML = `<svg class="map-svg" viewBox="10 20 400 680" preserveAspectRatio="xMidYMid meet">
      <rect class="sea-bg" x="0" y="0" width="420" height="720"/>
      <path class="land" d="${land}"/>
      <ellipse class="land" cx="${jeju[0]}" cy="${jeju[1]}" rx="36" ry="20"/>
      <g>${routes}</g>
      <g id="mapFx"></g>
      <g>${dests}</g>
      <g class="hub"><circle cx="${O[0]}" cy="${O[1]}" r="10"/><text x="${O[0] + 15}" y="${O[1] + 5}">평택 창고</text></g>
      <g id="mapVeh"></g>
      <g id="mapSnow"></g>
      <text id="mapInfo" x="20" y="45" fill="#8d9aab" font-size="13"></text>
    </svg>`;
    const veh = host.querySelector('#mapVeh'), fx = host.querySelector('#mapFx'), snowG = host.querySelector('#mapSnow');
    const flakes = Array.from({ length: 50 }, () => ({ x: Math.random() * 420, y: Math.random() * 720, s: .4 + Math.random() * 1.2, r: 1 + Math.random() * 1.8 }));

    // room 전체 스냅샷과 현재 시각으로 차량 위치 그리기
    this.draw = (room, now, onlyG) => {
      const st = room.state || {};
      const rid = st.round; const Rd = MD.roundById(rid);
      if (!Rd || !room.market || !room.market[rid]) { veh.innerHTML = ''; fx.innerHTML = ''; snowG.innerHTML = ''; return; }
      const clock = E.clockOf(st, now);
      const fin = E.isFinished(room, rid);
      let v = '', f = '';
      const popups = E.popupList(room, rid);
      popups.filter(p => p.type === 'roadblock' && clock >= p.at && clock < p.until).forEach(p => {
        const [x, y] = R[p.dest].pos; f += `<text x="${x - 9}" y="${y - 10}" font-size="18">🚧</text>`;
      });
      MD.GROUPS.forEach((G, gi) => {
        if (onlyG && G.id !== onlyG) return;
        if (!(room.groups && room.groups[G.id])) return;
        const gr = E.groupRound({ room, g: G.id, rid, clock: fin ? MD.TIME.CLOSE : clock, finished: false });
        const off = (gi - 2.5) * 3.2;
        gr.disps.forEach(d => {
          const r = R[d.dest]; if (!r) return;
          let pts, frac, icon;
          if (d.mode === 'truck') {
            if (clock < d.depart || clock >= d.effRet) return;
            pts = r.truck; icon = E.truckIcon(d.truck);
            frac = clock < d.effArrive ? (clock - d.depart) / (d.effArrive - d.depart) : 1 - (clock - d.effArrive) / (d.effRet - d.effArrive);
            const broken = popups.some(p => p.type === 'breakdown' && clock >= p.at && clock < p.until && E.arr(p.targets).some(t => t.g === G.id && t.truck === d.truck));
            if (broken) icon = '🔧';
          } else {
            if (clock < d.depart || clock >= d.effArrive) return;
            pts = r[d.mode]; icon = MD.MODES[d.mode].icon;
            frac = (clock - d.depart) / (d.effArrive - d.depart);
          }
          if (!pts) return;
          const [x, y] = along(pts, frac);
          v += `<g class="veh" transform="translate(${(x + off).toFixed(1)},${(y + off * .6).toFixed(1)})"><circle r="9.5" fill="${G.color}" stroke="#0a0e13" stroke-width="2"/><text text-anchor="middle" y="4">${icon}</text></g>`;
          // 도착 순간 파동
          const since = clock - d.effArrive;
          if (since >= 0 && since < .35) {
            const late = d.oids.some(oid => gr.byId[oid] && d.effArrive > gr.byId[oid].deadline + 1e-6);
            const rr = 8 + since * 80;
            f += `<circle cx="${r.pos[0]}" cy="${r.pos[1]}" r="${rr.toFixed(1)}" fill="none" stroke="${late ? '#ef4444' : '#22c55e'}" stroke-width="3" opacity="${(1 - since / .35).toFixed(2)}"/>`;
          }
        });
      });
      veh.innerHTML = v; fx.innerHTML = f;
      if (Rd.snow) {
        const t = now / 1000;
        snowG.innerHTML = flakes.map(fl => `<circle class="snow" cx="${((fl.x + Math.sin(t * fl.s + fl.y) * 8) % 420).toFixed(1)}" cy="${((fl.y + t * 22 * fl.s) % 720).toFixed(1)}" r="${fl.r.toFixed(1)}"/>`).join('');
      } else snowG.innerHTML = '';
    };
  };

  global.UI = UI;
})(window);
