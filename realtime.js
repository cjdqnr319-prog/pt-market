/* =========================================================
 * realtime.js — 실시간 동기화 계층
 *   - Firebase Realtime Database (firebase-config.js 설정 시)
 *   - 로컬 모드 (설정이 없거나 ?local=1): localStorage + 탭 간 이벤트
 *   - 1인 오프라인 모드 (?solo=1): 이 기기 안에서만
 *  공통 API (경로는 rooms/{code} 기준 상대 경로)
 *   room.on(cb)            전체 방 데이터 구독
 *   room.set(path, v)      덮어쓰기 (null = 삭제)
 *   room.update(path, obj) 다중 경로 업데이트 {"a/b": 1, "c": null}
 *   room.txn(path, fn)     트랜잭션 → {committed, value}  (fn 이 undefined 반환 시 중단)
 *   room.now()             서버 보정 시각(ms)
 * ========================================================= */
(function (global) {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const split = p => String(p || '').split('/').filter(Boolean);

  function getAt(obj, parts) { let o = obj; for (const k of parts) { if (o == null || typeof o !== 'object') return null; o = o[k]; } return o === undefined ? null : o; }
  function prune(obj) { // 빈 객체 정리 (Firebase 와 같은 동작)
    if (obj == null || typeof obj !== 'object') return obj;
    for (const k of Object.keys(obj)) { obj[k] = prune(obj[k]); if (obj[k] == null || (typeof obj[k] === 'object' && !Array.isArray(obj[k]) && !Object.keys(obj[k]).length)) delete obj[k]; }
    return obj;
  }
  function setAt(root, parts, val) {
    if (!parts.length) return val == null ? {} : clone(val);
    root = root && typeof root === 'object' ? root : {};
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
    const last = parts[parts.length - 1];
    if (val == null) delete o[last]; else o[last] = clone(val);
    return root;
  }

  // ───────────────────────── 로컬 백엔드
  function LocalRoom(code, ns) {
    const key = `ptm:${ns}:${code}`;
    const subs = [];
    const read = () => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; } };
    const write = (data) => { localStorage.setItem(key, JSON.stringify(prune(data))); emit(); };
    let bc = null;
    try { bc = new BroadcastChannel(key); bc.onmessage = () => emit(true); } catch (e) { /* 미지원 */ }
    const emit = (remote) => { const d = read(); subs.forEach(cb => cb(d)); if (!remote && bc) bc.postMessage(1); };
    window.addEventListener('storage', e => { if (e.key === key && !bc) emit(true); });
    const lock = (fn) => (navigator.locks && navigator.locks.request) ? navigator.locks.request(key, async () => fn()) : Promise.resolve(fn());
    this.mode = ns === 'solo' ? 'solo' : 'local';
    this.code = code;
    this.now = () => Date.now();
    this.on = cb => { subs.push(cb); setTimeout(() => cb(read()), 0); return () => subs.splice(subs.indexOf(cb), 1); };
    this.get = async path => getAt(read(), split(path));
    this.set = (path, val) => lock(() => write(setAt(read(), split(path), val)));
    this.update = (path, obj) => lock(() => {
      let d = read(); const base = split(path);
      Object.entries(obj).forEach(([k, v]) => { d = setAt(d, base.concat(split(k)), v); });
      write(d);
    });
    this.txn = (path, fn) => lock(() => {
      const d = read(); const parts = split(path);
      const cur = clone(getAt(d, parts));
      const next = fn(cur);
      if (next === undefined) return { committed: false, value: cur };
      write(setAt(d, parts, next));
      return { committed: true, value: next };
    });
    this.exists = async () => Object.keys(read()).length > 0;
  }

  // ───────────────────────── Firebase 백엔드
  function FireRoom(code) {
    const db = firebase.database();
    const base = db.ref('rooms/' + code);
    let offset = 0;
    db.ref('.info/serverTimeOffset').on('value', s => { offset = s.val() || 0; });
    const ref = p => split(p).length ? base.child(split(p).join('/')) : base;
    this.mode = 'firebase';
    this.code = code;
    this.now = () => Date.now() + offset;
    this.on = cb => { const h = s => cb(s.val() || {}); base.on('value', h); return () => base.off('value', h); };
    this.get = async path => (await ref(path).once('value')).val();
    this.set = (path, val) => ref(path).set(val == null ? null : val);
    this.update = (path, obj) => ref(path).update(obj);
    this.txn = async (path, fn) => {
      const r = await ref(path).transaction(cur => { const n = fn(clone(cur)); return n; }, undefined, false);
      return { committed: r.committed, value: r.snapshot.val() };
    };
    this.exists = async () => (await base.child('meta').once('value')).exists();
    // 연결 상태
    this.onConn = cb => db.ref('.info/connected').on('value', s => cb(!!s.val()));
  }

  const RT = {
    backend() {
      if (qs.get('solo') === '1') return 'solo';
      if (qs.get('local') === '1') return 'local';
      if (global.FIREBASE_CONFIG && global.firebase && global.firebase.database) return 'firebase';
      return 'local';
    },
    connect(code) {
      const b = RT.backend();
      if (b === 'firebase') {
        if (!firebase.apps.length) firebase.initializeApp(global.FIREBASE_CONFIG);
        return new FireRoom(code);
      }
      return new LocalRoom(code, b);
    },
    label() {
      const b = RT.backend();
      return b === 'firebase' ? '🟢 온라인(Firebase)' : b === 'solo' ? '🟠 오프라인 1인 모드' : '🟡 로컬 모드(이 브라우저 탭끼리만)';
    },
    newCode() { return String(Math.floor(1000 + Math.random() * 9000)); },
  };
  global.RT = RT;
})(window);
