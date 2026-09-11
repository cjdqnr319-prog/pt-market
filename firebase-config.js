/* =========================================================
 * firebase-config.js — Firebase Realtime Database 설정
 *
 *  Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹) → SDK 설정의 config
 *  (databaseURL 반드시 포함). null 로 두면 "로컬 모드"로 동작합니다.
 *   - 같은 컴퓨터·같은 브라우저의 여러 탭끼리만 동기화 (테스트/시연용)
 *
 *  Realtime Database 규칙(수업용 최소):
 *  { "rules": { "rooms": { "$code": { ".read": true, ".write": true } } } }
 * ========================================================= */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAdSzZpnnDnccb823yMNi8RIrlqpcJuWoY",
  authDomain: "susong-2fdaf.firebaseapp.com",
  databaseURL: "https://susong-2fdaf-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "susong-2fdaf",
};
