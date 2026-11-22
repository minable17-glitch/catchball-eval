// 올리는 동안 폰 화면이 꺼지지 않게 함. 화면이 꺼지거나 다른 앱으로 가면 브라우저가 전송을 멈춰서
// 큰 영상이 "올라가다가 멈추는" 일이 생김.
export async function keepAwake() {
  let lock = null, released = false;
  const acquire = async () => {
    if (released || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try { lock = await navigator.wakeLock.request('screen'); } catch { /* 지원 안 하거나 거부: 그냥 진행 */ }
  };
  const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
  document.addEventListener('visibilitychange', onVisible);
  await acquire();
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisible);
    try { lock?.release?.(); } catch { /* 무시 */ }
  };
}

// 화면이 다시 보이고 인터넷이 연결될 때까지 기다림 (최대 maxMs). 꺼진 화면에서 다시 시도해 봐야 또 실패하므로
export function waitUsable(maxMs = 120000) {
  return new Promise((resolve) => {
    const ok = () => document.visibilityState === 'visible' && navigator.onLine !== false;
    if (ok()) { resolve(); return; }
    const done = () => { clearTimeout(t); document.removeEventListener('visibilitychange', check); window.removeEventListener('online', check); resolve(); };
    const check = () => { if (ok()) done(); };
    const t = setTimeout(done, maxMs);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
  });
}
