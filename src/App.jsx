import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_BALL_PARAMS, DEFAULT_EVENT_PARAMS, detectEvents, makeColorMask, summarize } from './analysis.js';
import { analyzeVideo, previewMask } from './analyzer.js';
import { loadPoseLandmarker } from './pose.js';
import { addRecord, deleteRecord, exportRecordsToExcel, loadRecords, todayKST } from './records.js';
import { deleteSubmission, fetchVideo, getSavedTeacherUsername, listResults, listSubmissions, saveResult, teacherLogin, teacherLogout, teacherMe, teacherSignup } from './api.js';

const FPS_OPTIONS = [
  { value: 10, label: '빠르게 (초당 10장)' },
  { value: 15, label: '보통 (초당 15장) · 추천' },
  { value: 20, label: '꼼꼼하게 (초당 20장)' },
];

// 일부 영상(특히 브라우저에서 녹화한 webm)은 길이 정보가 없어 duration 이 Infinity 로 나옴.
// 끝으로 한 번 건너뛰면 브라우저가 실제 길이를 알아냄.
function ensureDuration(video) {
  if (Number.isFinite(video.duration)) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeEventListener('durationchange', done);
      video.currentTime = 0;
      resolve();
    };
    const timer = setTimeout(done, 3000);
    video.addEventListener('durationchange', done);
    video.currentTime = 1e9;
  });
}

function fmtTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export default function App() {
  // ── 학생 정보 ──
  const [info, setInfo] = useState({ date: todayKST(), className: '', student1: '', student2: '', memo: '' });
  // ── 영상 ──
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoName, setVideoName] = useState('');
  const [duration, setDuration] = useState(null);
  // ── 설정 ──
  const [fps, setFps] = useState(15);
  const [usePose, setUsePose] = useState(true);
  const [ballParams, setBallParams] = useState({ ...DEFAULT_BALL_PARAMS });
  const [minTravel, setMinTravel] = useState(DEFAULT_EVENT_PARAMS.minTravel);
  const [showSettings, setShowSettings] = useState(false);
  const [maskPreview, setMaskPreview] = useState(null); // { url, found }
  // ── 분석 상태 ──
  const [status, setStatus] = useState('idle'); // idle | loading | pose | analyzing | done | error
  const [progress, setProgress] = useState({ index: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState('');
  const [poseNote, setPoseNote] = useState('');
  const [track, setTrack] = useState(null);
  const [groundY, setGroundY] = useState(null);
  const [events, setEvents] = useState([]);
  const [foundRatio, setFoundRatio] = useState(null);
  // ── 기록 ──
  const [records, setRecords] = useState(() => loadRecords());
  const [toast, setToast] = useState('');
  // ── 선생님 로그인(수파베이스) + 제출 목록 ──
  const [teacher, setTeacher] = useState(null); // {id, username}
  const [loginDraft, setLoginDraft] = useState(() => ({ username: getSavedTeacherUsername(), password: '', code: '' }));
  const [signupMode, setSignupMode] = useState(false);
  const [loginState, setLoginState] = useState('checking'); // checking | out | busy | in
  const [loginMsg, setLoginMsg] = useState('');
  const [submissions, setSubmissions] = useState([]);
  const [sheetResults, setSheetResults] = useState([]);
  const [fetchingId, setFetchingId] = useState(null);
  const [currentSubmissionId, setCurrentSubmissionId] = useState(null);
  const apiReady = !!teacher;

  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const abortRef = useRef(null);
  const poseRef = useRef(null);
  const fpsRef = useRef(fps);
  const liveRef = useRef({ recent: [] });
  useEffect(() => { fpsRef.current = fps; }, [fps]);

  const stats = useMemo(() => summarize(events), [events]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // 영상 URL 정리
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  // ── 선생님 로그인 / 제출 목록 ──
  const refreshFromServer = useCallback(async () => {
    const [subs, res] = await Promise.all([listSubmissions(), listResults()]);
    setSubmissions(subs);
    setSheetResults(res);
  }, []);

  // 페이지를 열 때 이미 로그인된 선생님이 있으면 그대로 이어감
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await teacherMe();
        if (cancelled) return;
        if (me) { setTeacher(me); await refreshFromServer(); setLoginState('in'); }
        else setLoginState('out');
      } catch (e) {
        if (!cancelled) { setLoginState('out'); setLoginMsg(e?.message || ''); }
      }
    })();
    return () => { cancelled = true; };
  }, [refreshFromServer]);

  const doLogin = async () => {
    if (!loginDraft.username.trim() || !loginDraft.password) { setLoginMsg('아이디와 비밀번호를 입력해 주세요.'); return; }
    setLoginState('busy'); setLoginMsg('');
    try {
      const me = signupMode ? await teacherSignup(loginDraft) : await teacherLogin(loginDraft);
      setTeacher(me);
      await refreshFromServer();
      setLoginState('in');
      setSignupMode(false);
      setLoginDraft((d) => ({ ...d, password: '', code: '' }));
    } catch (e) {
      setLoginState('out'); setLoginMsg(e?.message || '로그인에 실패했습니다.');
    }
  };

  const doLogout = async () => {
    await teacherLogout();
    setTeacher(null); setSubmissions([]); setSheetResults([]); setLoginState('out'); setSignupMode(false);
  };

  const gradeSubmission = async (item) => {
    setFetchingId(item.id);
    try {
      const blob = await fetchVideo(item.path);
      setInfo((v) => ({ ...v, date: item.date || v.date, className: item.className, student1: item.student1, student2: item.student2, memo: '' }));
      setCurrentSubmissionId(item.id);
      onPickFile(blob, item.fileName || 'video.webm');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setToast(e?.message || '영상을 가져오지 못했습니다.');
    } finally {
      setFetchingId(null);
    }
  };

  const removeSubmission = async (item) => {
    if (!window.confirm(`${item.student1} · ${item.student2} 제출 영상을 지울까요? (저장 공간을 비웁니다. 채점 결과는 남습니다)`)) return;
    try {
      await deleteSubmission(item);
      await refreshFromServer();
      setToast('영상을 지웠습니다.');
    } catch (e) {
      setToast(e?.message || '삭제에 실패했습니다.');
    }
  };

  // ── 오버레이 그리기 ──
  const drawOverlay = useCallback((frame, extra = {}) => {
    const canvas = overlayRef.current, video = videoRef.current;
    if (!canvas || !video || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const lw = Math.max(2, W / 320);

    // 바닥선
    if (extra.groundY != null) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.setLineDash([lw * 4, lw * 4]);
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(0, extra.groundY * H); ctx.lineTo(W, extra.groundY * H); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 최근 궤적
    if (extra.recent?.length > 1) {
      ctx.strokeStyle = 'rgba(255, 214, 0, 0.8)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      extra.recent.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * W, p.y * H); else ctx.lineTo(p.x * W, p.y * H); });
      ctx.stroke();
    }
    if (!frame) return;
    // 손목
    for (const person of frame.people || []) {
      for (const w of person.wrists || []) {
        ctx.fillStyle = 'rgba(0, 200, 255, 0.9)';
        ctx.beginPath(); ctx.arc(w.x * W, w.y * H, lw * 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    // 공
    if (frame.found) {
      const r = Math.max(lw * 4, (frame.r || 0.01) * W * 1.8);
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath(); ctx.arc(frame.x * W, frame.y * H, r, 0, Math.PI * 2); ctx.stroke();
    }
    // 이벤트 표시
    if (extra.event) {
      const e = extra.event;
      ctx.fillStyle = e.type === 'catch' ? 'rgba(52, 199, 89, 0.9)' : 'rgba(255, 59, 48, 0.9)';
      ctx.font = `bold ${Math.round(W / 18)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(e.type === 'catch' ? '성공!' : '실패', e.x * W, Math.max(W / 18, e.y * H - W / 30));
    }
  }, []);

  // 분석이 끝난 뒤: 영상 재생 위치에 맞춰 오버레이 표시
  useEffect(() => {
    if (status !== 'done' || !track) return;
    let raf;
    const loop = () => {
      const video = videoRef.current;
      if (video) {
        const t = video.currentTime;
        const idx = Math.min(track.length - 1, Math.max(0, Math.round(t * fpsRef.current)));
        const frame = track[idx];
        const recent = track.slice(Math.max(0, idx - 8), idx + 1).filter((f) => f.found).map((f) => ({ x: f.x, y: f.y }));
        const event = events.find((e) => Math.abs(e.t - t) < 0.35);
        drawOverlay(frame, { recent, groundY, event });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status, track, events, groundY, drawOverlay]);

  // ── 영상 선택 ──
  const onPickFile = (file, name) => {
    if (!file) return;
    if (abortRef.current) abortRef.current.abort();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (!name) setCurrentSubmissionId(null); // 직접 고른 파일은 제출물이 아님
    setVideoUrl(URL.createObjectURL(file));
    setVideoName(name || file.name);
    setDuration(null);
    setTrack(null); setEvents([]); setGroundY(null); setFoundRatio(null);
    setErrorMsg(''); setPoseNote(''); setMaskPreview(null);
    setStatus('loading');
  };

  // 영상 메타데이터가 읽히면 바로 채점 시작
  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    if (status === 'loading') startAnalysis();
  };

  const startAnalysis = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) { setErrorMsg('영상을 읽을 수 없습니다. 다른 형식(mp4)으로 저장해서 다시 올려 주세요.'); setStatus('error'); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setErrorMsg(''); setTrack(null); setEvents([]); setFoundRatio(null);
    video.pause();
    await ensureDuration(video);
    if (controller.signal.aborted) return;
    setDuration(video.duration);

    let pose = null;
    if (usePose) {
      setStatus('pose');
      try {
        pose = poseRef.current || (await loadPoseLandmarker({ numPoses: 2 }));
        poseRef.current = pose;
        setPoseNote('');
      } catch (e) {
        console.warn(e);
        setPoseNote('손 인식 모델을 불러오지 못해 공 궤적만으로 판정합니다. (인터넷 연결 확인)');
      }
    } else {
      setPoseNote('손 인식을 끄고 공 궤적만으로 판정합니다.');
    }
    if (controller.signal.aborted) return;

    setStatus('analyzing');
    liveRef.current = { recent: [] };
    try {
      let frameCount = 0;
      const result = await analyzeVideo(video, {
        fps,
        ballParams,
        poseLandmarker: pose,
        signal: controller.signal,
        onFrame: ({ frame, index, total }) => {
          frameCount++;
          if (frame.found) {
            liveRef.current.recent.push({ x: frame.x, y: frame.y });
            if (liveRef.current.recent.length > 8) liveRef.current.recent.shift();
          }
          drawOverlay(frame, { recent: liveRef.current.recent });
          if (index % 3 === 0 || index === total - 1) setProgress({ index: index + 1, total });
        },
      });
      if (controller.signal.aborted) return;
      const found = result.filter((f) => f.found).length;
      setFoundRatio(frameCount ? found / frameCount : 0);
      const { events: evs, groundY: g } = detectEvents(result, { minTravel });
      setTrack(result); setEvents(evs); setGroundY(g);
      window.__catchballDebug = { track: result, events: evs, groundY: g }; // 문제 확인용 (콘솔에서 볼 수 있음)
      setStatus('done');
      video.currentTime = 0;
    } catch (e) {
      if (e?.name === 'AbortError') { setStatus('idle'); return; }
      console.error(e);
      setErrorMsg(e?.message || '분석 중 문제가 생겼습니다.');
      setStatus('error');
    }
  };

  const cancelAnalysis = () => { abortRef.current?.abort(); setStatus('idle'); };

  // 판정 기준(최소 던지기 거리)만 바뀐 경우: 영상 다시 안 보고 바로 재계산
  const reapplyEvents = (nextMinTravel) => {
    if (!track) return;
    const { events: evs, groundY: g } = detectEvents(track, { minTravel: nextMinTravel });
    setEvents(evs); setGroundY(g);
  };

  // ── 이벤트 편집 ──
  const seekTo = (t) => { const v = videoRef.current; if (v) { v.pause(); v.currentTime = Math.max(0, t); } };
  const toggleEvent = (i) => setEvents((list) => list.map((e, k) => (k === i ? { ...e, type: e.type === 'catch' ? 'drop' : 'catch', auto: false, confidence: 1, reason: '선생님이 수정' } : e)));
  const removeEvent = (i) => setEvents((list) => list.filter((_, k) => k !== i));
  const addEventNow = (type) => {
    const v = videoRef.current;
    const t = Math.round((v?.currentTime || 0) * 100) / 100;
    const idx = track ? Math.min(track.length - 1, Math.round(t * fps)) : -1;
    const f = idx >= 0 ? track[idx] : null;
    setEvents((list) => [...list, { t, x: f?.found ? f.x : 0.5, y: f?.found ? f.y : 0.4, type, confidence: 1, reason: '선생님이 직접 추가', auto: false }].sort((a, b) => a.t - b.t));
  };

  // ── 공 색 확인 ──
  const checkBallColor = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) { setToast('먼저 영상을 올려 주세요.'); return; }
    const { canvas, img, ball, width, height } = previewMask(video, ballParams);
    const ctx = canvas.getContext('2d');
    // 공 색으로 잡힌 픽셀을 빨갛게
    const out = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const j = i * 4;
      const r = img.data[j], g = img.data[j + 1], b = img.data[j + 2];
      const gray = (r + g + b) / 3 * 0.5;
      out.data[j] = gray; out.data[j + 1] = gray; out.data[j + 2] = gray; out.data[j + 3] = 255;
    }
    // 공 색으로 잡힌 픽셀을 빨갛게 (detectBall 내부와 같은 기준)
    const mask = makeColorMask(img.data, width, height, ballParams);
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const j = i * 4; out.data[j] = 255; out.data[j + 1] = 40; out.data[j + 2] = 40; }
    ctx.putImageData(out, 0, 0);
    if (ball) {
      ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ball.x * width, ball.y * height, Math.max(8, ball.r * width * 2), 0, Math.PI * 2); ctx.stroke();
    }
    setMaskPreview({ url: canvas.toDataURL('image/png'), found: !!ball });
  };

  // ── 저장 ──
  const [saving, setSaving] = useState(false);
  const saveRecord = async () => {
    if (!info.student1.trim() || !info.student2.trim()) { setToast('학생 두 명의 이름(또는 번호)을 적어 주세요.'); return; }
    const record = {
      date: info.date,
      className: info.className.trim(),
      student1: info.student1.trim(),
      student2: info.student2.trim(),
      memo: info.memo.trim(),
      success: stats.success,
      fail: stats.fail,
      bestStreak: stats.bestStreak,
      duration: duration ? Math.round(duration) : null,
      videoName,
      submissionId: currentSubmissionId,
      events,
    };
    addRecord(record);
    setRecords(loadRecords());
    if (apiReady) {
      setSaving(true);
      try {
        await saveResult(record);
        await refreshFromServer();
        setToast('서버에 저장했습니다.');
      } catch (e) {
        setToast('이 기기에는 저장했지만 서버 저장은 실패했습니다: ' + (e?.message || ''));
      } finally {
        setSaving(false);
      }
    } else {
      setToast('기록을 저장했습니다.');
    }
    setInfo((v) => ({ ...v, student1: '', student2: '', memo: '' }));
    setCurrentSubmissionId(null);
  };

  const onDeleteRecord = (id) => {
    if (!window.confirm('이 기록을 지울까요?')) return;
    setRecords(deleteRecord(id));
  };

  const busy = status === 'loading' || status === 'pose' || status === 'analyzing';
  const pct = progress.total ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <div className="cb-app">
      <header className="cb-header">
        <h1>⚾ 캐치볼 영상 평가 <span className="cb-sub">선생님</span></h1>
        <p>영상을 올리면 노란 공과 아이들의 손을 찾아 몇 번 주고받았는지 자동으로 셉니다. 영상은 이 기기 밖으로 나가지 않습니다.</p>
      </header>

      {/* 0. 선생님 로그인 */}
      <section className="cb-card cb-login">
        {loginState === 'checking' && <p className="cb-note">로그인 상태 확인 중...</p>}
        {loginState === 'in' && teacher && (
          <div className="cb-row" style={{ margin: 0, alignItems: 'center' }}>
            <span>👩‍🏫 <b>{teacher.username}</b> 선생님으로 로그인됨 · 제출된 영상과 채점 결과가 서버에 저장됩니다</span>
            <button type="button" className="cb-btn ghost" style={{ marginLeft: 'auto' }} onClick={doLogout}>로그아웃</button>
          </div>
        )}
        {(loginState === 'out' || loginState === 'busy') && (
          <>
            <h2>{signupMode ? '선생님 계정 만들기' : '선생님 로그인'} <span className="cb-sub">{signupMode ? '처음 한 번만. 첫 선생님은 가입 코드 없이, 그 다음부터는 가입 코드가 필요해요' : '로그인하면 학생이 올린 영상을 보고 결과를 서버에 저장할 수 있어요'}</span></h2>
            <div className="cb-grid">
              <label>아이디<input autoComplete="username" value={loginDraft.username} onChange={(e) => setLoginDraft({ ...loginDraft, username: e.target.value })} /></label>
              <label>비밀번호<input type="password" autoComplete={signupMode ? 'new-password' : 'current-password'} value={loginDraft.password} onChange={(e) => setLoginDraft({ ...loginDraft, password: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }} /></label>
              {signupMode && <label>가입 코드 <span className="cb-sub">(첫 선생님은 비워 두세요)</span><input value={loginDraft.code} onChange={(e) => setLoginDraft({ ...loginDraft, code: e.target.value })} /></label>}
            </div>
            <div className="cb-row">
              <button type="button" className="cb-btn" onClick={doLogin} disabled={loginState === 'busy'}>{loginState === 'busy' ? '확인 중...' : signupMode ? '계정 만들기' : '로그인'}</button>
              <button type="button" className="cb-btn ghost" onClick={() => { setSignupMode((v) => !v); setLoginMsg(''); }}>{signupMode ? '이미 계정이 있어요' : '계정 만들기'}</button>
            </div>
            <p className="cb-note">로그인 없이도 이 기기에서 영상을 올려 채점하고 기록할 수 있어요.</p>
            {loginMsg && <p className="cb-error">{loginMsg}</p>}
          </>
        )}
      </section>

      {/* 1. 학생 정보 */}
      <section className="cb-card">
        <h2>1. 누구를 평가하나요?</h2>
        <div className="cb-grid">
          <label>평가일<input type="date" value={info.date} onChange={(e) => setInfo({ ...info, date: e.target.value })} /></label>
          <label>반<input placeholder="예: 1학년 3반" value={info.className} onChange={(e) => setInfo({ ...info, className: e.target.value })} /></label>
          <label>학생 1<input placeholder="이름 또는 번호" value={info.student1} onChange={(e) => setInfo({ ...info, student1: e.target.value })} /></label>
          <label>학생 2<input placeholder="이름 또는 번호" value={info.student2} onChange={(e) => setInfo({ ...info, student2: e.target.value })} /></label>
        </div>
      </section>

      {/* 2. 영상 */}
      <section className="cb-card">
        <h2>2. 영상 올리기 <span className="cb-sub">올리면 바로 채점이 시작됩니다</span></h2>
        <label
          className={`cb-drop ${busy ? 'is-busy' : ''}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); onPickFile(e.dataTransfer.files?.[0]); }}
        >
          <input type="file" accept="video/*" onChange={(e) => onPickFile(e.target.files?.[0])} disabled={busy} />
          <span>{videoName ? `📼 ${videoName}` : '여기를 눌러 영상을 고르거나, 파일을 끌어다 놓으세요'}</span>
          <small>휴대폰으로 찍은 mp4/mov 그대로 올리면 됩니다. 1분 영상 기준 1~3분 걸립니다.</small>
        </label>

        {videoUrl && (
          <div className="cb-video-wrap">
            <video ref={videoRef} src={videoUrl} controls={status === 'done'} playsInline muted preload="auto" onLoadedMetadata={onLoadedMetadata} onError={() => { setErrorMsg('이 영상은 브라우저가 재생하지 못합니다. mp4(H.264)로 변환해서 다시 올려 주세요.'); setStatus('error'); }} />
            <canvas ref={overlayRef} className="cb-overlay" />
            {busy && (
              <div className="cb-progress">
                <div className="cb-progress-bar"><div style={{ width: `${status === 'analyzing' ? pct : 0}%` }} /></div>
                <div className="cb-progress-text">
                  {status === 'loading' && '영상을 읽는 중...'}
                  {status === 'pose' && '손 인식 모델을 준비하는 중... (처음 한 번만 몇 초 걸립니다)'}
                  {status === 'analyzing' && `채점 중 ${pct}% (${progress.index}/${progress.total}장)`}
                </div>
                <button type="button" className="cb-btn ghost" onClick={cancelAnalysis}>취소</button>
              </div>
            )}
          </div>
        )}
        {poseNote && <p className="cb-note">ℹ️ {poseNote}</p>}
        {errorMsg && <p className="cb-error">⚠️ {errorMsg}</p>}
        {status === 'done' && foundRatio != null && foundRatio < 0.3 && (
          <p className="cb-warn">⚠️ 전체 장면의 {Math.round(foundRatio * 100)}%에서만 공을 찾았습니다. 아래 "설정"에서 <b>공 색 확인</b>을 눌러 공이 빨갛게 표시되는지 보고, 색 범위를 조정한 뒤 다시 채점해 보세요.</p>
        )}

        <button type="button" className="cb-link" onClick={() => setShowSettings((v) => !v)}>{showSettings ? '▲ 설정 닫기' : '▼ 설정 (공 색, 인식 세기, 판정 기준)'}</button>
        {showSettings && (
          <div className="cb-settings">
            <label>분석 속도
              <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>{FPS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </label>
            <label className="cb-check"><input type="checkbox" checked={usePose} onChange={(e) => setUsePose(e.target.checked)} /> 손 인식 사용 (끄면 빨라지지만 공 궤적만으로 판정)</label>
            <div className="cb-slider-group">
              <div className="cb-slider-title">공 색 범위 <small>(노란색 기본값: 색상 38~72)</small></div>
              <label>색상 최소 {ballParams.hueMin}<input type="range" min="0" max="360" value={ballParams.hueMin} onChange={(e) => setBallParams({ ...ballParams, hueMin: Number(e.target.value) })} /></label>
              <label>색상 최대 {ballParams.hueMax}<input type="range" min="0" max="360" value={ballParams.hueMax} onChange={(e) => setBallParams({ ...ballParams, hueMax: Number(e.target.value) })} /></label>
              <label>선명함 최소 {Math.round(ballParams.satMin * 100)}%<input type="range" min="0" max="100" value={Math.round(ballParams.satMin * 100)} onChange={(e) => setBallParams({ ...ballParams, satMin: Number(e.target.value) / 100 })} /></label>
              <label>밝기 최소 {Math.round(ballParams.valMin * 100)}%<input type="range" min="0" max="100" value={Math.round(ballParams.valMin * 100)} onChange={(e) => setBallParams({ ...ballParams, valMin: Number(e.target.value) / 100 })} /></label>
              <div className="cb-row">
                <button type="button" className="cb-btn ghost" onClick={checkBallColor} disabled={!videoUrl || busy}>지금 장면에서 공 색 확인</button>
                <button type="button" className="cb-btn ghost" onClick={() => setBallParams({ ...DEFAULT_BALL_PARAMS })}>노란색 기본값</button>
              </div>
              {maskPreview && (
                <div className="cb-mask">
                  <img src={maskPreview.url} alt="공 색으로 잡힌 부분" />
                  <small>{maskPreview.found ? '✅ 빨간 부분 중 하늘색 동그라미가 공으로 선택되었습니다. 공만 빨갛게 보이면 좋습니다.' : '❌ 이 장면에서 공을 못 찾았습니다. 공이 보이는 장면으로 옮기거나 색 범위를 넓혀 보세요.'}</small>
                </div>
              )}
            </div>
            <div className="cb-slider-group">
              <div className="cb-slider-title">판정 기준</div>
              <label>최소 던지기 거리 (화면 너비의 {Math.round(minTravel * 100)}%)
                <input type="range" min="4" max="40" value={Math.round(minTravel * 100)} onChange={(e) => { const v = Number(e.target.value) / 100; setMinTravel(v); reapplyEvents(v); }} />
                <small>두 아이가 화면에서 멀리 떨어져 있으면 높이고, 가까우면 낮추세요. 영상 분석 없이 바로 다시 계산됩니다.</small>
              </label>
            </div>
            <button type="button" className="cb-btn" onClick={startAnalysis} disabled={!videoUrl || busy}>바뀐 설정으로 다시 채점</button>

          </div>
        )}
      </section>

      {/* 제출된 영상 (로그인 시) */}
      {apiReady && (
        <section className="cb-card">
          <h2>📥 학생이 제출한 영상 <span className="cb-sub">{submissions.length}건</span>
            <button type="button" className="cb-link" style={{ padding: 0, marginLeft: 'auto' }} onClick={() => refreshFromServer().catch((e) => setToast(e?.message || '새로고침 실패'))}>새로고침</button>
          </h2>
          {submissions.length === 0 ? (
            <p className="cb-note">아직 제출된 영상이 없습니다. 학생 제출 페이지 주소를 학생들에게 보내 주세요: <code>{new URL('./', window.location.href).toString()}</code> (학생은 같은 주소에서 "학생 제출" 화면을 씁니다)</p>
          ) : (
            <ul className="cb-sub-list">
              {submissions.map((it) => (
                <li key={it.id} className={it.status === '채점완료' ? 'graded' : ''}>
                  <div>
                    <div><b>{it.student1} · {it.student2}</b> <span className="cb-sub">{it.className}</span>
                      <span className={`cb-pill ${it.status === '채점완료' ? 'done' : ''}`}>{it.status || '미채점'}</span></div>
                    <div className="meta">{it.date} · {it.sizeMb}MB{it.durationSec ? ` · ${fmtTime(it.durationSec)}` : ''}{it.autoSuccess != null ? ` · 촬영 중 자동 카운트: 성공 ${it.autoSuccess} · 실패 ${it.autoFail}` : ''}</div>
                  </div>
                  <div className="cb-row" style={{ margin: 0 }}>
                    <button type="button" className="cb-btn" onClick={() => gradeSubmission(it)} disabled={busy || fetchingId != null}>{fetchingId === it.id ? '가져오는 중...' : it.status === '채점완료' ? '다시 채점' : '채점'}</button>
                    <button type="button" className="cb-x" title="영상 지우기" onClick={() => removeSubmission(it)}>✕</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 3. 결과 */}
      {status === 'done' && (
        <section className="cb-card">
          <h2>3. 채점 결과 <span className="cb-sub">틀린 곳은 눌러서 바로 고칠 수 있어요</span></h2>
          <div className="cb-stats">
            <div className="cb-stat ok"><b>{stats.success}</b><span>성공</span></div>
            <div className="cb-stat bad"><b>{stats.fail}</b><span>실패</span></div>
            <div className="cb-stat"><b>{stats.bestStreak}</b><span>최대 연속</span></div>
            <div className="cb-stat"><b>{stats.total ? Math.round((stats.success / stats.total) * 100) : 0}%</b><span>성공률</span></div>
          </div>
          <div className="cb-row">
            <button type="button" className="cb-btn ok" onClick={() => addEventNow('catch')}>+ 지금 장면에 성공 추가</button>
            <button type="button" className="cb-btn bad" onClick={() => addEventNow('drop')}>+ 지금 장면에 실패 추가</button>
          </div>
          {events.length === 0 ? (
            <p className="cb-note">캐치가 하나도 잡히지 않았습니다. 영상을 재생하면서 위 버튼으로 직접 넣거나, 설정에서 공 색을 확인해 주세요.</p>
          ) : (
            <ol className="cb-events">
              {events.map((e, i) => (
                <li key={`${e.t}-${i}`} className={e.type}>
                  <button type="button" className="cb-time" onClick={() => seekTo(e.t)} title="이 장면 보기">▶ {fmtTime(e.t)}</button>
                  <button type="button" className={`cb-badge ${e.type}`} onClick={() => toggleEvent(i)} title="눌러서 성공/실패 바꾸기">{e.type === 'catch' ? '성공' : '실패'}</button>
                  <span className="cb-reason">{e.reason}{e.auto && e.confidence != null ? ` · 확신 ${Math.round(e.confidence * 100)}%` : ''}</span>
                  <button type="button" className="cb-x" onClick={() => removeEvent(i)} title="지우기">✕</button>
                </li>
              ))}
            </ol>
          )}
          <label className="cb-memo">비고<input placeholder="예: 바람이 많이 불었음" value={info.memo} onChange={(e) => setInfo({ ...info, memo: e.target.value })} /></label>
          <button type="button" className="cb-btn big" onClick={saveRecord} disabled={saving}>{saving ? '저장 중...' : apiReady ? '이 결과 서버에 저장하기' : '이 결과 저장하기'}</button>
        </section>
      )}

      {/* 4. 기록 */}
      <section className="cb-card">
        <h2>4. 저장된 기록 <span className="cb-sub">{apiReady ? '서버에 저장된 채점 결과' : '이 기기에 저장됩니다'}</span></h2>
        {apiReady && (
          sheetResults.length === 0 ? <p className="cb-note">서버에 아직 채점 결과가 없습니다.</p> : (
            <div className="cb-table-wrap">
              <table className="cb-table">
                <thead><tr><th>평가일</th><th>반</th><th>학생</th><th>성공</th><th>실패</th><th>연속</th></tr></thead>
                <tbody>
                  {sheetResults.map((r) => (
                    <tr key={r.id}>
                      <td>{r.date}</td><td>{r.className}</td><td>{r.student1} · {r.student2}</td>
                      <td className="ok">{r.success}</td><td className="bad">{r.fail}</td><td>{r.bestStreak}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {apiReady && records.length > 0 && <p className="cb-note" style={{ marginTop: 12 }}>아래는 이 기기에 저장된 기록입니다.</p>}
        {records.length === 0 ? (
          !apiReady && <p className="cb-note">아직 저장된 기록이 없습니다.</p>
        ) : (
          <>
            <div className="cb-table-wrap">
              <table className="cb-table">
                <thead><tr><th>평가일</th><th>반</th><th>학생</th><th>성공</th><th>실패</th><th>연속</th><th></th></tr></thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td>{r.date}</td><td>{r.className}</td><td>{r.student1} · {r.student2}</td>
                      <td className="ok">{r.success}</td><td className="bad">{r.fail}</td><td>{r.bestStreak}</td>
                      <td><button type="button" className="cb-x" onClick={() => onDeleteRecord(r.id)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="cb-btn ghost" onClick={() => exportRecordsToExcel(records)}>📥 엑셀로 내려받기</button>
          </>
        )}
      </section>

      <section className="cb-card cb-tips">
        <h2>잘 찍는 요령</h2>
        <ul>
          <li>두 아이가 <b>옆모습</b>으로 한 화면에 들어오게, 공이 화면에서 <b>좌우로</b> 오가도록 찍어 주세요.</li>
          <li>휴대폰을 <b>고정</b>(삼각대나 책상 위)하고, 한 영상에는 <b>한 팀(2명)</b>만 나오게 해 주세요.</li>
          <li>노란 공이 잘 보이도록 노란 옷·노란 배경은 피하고, 역광은 피해 주세요.</li>
          <li>자동 판정은 참고용입니다. 결과 목록에서 성공/실패를 눌러 바꾸거나 지우고, 빠진 건 추가해 주세요.</li>
        </ul>
      </section>

      {toast && <div className="cb-toast">{toast}</div>}
    </div>
  );
}
