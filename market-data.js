/* =========================================================
 * market-data.js — 평택 물류 관제실 「오늘의 물류 시장」 데이터
 *  - 목적지·수단 규칙·라운드별 주문(t_in 포함)·돌발 덱·별점 규칙
 *  - R1~R3 주문은 market_rounds.json(밸런스 검증본)에서 그대로 옮김
 * ========================================================= */
(function (global) {
  'use strict';

  // ── 평택 창고 기준 거리(km). null = 해당 수단 노선 없음
  // lon/lat 은 지도 표시용 대략 좌표
  const DEST = {
    '서울': { road: 70,  rail: 70,  sea: null, air: null, lon: 126.98, lat: 37.57 },
    '인천': { road: 60,  rail: 60,  sea: null, air: null, lon: 126.66, lat: 37.46 },
    '대전': { road: 100, rail: 100, sea: null, air: null, lon: 127.38, lat: 36.35 },
    '강릉': { road: 270, rail: 270, sea: null, air: null, lon: 128.90, lat: 37.75 },
    '대구': { road: 250, rail: 250, sea: null, air: 300,  lon: 128.60, lat: 35.87 },
    '광주': { road: 240, rail: 240, sea: null, air: 280,  lon: 126.85, lat: 35.16 },
    '부산': { road: 350, rail: 350, sea: 800,  air: 330,  lon: 129.05, lat: 35.16 },
    '목포': { road: 300, rail: 300, sea: 350,  air: null, lon: 126.39, lat: 34.81 },
    '제주': { road: null, rail: null, sea: 500, air: 450,  lon: 126.53, lat: 33.50 },
  };
  const ORIGIN = { name: '평택', lon: 127.11, lat: 36.99, port: { lon: 126.83, lat: 36.97 } };

  // ── 시간 규칙 (게임 시각, 시간 단위)
  const TIME = {
    OPEN: 6,          // 06:00 개장
    LAST_DEPART: 22,  // 22:00 이후 출발 불가
    CLOSE: 24,        // 24:00 폐장·정산
    RAIL_LAST: 18,    // 철도 마지막 편
    VIP_SEC: 10,      // VIP 역경매 실시간 10초
  };

  // ── 수단 규칙 (4차시 이전 검증 모델 유지)
  const MODES = {
    truck: { key: 'truck', icon: '🚚', label: '자사 트럭', speed: 60, snowSpeed: 40, load: 0.5, perKm: 0.5, base: 15, cap: 10, ppl: 1 },
    rail:  { key: 'rail',  icon: '🚆', label: '철도 위탁', speed: 80, extra: 2,   perKm: 0.6,  base: 30, cold: 10, ppl: 1 },
    sea:   { key: 'sea',   icon: '🚢', label: '선박 위탁', speed: 30, extra: 3,   perKm: 0.25, base: 50, cold: 10, ppl: 2 },
    air:   { key: 'air',   icon: '✈️', label: '항공 위탁', speed: 600, extra: 3.5, perKm: 1.2, base: 70, cold: 0,  ppl: 1, maxTon: 3 },
  };
  // 트럭 편성: n = 일반, c = 냉장. 라운드에 fleet 를 주면 그 라운드만 다르게
  const FLEET_DEFAULT = ['n1', 'n2', 'c1'];
  const fleetLabel = f => { const n = f.filter(k => k[0] === 'n').length, c = f.length - n; return `일반${n}·냉장${c}`; };
  const STORE_COST = 20;          // 보관(이월)
  const ABANDON_RATE = 0.3;       // 수락 후 포기 위약 30%
  const LATE_RATE = 0.1;          // 지연 위약 배송료 10%/h
  const ACTIVE_LIMIT = 5;         // 동시 처리 한도 (수락했지만 아직 출발 안 한 주문)

  // 무게계수
  function weightFactor(mode, ton) {
    if (mode === 'rail') return ton < 10 ? 1 : ton < 100 ? 2 : 3;
    if (mode === 'sea') return ton < 100 ? 1 : 1.5;
    if (mode === 'air') return ton < 1 ? 1 : 2;
    return 1;
  }

  // ── 고객 별점 (3라운드 누적, 시작 ★3.0)
  const STARS = {
    start: 3.0, min: 0, max: 5,
    onTime: 0.1, vipOnTime: 0.3, late: -0.3, abandon: -1.0,
  };
  function starMultiplier(stars) {
    if (stars >= 4) return 1.1;
    if (stars >= 3) return 1.0;
    if (stars >= 2) return 0.9;
    return 0.8;
  }

  // ── 모둠 (6개 물류회사)
  const GROUPS = [
    { id: 'g1', no: 1, color: '#ef4444', soft: 'rgba(239,68,68,.22)' },
    { id: 'g2', no: 2, color: '#eab308', soft: 'rgba(234,179,8,.22)' },
    { id: 'g3', no: 3, color: '#22c55e', soft: 'rgba(34,197,94,.22)' },
    { id: 'g4', no: 4, color: '#3b82f6', soft: 'rgba(59,130,246,.22)' },
    { id: 'g5', no: 5, color: '#a855f7', soft: 'rgba(168,85,247,.22)' },
    { id: 'g6', no: 6, color: '#ec4899', soft: 'rgba(236,72,153,.22)' },
  ];

  // ── 돌발 팝업 덱 (라운드당 2개, 시각 고정·내용 랜덤)
  const POPUPS = {
    breakdown: { icon: '🔧', title: '트럭 고장',     dur: 1, desc: '지정 모둠의 트럭 1대가 1시간 멈춥니다. 실린 화물은 1시간 늦어져요.', tip: '위탁 전환 or 대기' },
    roadblock: { icon: '🚧', title: '도로 통제',     dur: 2, desc: '2시간 동안 {dest} 방면 트럭 운행 시간 +1시간.', tip: '철도로 전환하세요' },
    railboost: { icon: '🚆', title: '철도 임시 증편', dur: 1, desc: '1시간 동안 철도 위탁 비용 −30%!', tip: '지금 몰아서 위탁' },
    cancel:    { icon: '📞', title: '취소 전화',     dur: 0.6, desc: '시장에 남아 있던 주문 2건이 취소되었습니다.', tip: '경쟁 완화' },
    reissue:   { icon: '⚡', title: '긴급 재수배',   dur: 0.6, desc: '포기된 주문이 배송료 1.5배로 시장에 다시 나왔습니다!', tip: '남의 포기가 내 기회' },
  };
  const POPUP_DECK = ['breakdown', 'roadblock', 'railboost', 'cancel', 'reissue'];

  // ── 라운드
  const ROUNDS = [
    {
      id: 'R0', name: 'R0 튜토리얼', short: '튜토리얼', tutorial: true, snow: false,
      secPerHour: 10, ppl: 6, budget: 800, storage: false, popupTimes: [],
      story: '조작을 익히는 연습 하루(3분). 돌발·VIP 없음, 기록되지 않습니다.',
      orders: [
        { t_in: 6,  name: '편의점 음료 2톤',   dest: '서울', ton: 2,  cold: false, haz: false, deadline: 12, fee: 126, vip: false },
        { t_in: 6,  name: '택배 합포장 3톤',   dest: '서울', ton: 3,  cold: false, haz: false, deadline: 13, fee: 134, vip: false },
        { t_in: 7,  name: '냉동 아이스크림',   dest: '대전', ton: 2,  cold: true,  haz: false, deadline: 13, fee: 180, vip: false },
        { t_in: 8,  name: '철강 코일 25톤',    dest: '대전', ton: 25, cold: false, haz: false, deadline: 18, fee: 330, vip: false },
        { t_in: 9,  name: '관광 기념품 1톤',   dest: '제주', ton: 1,  cold: false, haz: false, deadline: 36, fee: 240, vip: false },
        { t_in: 10, name: '학교 급식 재료 1톤', dest: '인천', ton: 1,  cold: false, haz: false, deadline: 16, fee: 108, vip: false },
      ],
    },
    {
      id: 'R1', name: 'R1 평일', short: '평일', snow: false,
      secPerHour: 20, ppl: 8, budget: 1100, storage: true, popupTimes: [10, 14.5],
      story: '평범한 하루. 주문은 넘치지만 인력(편수)은 8명 — 다 잡을 수 없다. 합적·트럭 회전을 잘하는 회사가 앞선다.',
      orders: [
        {t_in: 6, name: "급식 냉동만두", dest: "대전", ton: 3, cold: true, haz: false, deadline: 12, fee: 200, vip: false, best: "truck", best_profit: 135},
        {t_in: 6, name: "조선소 강판 40톤", dest: "부산", ton: 40, cold: false, haz: false, deadline: 30, fee: 560, vip: false, best: "rail", best_profit: 110},
        {t_in: 6, name: "의류 박스 1톤", dest: "서울", ton: 1, cold: false, haz: false, deadline: 14, fee: 118, vip: false, best: "truck", best_profit: 68},
        {t_in: 7, name: "문구류 3톤", dest: "서울", ton: 3, cold: false, haz: false, deadline: 12, fee: 134, vip: false, best: "truck", best_profit: 84},
        {t_in: 7, name: "음료 페트 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 12, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 7, name: "문구류 5톤", dest: "서울", ton: 5, cold: false, haz: false, deadline: 14, fee: 150, vip: false, best: "truck", best_profit: 100},
        {t_in: 8, name: "아파트 이삿짐", dest: "서울", ton: 6, cold: false, haz: false, deadline: 18, fee: 170, vip: false, best: "truck", best_profit: 120},
        {t_in: 8, name: "마트 라면", dest: "광주", ton: 8, cold: false, haz: false, deadline: 22, fee: 330, vip: false, best: "truck", best_profit: 195},
        {t_in: 8, name: "카페 원두", dest: "제주", ton: 1, cold: false, haz: false, deadline: 34, fee: 240, vip: false, best: "sea", best_profit: 65},
        {t_in: 8, name: "택배 합포장 4톤", dest: "인천", ton: 4, cold: false, haz: false, deadline: 13, fee: 132, vip: false, best: "truck", best_profit: 87},
        {t_in: 8, name: "공장 부품 3톤", dest: "서울", ton: 3, cold: false, haz: false, deadline: 16, fee: 134, vip: false, best: "truck", best_profit: 84},
        {t_in: 8, name: "학교 급식 재료 1톤", dest: "인천", ton: 1, cold: false, haz: false, deadline: 14, fee: 108, vip: false, best: "truck", best_profit: 63},
        {t_in: 9, name: "편의점 음료 1톤", dest: "서울", ton: 1, cold: false, haz: false, deadline: 17, fee: 118, vip: false, best: "truck", best_profit: 68},
        {t_in: 9, name: "택배 합포장 2톤", dest: "인천", ton: 2, cold: false, haz: false, deadline: 15, fee: 116, vip: false, best: "truck", best_profit: 71},
        {t_in: 10, name: "학교 교과서", dest: "대전", ton: 9, cold: false, haz: false, deadline: 20, fee: 220, vip: false, best: "truck", best_profit: 155},
        {t_in: 10, name: "학교 급식 재료 5톤", dest: "서울", ton: 5, cold: false, haz: false, deadline: 18, fee: 150, vip: false, best: "truck", best_profit: 100},
        {t_in: 11, name: "학교 급식 재료 4톤", dest: "대전", ton: 4, cold: false, haz: false, deadline: 19, fee: 162, vip: false, best: "truck", best_profit: 97},
        {t_in: 11, name: "음료 페트 3톤", dest: "서울", ton: 3, cold: false, haz: false, deadline: 18, fee: 134, vip: false, best: "truck", best_profit: 84},
        {t_in: 12, name: "★VIP 병원 의료기기", dest: "대구", ton: 0.5, cold: false, haz: false, deadline: 18, fee: 600, vip: true, best: "truck", best_profit: 460},
        {t_in: 12, name: "편의점 음료 1톤", dest: "서울", ton: 1, cold: false, haz: false, deadline: 18, fee: 118, vip: false, best: "truck", best_profit: 68},
        {t_in: 12, name: "공장 부품 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 19, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 12, name: "문구류 1톤", dest: "대전", ton: 1, cold: false, haz: false, deadline: 17, fee: 138, vip: false, best: "truck", best_profit: 73},
        {t_in: 13, name: "택배 합포장 3톤", dest: "인천", ton: 3, cold: false, haz: false, deadline: 18, fee: 124, vip: false, best: "truck", best_profit: 79},
        {t_in: 13, name: "편의점 음료 6톤", dest: "인천", ton: 6, cold: false, haz: false, deadline: 18, fee: 148, vip: false, best: "truck", best_profit: 103},
        {t_in: 14, name: "리조트 식자재", dest: "강릉", ton: 5, cold: true, haz: false, deadline: 24, fee: 360, vip: false, best: "truck", best_profit: 210},
        {t_in: 14, name: "수산시장 얼음", dest: "목포", ton: 8, cold: true, haz: false, deadline: 26, fee: 340, vip: false, best: "truck", best_profit: 175},
        {t_in: 14, name: "음료 페트 6톤", dest: "서울", ton: 6, cold: false, haz: false, deadline: 19, fee: 158, vip: false, best: "truck", best_profit: 108},
        {t_in: 15, name: "문구류 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 23, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 15, name: "택배 합포장 4톤", dest: "대전", ton: 4, cold: false, haz: false, deadline: 20, fee: 162, vip: false, best: "truck", best_profit: 97},
        {t_in: 16, name: "항공 수출 의류", dest: "인천", ton: 2, cold: false, haz: false, deadline: 20, fee: 160, vip: false, best: "truck", best_profit: 115},
      ],
    },
    {
      id: 'R2', name: 'R2 명절 전날', short: '명절 전날', snow: false,
      secPerHour: 20, ppl: 8, budget: 1200, storage: true, popupTimes: [9.5, 13.5],
      story: '명절 물량 폭주! 냉장 선물세트·컨테이너·VIP까지 — 이익 높은 주문만 골라 잡는 선택과 포기의 날.',
      orders: [
        {t_in: 6, name: "한우 세트", dest: "대전", ton: 2, cold: true, haz: false, deadline: 13, fee: 260, vip: false, best: "truck", best_profit: 195},
        {t_in: 6, name: "수출 컨테이너 60톤", dest: "부산", ton: 60, cold: false, haz: false, deadline: 36, fee: 720, vip: false, best: "sea", best_profit: 470},
        {t_in: 6, name: "음료 페트 1톤", dest: "서울", ton: 1, cold: false, haz: false, deadline: 12, fee: 118, vip: false, best: "truck", best_profit: 68},
        {t_in: 7, name: "굴비 세트", dest: "광주", ton: 3, cold: true, haz: false, deadline: 18, fee: 300, vip: false, best: "truck", best_profit: 165},
        {t_in: 7, name: "편의점 음료 4톤", dest: "대전", ton: 4, cold: false, haz: false, deadline: 15, fee: 162, vip: false, best: "truck", best_profit: 97},
        {t_in: 7, name: "공장 부품 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 15, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 8, name: "생수 9톤", dest: "서울", ton: 9, cold: false, haz: false, deadline: 16, fee: 220, vip: false, best: "truck", best_profit: 170},
        {t_in: 8, name: "쌀 20톤", dest: "대전", ton: 20, cold: false, haz: false, deadline: 22, fee: 330, vip: false, best: "rail", best_profit: 180},
        {t_in: 8, name: "편의점 음료 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 14, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 8, name: "음료 페트 4톤", dest: "서울", ton: 4, cold: false, haz: false, deadline: 15, fee: 142, vip: false, best: "truck", best_profit: 92},
        {t_in: 8, name: "학교 급식 재료 6톤", dest: "대전", ton: 6, cold: false, haz: false, deadline: 15, fee: 178, vip: false, best: "truck", best_profit: 113},
        {t_in: 8, name: "사무용품 1톤", dest: "서울", ton: 1, cold: false, haz: false, deadline: 15, fee: 118, vip: false, best: "truck", best_profit: 68},
        {t_in: 8, name: "문구류 3톤", dest: "인천", ton: 3, cold: false, haz: false, deadline: 14, fee: 124, vip: false, best: "truck", best_profit: 79},
        {t_in: 9, name: "떡 세트", dest: "대구", ton: 2, cold: true, haz: false, deadline: 16, fee: 280, vip: false, best: "truck", best_profit: 140},
        {t_in: 9, name: "제사 음식 냉장", dest: "서울", ton: 2, cold: true, haz: false, deadline: 14, fee: 190, vip: false, best: "truck", best_profit: 140},
        {t_in: 9, name: "마트 과자 3톤", dest: "서울", ton: 3, cold: false, haz: false, deadline: 15, fee: 134, vip: false, best: "truck", best_profit: 84},
        {t_in: 10, name: "★VIP 결혼식 화훼", dest: "부산", ton: 0.3, cold: true, haz: false, deadline: 15, fee: 700, vip: true, best: "air", best_profit: 234},
        {t_in: 11, name: "학교 교과서", dest: "대전", ton: 9, cold: false, haz: false, deadline: 22, fee: 220, vip: false, best: "truck", best_profit: 155},
        {t_in: 11, name: "가전 소형 2톤", dest: "대전", ton: 2, cold: false, haz: false, deadline: 16, fee: 146, vip: false, best: "truck", best_profit: 81},
        {t_in: 11, name: "가전 소형 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 16, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 11, name: "택배 합포장 5톤", dest: "서울", ton: 5, cold: false, haz: false, deadline: 16, fee: 150, vip: false, best: "truck", best_profit: 100},
        {t_in: 11, name: "택배 합포장 4톤", dest: "서울", ton: 4, cold: false, haz: false, deadline: 16, fee: 142, vip: false, best: "truck", best_profit: 92},
        {t_in: 11, name: "문구류 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 16, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 12, name: "이삿짐", dest: "강릉", ton: 8, cold: false, haz: false, deadline: 24, fee: 280, vip: false, best: "truck", best_profit: 130},
        {t_in: 12, name: "수산물 얼음", dest: "목포", ton: 8, cold: true, haz: false, deadline: 26, fee: 340, vip: false, best: "truck", best_profit: 175},
        {t_in: 12, name: "편의점 음료 6톤", dest: "인천", ton: 6, cold: false, haz: false, deadline: 19, fee: 148, vip: false, best: "truck", best_profit: 103},
        {t_in: 12, name: "공장 부품 4톤", dest: "대전", ton: 4, cold: false, haz: false, deadline: 17, fee: 162, vip: false, best: "truck", best_profit: 97},
        {t_in: 12, name: "공장 부품 5톤", dest: "대전", ton: 5, cold: false, haz: false, deadline: 19, fee: 170, vip: false, best: "truck", best_profit: 105},
        {t_in: 12, name: "택배 합포장 2톤", dest: "인천", ton: 2, cold: false, haz: false, deadline: 18, fee: 116, vip: false, best: "truck", best_profit: 71},
        {t_in: 13, name: "명절 선물 냉장", dest: "인천", ton: 3, cold: true, haz: false, deadline: 19, fee: 210, vip: false, best: "truck", best_profit: 165},
        {t_in: 13, name: "사무용품 4톤", dest: "대전", ton: 4, cold: false, haz: false, deadline: 21, fee: 162, vip: false, best: "truck", best_profit: 97},
        {t_in: 14, name: "★VIP 병원 백신", dest: "광주", ton: 0.3, cold: true, haz: false, deadline: 20, fee: 650, vip: true, best: "truck", best_profit: 515},
        {t_in: 14, name: "호텔 침구", dest: "제주", ton: 2, cold: false, haz: false, deadline: 36, fee: 330, vip: false, best: "sea", best_profit: 155},
        {t_in: 14, name: "학교 급식 재료 3톤", dest: "대전", ton: 3, cold: false, haz: false, deadline: 22, fee: 154, vip: false, best: "truck", best_profit: 89},
        {t_in: 14, name: "의류 박스 4톤", dest: "인천", ton: 4, cold: false, haz: false, deadline: 22, fee: 132, vip: false, best: "truck", best_profit: 87},
        {t_in: 15, name: "사무용품 2톤", dest: "대전", ton: 2, cold: false, haz: false, deadline: 22, fee: 146, vip: false, best: "truck", best_profit: 81},
        {t_in: 15, name: "학교 급식 재료 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 20, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 16, name: "문구류 1톤", dest: "인천", ton: 1, cold: false, haz: false, deadline: 23, fee: 108, vip: false, best: "truck", best_profit: 63},
        {t_in: 17, name: "사무용품 3톤", dest: "인천", ton: 3, cold: false, haz: false, deadline: 25, fee: 124, vip: false, best: "truck", best_profit: 79},
        {t_in: 17, name: "마트 과자 2톤", dest: "대전", ton: 2, cold: false, haz: false, deadline: 22, fee: 146, vip: false, best: "truck", best_profit: 81},
      ],
    },
    {
      id: 'R3', name: 'R3 폭설', short: '폭설', snow: true,
      secPerHour: 20, ppl: 9, budget: 1300, storage: false, popupTimes: [10, 15],
      story: '❄ 폭설! 트럭 속도 40km/h, 항공 결항. 트럭 회전이 느려져 시간이 병목 — 철도의 가치 급등.',
      orders: [
        {t_in: 6, name: "생수 9톤", dest: "서울", ton: 9, cold: false, haz: false, deadline: 16, fee: 220, vip: false, best: "truck", best_profit: 170},
        {t_in: 6, name: "병원 혈액", dest: "대전", ton: 0.2, cold: true, haz: false, deadline: 11, fee: 420, vip: false, best: "truck", best_profit: 355},
        {t_in: 6, name: "수출 자동차 부품 30톤", dest: "부산", ton: 30, cold: false, haz: false, deadline: 40, fee: 580, vip: false, best: "sea", best_profit: 330},
        {t_in: 6, name: "화학약품(위험물)", dest: "광주", ton: 5, cold: false, haz: true, deadline: 30, fee: 450, vip: false, best: "rail", best_profit: 276},
        {t_in: 6, name: "택배 합포장 4톤", dest: "서울", ton: 4, cold: false, haz: false, deadline: 13, fee: 142, vip: false, best: "truck", best_profit: 92},
        {t_in: 7, name: "가전 소형 4톤", dest: "인천", ton: 4, cold: false, haz: false, deadline: 13, fee: 132, vip: false, best: "truck", best_profit: 87},
        {t_in: 8, name: "스키장 식자재", dest: "강릉", ton: 6, cold: true, haz: false, deadline: 24, fee: 380, vip: false, best: "truck", best_profit: 230},
        {t_in: 8, name: "마트 생필품 12톤", dest: "제주", ton: 12, cold: false, haz: false, deadline: 40, fee: 460, vip: false, best: "sea", best_profit: 285},
        {t_in: 8, name: "편의점 음료 2톤", dest: "인천", ton: 2, cold: false, haz: false, deadline: 14, fee: 116, vip: false, best: "truck", best_profit: 71},
        {t_in: 9, name: "마트 과자 4톤", dest: "서울", ton: 4, cold: false, haz: false, deadline: 15, fee: 142, vip: false, best: "truck", best_profit: 92},
        {t_in: 9, name: "가전 소형 1톤", dest: "서울", ton: 1, cold: false, haz: false, deadline: 15, fee: 118, vip: false, best: "truck", best_profit: 68},
        {t_in: 9, name: "마트 과자 1톤", dest: "서울", ton: 1, cold: false, haz: false, deadline: 16, fee: 118, vip: false, best: "truck", best_profit: 68},
        {t_in: 10, name: "★VIP 반도체 장비", dest: "대구", ton: 2, cold: false, haz: false, deadline: 17, fee: 800, vip: true, best: "truck", best_profit: 660},
        {t_in: 11, name: "난방유 20톤", dest: "대전", ton: 20, cold: false, haz: false, deadline: 24, fee: 300, vip: false, best: "rail", best_profit: 150},
        {t_in: 11, name: "음료 페트 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 19, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 12, name: "택배 합포장 6톤", dest: "서울", ton: 6, cold: false, haz: false, deadline: 19, fee: 158, vip: false, best: "truck", best_profit: 108},
        {t_in: 12, name: "택배 합포장 4톤", dest: "인천", ton: 4, cold: false, haz: false, deadline: 20, fee: 132, vip: false, best: "truck", best_profit: 87},
        {t_in: 12, name: "학교 급식 재료 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 17, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 13, name: "방한용품", dest: "대구", ton: 5, cold: false, haz: false, deadline: 24, fee: 260, vip: false, best: "truck", best_profit: 120},
        {t_in: 13, name: "편의점 음료 3톤", dest: "서울", ton: 3, cold: false, haz: false, deadline: 18, fee: 134, vip: false, best: "truck", best_profit: 84},
        {t_in: 13, name: "음료 페트 3톤", dest: "인천", ton: 3, cold: false, haz: false, deadline: 19, fee: 124, vip: false, best: "truck", best_profit: 79},
        {t_in: 13, name: "학교 급식 재료 6톤", dest: "인천", ton: 6, cold: false, haz: false, deadline: 20, fee: 148, vip: false, best: "truck", best_profit: 103},
        {t_in: 13, name: "공장 부품 6톤", dest: "서울", ton: 6, cold: false, haz: false, deadline: 20, fee: 158, vip: false, best: "truck", best_profit: 108},
        {t_in: 14, name: "음료 페트 3톤", dest: "서울", ton: 3, cold: false, haz: false, deadline: 20, fee: 134, vip: false, best: "truck", best_profit: 84},
        {t_in: 14, name: "편의점 음료 2톤", dest: "서울", ton: 2, cold: false, haz: false, deadline: 19, fee: 126, vip: false, best: "truck", best_profit: 76},
        {t_in: 14, name: "사무용품 2톤", dest: "인천", ton: 2, cold: false, haz: false, deadline: 21, fee: 116, vip: false, best: "truck", best_profit: 71},
        {t_in: 15, name: "★VIP 이식용 장기", dest: "광주", ton: 0.01, cold: true, haz: false, deadline: 21, fee: 900, vip: true, best: "rail", best_profit: 716},
        {t_in: 15, name: "음료 페트 4톤", dest: "서울", ton: 4, cold: false, haz: false, deadline: 21, fee: 142, vip: false, best: "truck", best_profit: 92},
        {t_in: 16, name: "항공 수출 의류", dest: "인천", ton: 2, cold: false, haz: false, deadline: 22, fee: 160, vip: false, best: "truck", best_profit: 115},
        {t_in: 16, name: "의류 박스 1톤", dest: "인천", ton: 1, cold: false, haz: false, deadline: 22, fee: 108, vip: false, best: "truck", best_profit: 63},
      ],
    },
  ];

  // ── 추가 주문 생성기 (시장 물량 ×3)
  //  원본 주문(검증본)은 그대로 두고, 같은 요금 체계의 주문을 라운드마다 결정적으로(시드 고정) 덧붙인다.
  //  → 물량이 많아 "빨리 누르는 게임"이 아니라 "무엇을 고를지"가 승부가 된다.
  const EXTRA = { R0: 6, R1: 60, R2: 80, R3: 60 };
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const SHORT_NAMES = ['문구류', '음료 페트', '편의점 음료', '택배 합포장', '공장 부품', '학교 급식 재료', '사무용품', '마트 과자', '의류 박스', '가전 소형', '생수', '화장품 박스', '서점 도서', '약국 의약품', '카페 소모품'];
  const COLD_NAMES = ['냉동 만두', '아이스크림', '냉장 우유', '횟감 수산물', '냉동 피자', '신선 채소', '한우 세트', '냉장 도시락'];
  const LONG = [ // 중·장거리 (트럭 가능) — 목적지별 [톤 범위, 기준 배송료(1톤당 가산 8)]
    { dest: '강릉', names: ['리조트 식자재', '스키장 용품', '해수욕장 물품', '펜션 침구'], ton: [3, 8], base: 240, coldBase: 320 },
    { dest: '대구', names: ['섬유 원단', '방한용품', '안경 부품', '떡 세트'], ton: [2, 8], base: 220, coldBase: 265 },
    { dest: '광주', names: ['마트 라면', '김치 세트', '굴비 세트', '자동차 부품'], ton: [3, 8], base: 270, coldBase: 280 },
    { dest: '목포', names: ['수산시장 얼음', '김 세트', '조선 자재', '건어물'], ton: [4, 8], base: 260, coldBase: 280 },
  ];
  const HEAVY = [ // 10톤 초과 → 철도/선박
    { dest: '대전', names: ['쌀', '난방유', '시멘트', '비료'], ton: [15, 30], fee: t => 240 + t * 4.5 },
    { dest: '부산', names: ['수출 컨테이너', '강판', '자동차 부품', '기계 설비'], ton: [20, 60], fee: t => 420 + t * 4.5 },
    { dest: '제주', names: ['마트 생필품', '호텔 침구', '건축 자재', '관광 기념품'], ton: [1, 12], fee: t => 230 + t * 18 },
  ];
  function extraOrders(R, n) {
    const r = rng(R.id.charCodeAt(1) * 7919 + n);
    const pick = a => a[Math.floor(r() * a.length)];
    const between = (a, b) => a + Math.floor(r() * (b - a + 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const t_in = between(6, 17);
      const kind = r();
      let o;
      if (kind < 0.62) {           // 단거리 일반 (합적 대상)
        const dest = pick(['서울', '서울', '서울', '인천', '인천', '대전', '대전']);
        const ton = between(1, 6);
        const base = { '서울': 110, '인천': 100, '대전': 130 }[dest];
        o = { name: `${pick(SHORT_NAMES)} ${ton}톤`, dest, ton, cold: false, fee: base + ton * 8, deadline: t_in + between(5, 9) };
      } else if (kind < 0.76) {    // 단거리 냉장 (냉장 트럭 1대 쟁탈)
        const dest = pick(['서울', '인천', '대전', '대전']);
        const ton = between(1, 4);
        const base = { '서울': 150, '인천': 140, '대전': 165 }[dest];
        o = { name: `${pick(COLD_NAMES)} ${ton}톤`, dest, ton, cold: true, fee: base + ton * 10, deadline: t_in + between(5, 8) };
      } else if (kind < 0.92) {    // 중·장거리
        const L = pick(LONG); const ton = between(L.ton[0], L.ton[1]); const cold = r() < 0.3;
        o = { name: `${pick(L.names)} ${ton}톤`, dest: L.dest, ton, cold, fee: (cold ? L.coldBase : L.base) + ton * 8, deadline: t_in + between(9, 13) };
      } else {                     // 대량·원거리 (철도·선박)
        const H = pick(HEAVY); const ton = between(H.ton[0], H.ton[1]);
        o = { name: `${pick(H.names)} ${ton}톤`, dest: H.dest, ton, cold: false, fee: Math.round(H.fee(ton)), deadline: t_in + (H.dest === '대전' ? between(10, 14) : between(18, 26)) };
      }
      out.push(Object.assign({ t_in, haz: false, vip: false }, o, { extra: true }));
    }
    return out.sort((a, b) => a.t_in - b.t_in);
  }
  ROUNDS.forEach(R => { if (EXTRA[R.id]) R.orders.push(...extraOrders(R, EXTRA[R.id])); R.orders.sort((a, b) => a.t_in - b.t_in || (a.vip ? -1 : 0)); });

  // 주문 id 부여 · 트럭 편성 라벨
  ROUNDS.forEach(r => { r.fleet = r.fleet || FLEET_DEFAULT; r.trucks = fleetLabel(r.fleet); });
  ROUNDS.forEach(r => r.orders.forEach((o, i) => { o.id = r.id + '-' + String(i + 1).padStart(2, '0'); }));

  global.MD = {
    DEST, ORIGIN, TIME, MODES, FLEET_DEFAULT, fleetLabel, STORE_COST, ABANDON_RATE, LATE_RATE, ACTIVE_LIMIT,
    weightFactor, STARS, starMultiplier, GROUPS, POPUPS, POPUP_DECK, ROUNDS,
    roundById: id => ROUNDS.find(r => r.id === id),
    groupById: id => GROUPS.find(g => g.id === id),
  };
})(typeof window !== 'undefined' ? window : globalThis);
