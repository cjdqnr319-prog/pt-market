/* =========================================================
 * engine.js — 시계·배차·계산·판정 (순수 함수 + 호스트 루프)
 *  모든 진행 상황은 DB에 저장된 "기록"(수락·배차·포기·보관·돌발)으로부터
 *  매번 다시 계산한다 → 새로고침·재접속해도 상태가 어긋나지 않는다.
 * ========================================================= */
(function (global) {
  'use strict';
  const MD = global.MD;
  const EPS = 1e-6;
  const E = {};

  // ───────────────────────── 유틸
  E.arr = x => Array.isArray(x) ? x.filter(v => v != null) : Object.values(x || {});
  E.round = n => Math.round(n);
  E.fmt = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('ko-KR');
  E.fmtSigned = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(Math.round(n)).toLocaleString('ko-KR');
  E.fmtStar = s => (Math.round(s * 10) / 10).toFixed(1);
  E.fmtStarDelta = d => (d > 0.001 ? '+' : d < -0.001 ? '−' : '±') + Math.abs(d).toFixed(1);
  E.fmtTime = h => {
    if (h == null || !isFinite(h)) return '--:--';
    let m = Math.round(h * 60);
    const day = Math.floor(m / 1440); m -= day * 1440;
    const s = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    return day > 0 ? '익일 ' + s : s;
  };
  E.fmtDur = h => {
    const m = Math.max(0, Math.round(h * 60));
    return m >= 60 ? Math.floor(m / 60) + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '') : m + '분';
  };
  E.uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  E.clampStars = s => Math.max(MD.STARS.min, Math.min(MD.STARS.max, s));

  // ───────────────────────── 시계
  // state: {phase, round, clockBase, anchorAt, speed}
  E.round0 = state => MD.roundById(state && state.round);
  E.clockOf = (state, now) => {
    if (!state) return MD.TIME.OPEN;
    const base = state.clockBase != null ? state.clockBase : MD.TIME.OPEN;
    if (state.phase !== 'running') return base;
    const R = MD.roundById(state.round);
    const sph = (R && R.secPerHour) || 20;
    const c = base + ((now - state.anchorAt) / 1000 / sph) * (state.speed || 1);
    return Math.min(MD.TIME.CLOSE, Math.max(base, c));
  };
  E.vipWindow = R => MD.TIME.VIP_SEC / ((R && R.secPerHour) || 20);

  // ───────────────────────── 돌발 효과
  E.popupList = (room, rid) => E.arr(room && room.popups && room.popups[rid]).sort((a, b) => a.at - b.at);
  E.railFactor = (popups, t) => popups.some(p => p.type === 'railboost' && t >= p.at - EPS && t < p.until) ? 0.7 : 1;
  E.roadDelay = (popups, dest, t) => popups.some(p => p.type === 'roadblock' && p.dest === dest && t >= p.at - EPS && t < p.until) ? 1 : 0;

  // ───────────────────────── 견적
  // 위탁(철도·선박·항공) 1건 견적. ctx: {snow, popups}
  E.quoteConsign = (order, mode, t, ctx) => {
    const M = MD.MODES[mode], D = MD.DEST[order.dest];
    const d = D && D[mode === 'truck' ? 'road' : mode];
    const res = { mode, ok: false, ppl: M.ppl };
    if (!d) return Object.assign(res, { reason: '노선 없음' });
    if (t >= MD.TIME.LAST_DEPART - EPS) return Object.assign(res, { reason: '영업 종료(22시)' });
    if (mode === 'rail' && t > MD.TIME.RAIL_LAST + EPS) return Object.assign(res, { reason: '철도 마감(18시)' });
    if (mode === 'air') {
      if (ctx.snow) return Object.assign(res, { reason: '폭설 결항' });
      if (order.haz) return Object.assign(res, { reason: '위험물 불가' });
      if (order.ton > M.maxTon) return Object.assign(res, { reason: '3톤 초과' });
    }
    const wf = MD.weightFactor(mode, order.ton);
    let cost = d * M.perKm * wf + M.base + (order.cold ? M.cold : 0);
    if (mode === 'rail') cost *= E.railFactor(ctx.popups || [], t);
    cost = E.round(cost);
    const hours = mode === 'air' ? M.extra + d / M.speed : d / M.speed + M.extra;
    const arrive = t + hours;
    return Object.assign(res, { ok: true, cost, hours, depart: t, arrive, onTime: arrive <= order.deadline + EPS, wf });
  };

  // 트럭 1편(같은 목적지 합적) 견적
  E.quoteTruck = (dest, t, ctx) => {
    const M = MD.MODES.truck, D = MD.DEST[dest];
    const d = D && D.road;
    if (!d) return { ok: false, reason: '도로 없음' };
    const v = ctx.snow ? M.snowSpeed : M.speed;
    const oneWay = d / v;
    const delay = E.roadDelay(ctx.popups || [], dest, t);
    const arrive = t + oneWay + M.load + delay;
    return { ok: true, mode: 'truck', cost: E.round(d * M.perKm + M.base), depart: t, arrive, ret: arrive + oneWay, oneWay, delay, ppl: 1 };
  };

  // 화물이 트럭 k 에 실릴 수 있는가 (적재 상태와 무관한 기본 조건)
  E.truckFits = (order, k) => {
    if (order.haz) return '위험물 트럭 불가';
    if (!MD.DEST[order.dest].road) return '도로 없음';
    if (order.ton > MD.MODES.truck.cap) return '10톤 초과';
    if (order.cold && k !== 't2') return '냉장 화물';
    return null;
  };

  // 참고용 최선 수단 (t_in 에 바로 출발 가정, 정시 가능한 것 중 최대 이익)
  E.bestMode = (order, snow) => {
    const ctx = { snow, popups: [] };
    let best = null;
    const cand = [];
    if (!E.truckFits(order, 't2')) {
      const q = E.quoteTruck(order.dest, order.t_in, ctx);
      if (q.ok) cand.push(Object.assign(q, { onTime: q.arrive <= order.deadline + EPS }));
    }
    ['rail', 'sea', 'air'].forEach(m => cand.push(E.quoteConsign(order, m, order.t_in, ctx)));
    cand.filter(q => q.ok && q.onTime).forEach(q => {
      const p = order.fee - q.cost;
      if (!best || p > best.profit) best = { mode: q.mode, profit: p, cost: q.cost };
    });
    return best;
  };

  // ───────────────────────── 시장 카드 상태
  // 반환: hidden | open | bidding | judging | taken | expired | cancelled
  E.marketStatus = (o, clock, R, finished) => {
    if (o.status === 'taken') return 'taken';
    if (o.status === 'cancelled') return 'cancelled';
    if (o.status === 'expired') return 'expired';
    if (clock < o.t_in - EPS) return 'hidden';
    if (o.status === 'vip') {
      if (finished) return 'expired';
      return clock < o.t_in + E.vipWindow(R) ? 'bidding' : 'judging';
    }
    if (finished || clock >= Math.min(o.deadline, MD.TIME.LAST_DEPART) - EPS) return 'expired';
    return 'open';
  };
  E.marketList = (room, rid) => E.arr(room && room.market && room.market[rid]).sort((a, b) => (a.t_in - b.t_in) || (a.seq || 0) - (b.seq || 0) || (a.id < b.id ? -1 : 1));

  // ───────────────────────── 모둠 라운드 상태 (핵심)
  // args: {room, g, rid, clock, finished}
  E.groupRound = ({ room, g, rid, clock, finished }) => {
    const R = MD.roundById(rid);
    const gd = (room.groups && room.groups[g] && room.groups[g].rd && room.groups[g].rd[rid]) || {};
    const popups = E.popupList(room, rid);
    const ctx = { snow: R.snow, popups };
    const market = (room.market && room.market[rid]) || {};
    const owned = Object.values(market).filter(o => o && o.status === 'taken' && o.owner === g);
    const byId = {}; owned.forEach(o => { byId[o.id] = o; });
    const T = finished ? Infinity : clock;

    // 배차 기록 + 트럭 고장 지연 반영
    const brks = [];
    popups.filter(p => p.type === 'breakdown').forEach(p => E.arr(p.targets).forEach(tg => { if (tg.g === g) brks.push({ truck: tg.truck, at: p.at }); }));
    const disps = Object.entries(gd.disp || {}).map(([id, d]) => {
      const x = Object.assign({ id }, d, { oids: E.arr(d.oids).filter(oid => byId[oid]) });
      x.effArrive = d.arrive; x.effRet = d.ret != null ? d.ret : d.arrive; x.delayed = 0;
      return x;
    }).sort((a, b) => a.depart - b.depart);
    disps.filter(d => d.mode === 'truck').forEach(d => {
      brks.filter(b => b.truck === d.truck).forEach(b => {
        if (b.at >= d.depart - EPS && b.at < d.effArrive) { d.effArrive += 1; d.effRet += 1; d.delayed += 1; }
        else if (b.at >= d.effArrive && b.at < d.effRet) { d.effRet += 1; }
      });
    });

    // 주문별 상태
    const inDisp = {}; disps.forEach(d => d.oids.forEach(oid => { inDisp[oid] = d; }));
    const loads = {};
    ['t1', 't2'].forEach(k => {
      const oids = Object.keys((gd.load && gd.load[k]) || {}).filter(oid => byId[oid] && !inDisp[oid] && !(gd.ord && gd.ord[oid]));
      const tons = oids.reduce((s, oid) => s + byId[oid].ton, 0);
      loads[k] = { oids, tons, dest: oids.length ? byId[oids[0]].dest : null };
    });
    const loadedIn = {}; ['t1', 't2'].forEach(k => loads[k].oids.forEach(oid => { loadedIn[oid] = k; }));
    const orders = owned.map(o => {
      const rec = gd.ord && gd.ord[o.id];
      let st = 'active';
      if (inDisp[o.id]) st = 'dispatched';
      else if (rec && rec.st) st = rec.st;
      else if (loadedIn[o.id]) st = 'loaded';
      return Object.assign({}, o, { st, disp: inDisp[o.id] || null, truck: loadedIn[o.id] || null, rec: rec || null });
    }).sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));

    // 트럭 상태
    const trucks = {};
    ['t1', 't2'].forEach(k => {
      const mine = disps.filter(d => d.mode === 'truck' && d.truck === k);
      let freeAt = MD.TIME.OPEN;
      mine.forEach(d => { freeAt = Math.max(freeAt, d.effRet); });
      // 대기 중 고장 (운행 중 고장은 배차 지연으로 처리됨)
      let brokenUntil = null;
      brks.filter(b => b.truck === k).forEach(b => {
        const during = mine.some(d => b.at >= d.depart - EPS && b.at < d.effRet);
        if (!during) { const until = b.at + 1; freeAt = Math.max(freeAt, until); if (clock >= b.at - EPS && clock < until) brokenUntil = until; }
      });
      const cur = mine.find(d => clock >= d.depart - EPS && clock < d.effRet);
      let status = 'idle', until = null;
      if (cur) { status = clock < cur.effArrive ? 'out' : 'return'; until = cur.effRet; }
      else if (brokenUntil) { status = 'broken'; until = brokenUntil; }
      trucks[k] = { k, type: k === 't1' ? '일반' : '냉장', status, until, cur: cur || null, freeAt, trips: mine.length, load: loads[k] };
    });

    // 자원
    const active = orders.filter(o => o.st === 'active');
    const loaded = orders.filter(o => o.st === 'loaded');
    const stored = orders.filter(o => o.st === 'stored');
    const pplUsed = disps.reduce((s, d) => s + (d.ppl || 0), 0);
    const pplReserved = active.length + ['t1', 't2'].filter(k => loads[k].oids.length).length;
    const pplAvail = R.ppl - pplUsed - pplReserved;
    const spent = disps.reduce((s, d) => s + (d.cost || 0), 0) + stored.length * MD.STORE_COST;
    const budgetLeft = R.budget - spent;
    const activeCount = active.length + loaded.length;

    // 사건(정산) 목록
    const ev = [];
    disps.forEach(d => { if (d.depart <= T + EPS) ev.push({ t: d.depart, type: 'cost', amt: -d.cost, disp: d }); });
    orders.forEach(o => {
      const price = o.price || 0;
      if (o.st === 'dispatched') {
        const d = o.disp, t = d.effArrive;
        if (t <= T + EPS) {
          const lateH = t - o.deadline;
          if (lateH > EPS) {
            const pen = E.round(Math.ceil(lateH - EPS) * MD.LATE_RATE * price);
            ev.push({ t, type: 'late', o, amt: price - pen, rev: price, pen, star: MD.STARS.late, lateH });
          } else {
            ev.push({ t, type: 'ontime', o, amt: price, rev: price, pen: 0, star: o.vip ? MD.STARS.vipOnTime : MD.STARS.onTime });
          }
        }
      } else if (o.st === 'abandoned') {
        const pen = E.round(price * MD.ABANDON_RATE);
        ev.push({ t: o.rec.at, type: 'abandon', o, amt: -pen, pen, star: MD.STARS.abandon });
      } else if (o.st === 'stored') {
        ev.push({ t: o.rec.at, type: 'store', o, amt: -MD.STORE_COST });
      } else if (finished) { // 폐장까지 출발 못 한 화물 = 자동 포기
        const pen = E.round(price * MD.ABANDON_RATE);
        ev.push({ t: MD.TIME.CLOSE, type: 'abandon', auto: true, o, amt: -pen, pen, star: MD.STARS.abandon });
      }
    });
    ev.sort((a, b) => a.t - b.t);
    const sum = f => ev.reduce((s, e) => s + (f(e) || 0), 0);
    const revenue = sum(e => e.rev);
    const cost = sum(e => e.type === 'cost' || e.type === 'store' ? -e.amt : 0);
    const penalty = sum(e => e.pen);
    const profit = sum(e => e.amt);
    const starDelta = Math.round(sum(e => e.star) * 100) / 100;
    const onTime = ev.filter(e => e.type === 'ontime').length;
    const late = ev.filter(e => e.type === 'late').length;
    const abandoned = ev.filter(e => e.type === 'abandon').length;

    return {
      R, g, rid, gd, ctx, orders, byId, disps, loads, trucks, active, loaded, stored,
      pplTotal: R.ppl, pplUsed, pplReserved, pplAvail, budget: R.budget, spent, budgetLeft,
      activeCount, events: ev, revenue, cost, penalty, profit, starDelta, onTime, late, abandoned,
      onTimeRate: onTime + late ? onTime / (onTime + late) : null, memo: gd.memo || '',
    };
  };

  // 라운드 완료 여부
  E.isFinished = (room, rid) => !!(room.state && room.state.done && room.state.done[rid]) ||
    (room.state && room.state.round === rid && ['settle', 'final'].includes(room.state.phase));

  // 모둠 누적 요약 (별점·현금 = 튜토리얼 제외 누적)
  E.groupTotals = (room, g, now) => {
    const state = room.state || {};
    const clock = E.clockOf(state, now);
    let stars = MD.STARS.start, cash = 0;
    const per = {};
    MD.ROUNDS.forEach(R => {
      const started = room.market && room.market[R.id];
      if (!started) return;
      const fin = E.isFinished(room, R.id);
      if (!fin && state.round !== R.id) return;
      const gr = E.groupRound({ room, g, rid: R.id, clock: state.round === R.id ? clock : MD.TIME.CLOSE, finished: fin });
      per[R.id] = gr;
      if (!R.tutorial) { stars += gr.starDelta; cash += gr.profit; }
    });
    const cur = per[state.round];
    const curR = MD.roundById(state.round);
    const shownStars = curR && curR.tutorial && cur ? MD.STARS.start + cur.starDelta : stars;
    return { stars: E.clampStars(stars), shownStars: E.clampStars(shownStars), cash, per, cur };
  };

  // 라운드 시작 시점 별점 → 배송료 배수
  E.starsBefore = (room, g, rid) => {
    let s = MD.STARS.start;
    for (const R of MD.ROUNDS) {
      if (R.id === rid) break;
      if (R.tutorial || !(room.market && room.market[R.id]) || !E.isFinished(room, R.id)) continue;
      s += E.groupRound({ room, g, rid: R.id, clock: MD.TIME.CLOSE, finished: true }).starDelta;
    }
    return E.clampStars(s);
  };
  E.multFor = (room, g, rid) => {
    const R = MD.roundById(rid);
    return R && R.tutorial ? 1 : MD.starMultiplier(E.starsBefore(room, g, rid));
  };

  // ───────────────────────── 모의 적용(가능 여부 판정)
  // gr 을 기반으로 gd 를 바꿔 본 뒤 자원이 음수가 되는지 확인
  E.simulate = (room, g, rid, clock, mutate) => {
    const copy = JSON.parse(JSON.stringify(room));
    copy.groups = copy.groups || {};
    copy.groups[g] = copy.groups[g] || {};
    copy.groups[g].rd = copy.groups[g].rd || {};
    copy.groups[g].rd[rid] = copy.groups[g].rd[rid] || {};
    mutate(copy.groups[g].rd[rid], copy);
    return E.groupRound({ room: copy, g, rid, clock, finished: false });
  };

  // 수락 가능한 수단 목록 (지금 기준)
  E.acceptModes = (order, gr, clock) => {
    const out = [];
    const ctx = gr.ctx;
    // 트럭: 맞는 트럭이 지금 대기 중(고장 X)이고, 적재 중이면 같은 목적지·용량 OK
    const truckWhy = [];
    ['t1', 't2'].forEach(k => {
      const why = E.truckFits(order, k);
      if (why) return;
      const tk = gr.trucks[k];
      const ld = tk.load;
      if (tk.freeAt > clock + EPS) { truckWhy.push(`${tk.type} 트럭 ${tk.status === 'broken' ? '고장' : '운행 중'} (복귀 ${E.fmtTime(tk.freeAt)})`); return; }
      if (ld.oids.length && ld.dest !== order.dest) { truckWhy.push(`${tk.type} 트럭에 ${ld.dest}행 적재 중`); return; }
      if (ld.tons + order.ton > MD.MODES.truck.cap + EPS) { truckWhy.push(`${tk.type} 트럭 적재 초과`); return; }
      const q = E.quoteTruck(order.dest, clock, ctx);
      if (q.ok && clock < MD.TIME.LAST_DEPART) out.push(Object.assign(q, { truck: k, cost: ld.oids.length ? 0 : q.cost }));
    });
    ['rail', 'sea', 'air'].forEach(m => {
      const q = E.quoteConsign(order, m, clock, ctx);
      if (q.ok) out.push(q);
    });
    return { modes: out, truckWhy };
  };

  E.canAccept = (room, g, rid, order, clock) => {
    const R = MD.roundById(rid);
    if (!room.state || room.state.phase !== 'running') return { ok: false, why: '진행 중이 아님' };
    if (clock >= MD.TIME.LAST_DEPART - EPS) return { ok: false, why: '영업 종료(22시)' };
    const gr = E.groupRound({ room, g, rid, clock, finished: false });
    if (gr.activeCount >= MD.ACTIVE_LIMIT) return { ok: false, why: `처리 한도 ${MD.ACTIVE_LIMIT}건 꽉 참` };
    if (gr.pplAvail < 1) return { ok: false, why: '인력 부족' };
    if (gr.budgetLeft <= 0) return { ok: false, why: '예산 소진' };
    const { modes, truckWhy } = E.acceptModes(order, gr, clock);
    const usable = modes.filter(q => (q.ppl || 1) <= gr.pplAvail); // 수락 1명 + 선박은 1명 더
    if (!usable.length) {
      const why = truckWhy[0] || (modes.length ? '인력 부족(선박 2명)' : '가능한 수단 없음');
      return { ok: false, why };
    }
    const minCost = Math.min(...usable.map(q => q.cost));
    if (minCost > gr.budgetLeft) return { ok: false, why: `예산 부족(최소 ${minCost})` };
    const best = usable.slice().sort((a, b) => a.cost - b.cost)[0];
    return { ok: true, gr, modes: usable, best, why: '' };
  };

  // ───────────────────────── 돌발 생성 (호스트 전용)
  E.makePopup = (room, rid, type, clock, rand = Math.random) => {
    const R = MD.roundById(rid);
    const P = MD.POPUPS[type];
    const pop = { type, at: clock, until: clock + P.dur, icon: P.icon, title: P.title, desc: P.desc };
    const joined = MD.GROUPS.filter(G => room.groups && room.groups[G.id] && room.groups[G.id].name).map(G => G.id);
    const pick = (list, n) => { const a = list.slice(); const r = []; while (a.length && r.length < n) r.push(a.splice(Math.floor(rand() * a.length), 1)[0]); return r; };
    if (type === 'breakdown') {
      const n = Math.min(joined.length, 2 + Math.floor(rand() * 2));
      pop.targets = pick(joined, n).map(g => {
        // 운행 중인 트럭을 우선 (실린 화물 지연 위험 연출)
        const gr = E.groupRound({ room, g, rid, clock, finished: false });
        const busy = ['t1', 't2'].filter(k => gr.trucks[k].status === 'out');
        const truck = busy.length ? pick(busy, 1)[0] : (rand() < 0.5 ? 't1' : 't2');
        return { g, truck };
      });
      pop.desc = pop.targets.map(t => `${MD.groupById(t.g).no}모둠 ${t.truck === 't1' ? '일반' : '냉장'}`).join(' · ') + ' 트럭 1시간 정지!';
    } else if (type === 'roadblock') {
      const dests = {};
      E.marketList(room, rid).forEach(o => { if (o.t_in >= clock - 2 && MD.DEST[o.dest].road) dests[o.dest] = (dests[o.dest] || 0) + 1; });
      const list = Object.keys(dests).length ? Object.keys(dests) : ['서울', '대전', '인천'];
      pop.dest = pick(list, 1)[0];
      pop.desc = P.desc.replace('{dest}', pop.dest);
    } else if (type === 'cancel') {
      const open = E.marketList(room, rid).filter(o => E.marketStatus(o, clock, R, false) === 'open');
      pop.oids = pick(open, 2).map(o => o.id);
      if (!pop.oids.length) return null;
      pop.desc = '취소: ' + pop.oids.map(id => room.market[rid][id].name).join(', ');
    } else if (type === 'reissue') {
      const cands = [];
      Object.keys(room.groups || {}).forEach(g => {
        const gd = room.groups[g].rd && room.groups[g].rd[rid];
        Object.entries((gd && gd.ord) || {}).forEach(([oid, rec]) => {
          const o = room.market[rid][oid];
          if (rec.st === 'abandoned' && o && !o.reissuedTo && o.deadline > clock + 2) cands.push(o);
        });
      });
      if (!cands.length) return null;
      const src = pick(cands, 1)[0];
      pop.src = src.id;
      pop.desc = `「${src.name}」 ${src.dest}행이 배송료 ${E.round(src.fee * 1.5)}로 재등장!`;
    }
    return pop;
  };

  // ───────────────────────── 호스트 (교사 화면 / 오프라인 1인 모드)
  // db: realtime Room, getRoom(): 최신 room 스냅샷
  E.Host = function (db, getRoom, opts = {}) {
    const busy = new Set();
    const once = async (key, fn) => { if (busy.has(key)) return; busy.add(key); try { await fn(); } catch (e) { console.error(e); } finally { setTimeout(() => busy.delete(key), 1500); } };

    this.tick = () => {
      const room = getRoom();
      if (!room || !room.state) return;
      const st = room.state;
      if (st.phase !== 'running') return;
      const rid = st.round, R = MD.roundById(rid);
      const clock = E.clockOf(st, db.now());

      // 1) 폐장
      if (clock >= MD.TIME.CLOSE - EPS) {
        once('close-' + rid, () => db.update('state', { phase: 'settle', clockBase: MD.TIME.CLOSE, ['done/' + rid]: true }));
        return;
      }
      // 2) 돌발 (시각 고정, 내용 랜덤)
      if (!opts.solo) (R.popupTimes || []).forEach((t, i) => {
        const key = 's' + i;
        if (clock >= t && !(room.popups && room.popups[rid] && room.popups[rid][key])) once('pop-' + rid + key, () => this.firePopup(rid, key, null, clock));
      });
      // 3) VIP 역경매 판정
      E.marketList(room, rid).forEach(o => {
        if (o.status === 'vip' && clock >= o.t_in + E.vipWindow(R)) once('vip-' + o.id, () => this.resolveVip(rid, o.id, clock));
      });
    };

    this.firePopup = async (rid, key, type, clock) => {
      const room = getRoom();
      const used = Object.values((room.popups && room.popups[rid]) || {}).map(p => p.type);
      let deck = type ? [type] : MD.POPUP_DECK.filter(t => !used.includes(t));
      if (!deck.length) deck = MD.POPUP_DECK.slice();
      let pop = null;
      const tries = deck.slice().sort(() => Math.random() - 0.5);
      if (!type) tries.push(...MD.POPUP_DECK.filter(t => !tries.includes(t)));
      for (const t of tries) { pop = E.makePopup(room, rid, t, clock); if (pop) break; }
      if (!pop) return null;
      const r = await db.txn(`popups/${rid}/${key}`, cur => cur ? undefined : pop);
      if (!r.committed) return null;
      if (pop.type === 'cancel') {
        for (const oid of pop.oids) await db.txn(`market/${rid}/${oid}`, cur => cur && cur.status === 'open' ? Object.assign(cur, { status: 'cancelled', cancelAt: clock }) : undefined);
      } else if (pop.type === 'reissue') {
        const src = room.market[rid][pop.src];
        const nid = src.id + '-R';
        const o = Object.assign({}, src, { id: nid, status: 'open', owner: null, price: null, takenAt: null, bids: null, vipWin: null, winStars: null, carried: null, reissuedTo: null, t_in: clock, fee: E.round(src.fee * 1.5), reissued: true, seq: 900, name: '⚡' + src.name.replace(/^[⚡📦]+/, '') });
        await db.update(`market/${rid}`, { [nid]: o, [src.id + '/reissuedTo']: nid });
      }
      return pop;
    };

    this.resolveVip = async (rid, oid, clock) => {
      const room = getRoom();
      const o = room.market[rid][oid];
      const bids = Object.entries(o.bids || {}).map(([g, b]) => ({ g, price: b.price, at: b.at || 0, stars: E.groupTotals(room, g, db.now()).stars }));
      bids.sort((a, b) => a.price - b.price || b.stars - a.stars || a.at - b.at);
      const R = MD.roundById(rid);
      let win = null;
      for (const b of bids) { // 낙찰 시점에도 처리 한도·인력이 되는지 확인
        const gr = E.groupRound({ room, g: b.g, rid, clock, finished: false });
        if (gr.activeCount < MD.ACTIVE_LIMIT && gr.pplAvail >= 1) { win = b; break; }
      }
      await db.txn(`market/${rid}/${oid}`, cur => {
        if (!cur || cur.status !== 'vip') return undefined;
        if (!win) return Object.assign(cur, { status: 'expired', vipResult: 'nobid' });
        return Object.assign(cur, { status: 'taken', owner: win.g, price: win.price, takenAt: o.t_in + E.vipWindow(R), vipWin: true, winStars: win.stars });
      });
    };

    // 라운드 준비 (시장 초기화 + 이월 화물)
    this.prepareRound = async (rid) => {
      const room = getRoom();
      const R = MD.roundById(rid);
      const market = {};
      R.orders.forEach((o, i) => {
        market[o.id] = Object.assign({}, o, { seq: i, status: o.vip && !opts.solo ? 'vip' : 'open', owner: null });
      });
      // 전날 보관(이월) 화물 → 해당 모둠 주문으로 이어받기
      const idx = MD.ROUNDS.findIndex(r => r.id === rid);
      const prev = MD.ROUNDS[idx - 1];
      if (prev && room.market && room.market[prev.id]) {
        Object.keys(room.groups || {}).forEach(g => {
          const gd = room.groups[g].rd && room.groups[g].rd[prev.id];
          Object.entries((gd && gd.ord) || {}).forEach(([oid, rec]) => {
            const src = room.market[prev.id][oid];
            if (rec.st !== 'stored' || !src) return;
            const nid = rid + '-C' + oid.replace(/\W/g, '');
            market[nid] = Object.assign({}, src, {
              id: nid, t_in: MD.TIME.OPEN, deadline: Math.max(MD.TIME.OPEN, src.deadline - 24), status: 'taken', owner: g,
              takenAt: MD.TIME.OPEN, carried: true, seq: -1, name: '📦' + src.name.replace(/^[⚡📦]+/, ''), bids: null,
            });
          });
        });
      }
      const up = {};
      up['market/' + rid] = market;
      up['popups/' + rid] = null;
      Object.keys(room.groups || {}).forEach(g => { up[`groups/${g}/rd/${rid}`] = null; });
      up['state/round'] = rid;
      up['state/phase'] = 'ready';
      up['state/clockBase'] = MD.TIME.OPEN;
      up['state/anchorAt'] = db.now();
      up['state/speed'] = 1;
      up['state/done/' + rid] = null;
      await db.update('', up);
    };

    this.start = () => { const st = getRoom().state; return db.update('state', { phase: 'running', anchorAt: db.now(), clockBase: st.clockBase != null ? st.clockBase : MD.TIME.OPEN }); };
    this.pause = () => { const st = getRoom().state; return db.update('state', { phase: 'paused', clockBase: E.clockOf(st, db.now()) }); };
    this.setSpeed = (speed) => { const st = getRoom().state; return db.update('state', { speed, clockBase: E.clockOf(st, db.now()), anchorAt: db.now() }); };
    this.jump = (h) => { const st = getRoom().state; const c = Math.min(MD.TIME.CLOSE, Math.max(E.clockOf(st, db.now()), h)); return db.update('state', { clockBase: c, anchorAt: db.now() }); };
    this.finishNow = () => { const st = getRoom().state; return db.update('state', { phase: 'settle', clockBase: MD.TIME.CLOSE, ['done/' + st.round]: true }); };
    this.final = () => db.update('state', { phase: 'final' });
    this.lobby = () => db.update('state', { phase: 'lobby' });
  };

  global.E = E;
})(typeof window !== 'undefined' ? window : globalThis);
