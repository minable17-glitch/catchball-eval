import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchVideo, listLabels, saveLabels } from './api.js';
import { sampleBallParams } from './analysis.js';

// 공 위치 표시 도구 (학습 자료 만들기)
// 영상을 STEP 초 간격으로 넘기며 공을 한 번씩 누름. 직전 두 표시로 다음 위치를 미리 짚어 주므로
// 맞으면 스페이스(또는 "맞음")만, 틀리면 다시 누름. 공이 안 보이면 "안 보임".
const STEP = 0.2;

function fmt(sec) { const m = Math.floor(sec / 60), s = sec - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; }

export default function Label({ submission, onClose, onSaved }) {
  const [status, setStatus] = useState('loading'); // loading | ready | saving | error
  const [msg, setMsg] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [t, setT] = useState(0);
  const [labels, setLabels] = useState({}); // key: t.toFixed(1) → {t, present, x, y, r}
  const [dirty, setDirty] = useState(false);
  const [guess, setGuess] = useState(null); // 다음 위치 예상 {x, y}
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const urlRef = useRef(null);

  const key = (tt) => (Math.round(tt / STEP) * STEP).toFixed(1);

  // 영상 불러오기 + 기존 표시
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [blob, existing] = await Promise.all([fetchVideo(submission.path), listLabels(submission.id)]);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setVideoUrl(url);
        const map = {};
        for (const l of existing) map[key(l.t)] = l;
        setLabels(map);
        setStatus('ready');
      } catch (e) {
        if (!cancelled) { setStatus('error'); setMsg(e?.message || '영상을 불러오지 못했습니다.'); }
      }
    })();
    return () => { cancelled = true; if (urlRef.current) URL.revokeObjectURL(urlRef.current); };
  }, [submission.id, submission.path]);

  const seek = useCallback((tt) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(Math.max(0, (v.duration || duration) - 0.05), tt));
    v.currentTime = clamped;
    setT(clamped);
  }, [duration]);

  // 다음 위치 예상: 직전 두 표시의 직선 연장
  useEffect(() => {
    const k1 = key(t - STEP), k2 = key(t - 2 * STEP);
    const a = labels[k1], b = labels[k2];
    if (a?.present && b?.present) setGuess({ x: a.x + (a.x - b.x), y: a.y + (a.y - b.y) });
    else if (a?.present) setGuess({ x: a.x, y: a.y });
    else setGuess(null);
  }, [t, labels]);

  // 오버레이 그리기
  const draw = useCallback(() => {
    const canvas = overlayRef.current, v = videoRef.current;
    if (!canvas || !v?.videoWidth) return;
    if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) { canvas.width = v.videoWidth; canvas.height = v.videoHeight; }
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, lw = Math.max(2, W / 320);
    ctx.clearRect(0, 0, W, H);
    const cur = labels[key(t)];
    if (cur?.present) {
      ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = lw * 1.5;
      ctx.beginPath(); ctx.arc(cur.x * W, cur.y * H, Math.max(lw * 5, (cur.r || 0.01) * W * 1.8), 0, Math.PI * 2); ctx.stroke();
    } else if (guess) {
      ctx.setLineDash([lw * 3, lw * 3]); ctx.strokeStyle = 'rgba(255,214,0,0.9)'; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(guess.x * W, guess.y * H, lw * 6, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    // 이전 표시들 희미하게 (궤적 확인용)
    ctx.fillStyle = 'rgba(255,59,48,0.35)';
    for (let k = 1; k <= 5; k++) {
      const l = labels[key(t - k * STEP)];
      if (l?.present) { ctx.beginPath(); ctx.arc(l.x * W, l.y * H, lw * 1.5, 0, Math.PI * 2); ctx.fill(); }
    }
  }, [labels, t, guess]);
  useEffect(() => { draw(); }, [draw]);

  const toNorm = (e) => {
    const v = videoRef.current, canvas = overlayRef.current;
    if (!v?.videoWidth || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / v.videoWidth, rect.height / v.videoHeight);
    const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
    const nx = (e.clientX - rect.left - (rect.width - dw) / 2) / dw, ny = (e.clientY - rect.top - (rect.height - dh) / 2) / dh;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { nx, ny };
  };

  const setLabel = (l) => { setLabels((m) => ({ ...m, [key(t)]: { ...l, t: Number(key(t)) } })); setDirty(true); };

  const onClick = (e) => {
    if (status !== 'ready') return;
    const p = toNorm(e);
    if (!p) return;
    const v = videoRef.current;
    // 누른 자리 근처에서 가장 공다운 색 점으로 맞춤 (못 찾으면 누른 자리 그대로)
    const w = 960, h = Math.round(v.videoHeight * w / v.videoWidth);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const s = sampleBallParams(ctx.getImageData(0, 0, w, h).data, w, h, p.nx, p.ny, 8);
    const center = s?.center || { x: p.nx, y: p.ny };
    const r = s?.sample?.area ? Math.sqrt(s.sample.area / Math.PI) / w : 0.008;
    setLabel({ present: true, x: center.x, y: center.y, r });
    setTimeout(() => seek(t + STEP), 80);
  };

  const accept = () => { if (guess) { setLabel({ present: true, x: guess.x, y: guess.y, r: labels[key(t - STEP)]?.r || 0.008 }); } seek(t + STEP); };
  const markAbsent = () => { setLabel({ present: false, x: null, y: null, r: null }); seek(t + STEP); };
  const clearHere = () => { setLabels((m) => { const n = { ...m }; delete n[key(t)]; return n; }); setDirty(true); };

  // 키보드: ← → 이동, 스페이스 = 예상 위치 맞음, N = 안 보임, Backspace = 지우기
  useEffect(() => {
    const onKey = (e) => {
      if (status !== 'ready') return;
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); seek(t + STEP); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(t - STEP); }
      else if (e.key === ' ') { e.preventDefault(); accept(); }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); markAbsent(); }
      else if (e.key === 'Backspace') { e.preventDefault(); clearHere(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const save = async () => {
    setStatus('saving');
    try {
      const list = Object.values(labels);
      await saveLabels(submission.id, list);
      setDirty(false);
      setStatus('ready');
      setMsg(`저장했습니다 (${list.length}장면).`);
      onSaved?.(list.length);
    } catch (e) {
      setStatus('ready'); setMsg('저장 실패: ' + (e?.message || ''));
    }
  };

  const total = duration ? Math.floor(duration / STEP) + 1 : 0;
  const done = Object.keys(labels).length;
  const present = Object.values(labels).filter((l) => l.present).length;
  const cur = labels[key(t)];

  return (
    <div className="cb-label">
      <div className="cb-row" style={{ margin: 0, alignItems: 'center' }}>
        <b>공 표시하기</b> <span className="cb-sub">{submission.student1} · {submission.student2} · {submission.className}</span>
        <span className="cb-sub" style={{ marginLeft: 'auto' }}>{done}/{total}장면 표시 (공 보임 {present})</span>
      </div>
      {status === 'loading' && <p className="cb-note">영상을 불러오는 중...</p>}
      {status === 'error' && <p className="cb-error">{msg}</p>}
      {videoUrl && (
        <>
          <div className="cb-video-wrap">
            <video ref={videoRef} src={videoUrl} playsInline muted preload="auto" onLoadedMetadata={(e) => { setDuration(e.target.duration || 0); seek(0); }} onSeeked={draw} />
            <canvas ref={overlayRef} className="cb-overlay clickable" onClick={onClick} />
          </div>
          <div className="cb-label-bar">
            <button type="button" className="cb-btn ghost" onClick={() => seek(t - STEP)}>◀ 앞</button>
            <span className="cb-label-time">{fmt(t)} {cur ? (cur.present ? '· 표시됨' : '· 안 보임') : ''}</span>
            <button type="button" className="cb-btn ghost" onClick={() => seek(t + STEP)}>뒤 ▶</button>
            <button type="button" className="cb-btn ok" onClick={accept} disabled={!guess} title="스페이스">노란 점선 자리 맞음</button>
            <button type="button" className="cb-btn ghost" onClick={markAbsent} title="N">공 안 보임</button>
            <button type="button" className="cb-btn ghost" onClick={clearHere} disabled={!cur} title="Backspace">이 장면 지우기</button>
          </div>
          <input type="range" min="0" max={Math.max(0.1, duration - 0.05)} step={STEP} value={t} onChange={(e) => seek(Number(e.target.value))} aria-label="장면" />
          <p className="cb-note">영상 위에서 <b>공을 한 번 누르면</b> 표시되고 다음 장면으로 넘어갑니다. 노란 점선은 예상 위치입니다. 맞으면 <b>스페이스</b>, 안 보이면 <b>N</b>. 공이 글러브 안에 들어가 안 보이면 "안 보임"으로 두면 됩니다. 영상 전체를 다 하지 않아도 됩니다. 날아가는 장면 위주로 20~40장면이면 충분합니다.</p>
          {msg && <p className="cb-note">{msg}</p>}
          <div className="cb-row">
            <button type="button" className="cb-btn" onClick={save} disabled={status === 'saving' || !dirty}>{status === 'saving' ? '저장 중...' : '표시 저장'}</button>
            <button type="button" className="cb-btn ghost" onClick={() => { if (!dirty || window.confirm('저장하지 않은 표시가 있어요. 닫을까요?')) onClose(); }}>닫기</button>
          </div>
        </>
      )}
    </div>
  );
}
