import { useEffect, useRef, useState } from 'react';
import { fetchVideo, maxFor, saveScores } from './api.js';

// 선생님 직접 채점: 영상을 보면서 학생마다 성공 개수를 체크. 다 채우면 만점.
// 만점 기준은 회차·성별로 정해짐 (설정의 "만점 기준").
const SPEEDS = [0.5, 1, 1.5, 2];

export default function Grade({ submission, rules, genderOf, scores, scoresReady, onClose, onSaved, onNext }) {
  const round = submission.round;
  const [rows, setRows] = useState(() => [submission.student1, submission.student2].map((name) => {
    const prev = scores.find((s) => s.className === submission.className && s.student === name && s.round === round) || null;
    const gender = prev?.gender || genderOf(submission.className, name) || '';
    const max = maxFor(rules, round, gender);
    return { name, gender, count: prev ? Math.min(prev.count, max ?? prev.count) : 0, prev };
  }));
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [pct, setPct] = useState(null);
  const [msg, setMsg] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [saving, setSaving] = useState(false);
  const videoRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => { rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, []);

  useEffect(() => {
    let cancelled = false, url = null;
    (async () => {
      try {
        const blob = await fetchVideo(submission.path, (p) => { if (!cancelled) setPct(Math.round(p * 100)); });
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setVideoUrl(url);
        setStatus('ready');
      } catch (e) {
        if (!cancelled) { setStatus('error'); setMsg(e?.message || '영상을 불러오지 못했습니다.'); }
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [submission.path]);

  // 브라우저에서 녹화한 영상은 길이 정보가 없어 재생 막대가 안 움직임 → 끝으로 한 번 건너뛰어 길이를 알아냄
  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v || Number.isFinite(v.duration)) return;
    const done = () => { v.removeEventListener('durationchange', done); v.currentTime = 0; };
    v.addEventListener('durationchange', done);
    v.currentTime = 1e9;
  };

  const pickSpeed = (s) => { setSpeed(s); if (videoRef.current) videoRef.current.playbackRate = s; };
  const jump = (d) => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, (v.currentTime || 0) + d); };

  const update = (i, patch) => setRows((list) => list.map((r, k) => {
    if (k !== i) return r;
    const next = { ...r, ...patch };
    const max = maxFor(rules, round, next.gender);
    if (max != null) next.count = Math.max(0, Math.min(max, next.count));
    return next;
  }));

  const save = async (goNext) => {
    if (rows.some((r) => !r.gender)) { setMsg('성별(남/여)을 먼저 골라 주세요. 만점 기준이 성별마다 달라요.'); return; }
    setSaving(true); setMsg('');
    try {
      await saveScores(submission.id, rows.map((r) => ({ className: submission.className, student: r.name, round, gender: r.gender, count: r.count, max: maxFor(rules, round, r.gender) })));
      await onSaved?.();
      if (goNext && onNext) onNext(); else onClose?.();
    } catch (e) {
      setMsg('저장 실패: ' + (e?.message || ''));
    } finally { setSaving(false); }
  };

  return (
    <div className="cb-grade" ref={rootRef}>
      <div className="cb-row" style={{ margin: 0, alignItems: 'center' }}>
        <b>✏️ 채점</b>
        <span className="cb-pill round">{round}</span>
        <span>{submission.className} · <b>{submission.student1}</b> · <b>{submission.student2}</b></span>
        {submission.driveLink && <a href={submission.driveLink} target="_blank" rel="noreferrer" className="cb-sub">드라이브에서 보기</a>}
        <button type="button" className="cb-btn ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>닫기</button>
      </div>
      {!scoresReady && <p className="cb-warn">⚠️ 점수를 저장할 표가 아직 없습니다. 수파베이스 SQL Editor 에서 <code>supabase/catchball_v4_scores.sql</code> 을 실행해 주세요.</p>}

      {status === 'loading' && <p className="cb-note">영상을 가져오는 중...{pct != null ? ` ${pct}%` : ''}</p>}
      {status === 'error' && <p className="cb-error">⚠️ {msg}</p>}
      {videoUrl && (
        <>
          <video ref={videoRef} className="cb-grade-video" src={videoUrl} controls playsInline onLoadedMetadata={onLoadedMetadata} />
          <div className="cb-row" style={{ margin: 0, alignItems: 'center' }}>
            <button type="button" className="cb-btn ghost" onClick={() => jump(-5)}>◀ 5초</button>
            <button type="button" className="cb-btn ghost" onClick={() => jump(5)}>5초 ▶</button>
            <span className="cb-sub">속도</span>
            {SPEEDS.map((s) => <button key={s} type="button" className={`cb-btn ghost cb-speed ${speed === s ? 'on' : ''}`} onClick={() => pickSpeed(s)}>{s}배</button>)}
          </div>
        </>
      )}

      {rows.map((r, i) => {
        const max = maxFor(rules, round, r.gender);
        const full = max != null && r.count >= max;
        return (
          <div key={r.name} className={`cb-grade-row ${full ? 'full' : ''}`}>
            <div className="cb-grade-head">
              <b className="cb-grade-name">{r.name}</b>
              <span className="cb-gender">
                {['남', '여'].map((g) => <button key={g} type="button" className={r.gender === g ? 'on' : ''} onClick={() => update(i, { gender: g })}>{g}</button>)}
              </span>
              {max != null && <span className="cb-grade-score"><b>{r.count}</b> / {max}{full ? ' · 만점 ✅' : ''}</span>}
              {r.prev && <span className="cb-sub">저장된 점수 {r.prev.count}/{r.prev.max}</span>}
            </div>
            {max == null ? <p className="cb-note" style={{ margin: 0 }}>성별을 고르면 체크 칸이 나옵니다. (명렬표 이름 뒤에 (남)/(여)를 적어 두면 자동으로 골라집니다)</p> : (
              <div className="cb-tally">
                {Array.from({ length: max }, (_, k) => k + 1).map((n) => (
                  <button key={n} type="button" className={n <= r.count ? 'on' : ''} onClick={() => update(i, { count: r.count === n ? n - 1 : n })} aria-label={`${r.name} ${n}개`}>{n <= r.count ? '✓' : n}</button>
                ))}
                <button type="button" className="cb-btn ghost" onClick={() => update(i, { count: max })}>만점</button>
                <button type="button" className="cb-btn ghost" onClick={() => update(i, { count: 0 })}>0</button>
              </div>
            )}
          </div>
        );
      })}

      {msg && status !== 'error' && <p className="cb-error">{msg}</p>}
      <div className="cb-row" style={{ margin: 0 }}>
        {onNext && <button type="button" className="cb-btn big" style={{ flex: 1 }} onClick={() => save(true)} disabled={saving || !scoresReady}>{saving ? '저장 중...' : '저장하고 다음 영상 ▶'}</button>}
        <button type="button" className={`cb-btn ${onNext ? '' : 'big'}`} style={onNext ? {} : { flex: 1 }} onClick={() => save(false)} disabled={saving || !scoresReady}>저장</button>
      </div>
    </div>
  );
}
