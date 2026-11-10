import { useEffect, useRef, useState } from 'react';
import { submitVideo } from '../api.js';
import { canRecord, createRecorder, openCamera, stopStream } from '../live.js';
import { extractPeople, loadPoseLandmarker } from '../pose.js';

const MB = 1024 * 1024;
const CHECK_MS = 700;     // 구도 확인 주기
const EDGE = 0.07;        // 화면 가장자리 기준 (가로 비율)
const DRIFT = 0.28;       // 표시한 자리에서 이만큼 벗어나면 경고 (가로 비율)

function fmt(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

/**
 * 앱 안에서 촬영 → 촬영 끝나면 자동 제출. 횟수는 세지 않음.
 *  1. 카메라 켜기  2. 화면에서 두 학생이 선 자리를 눌러 표시  3. 촬영 (구도에서 벗어나면 경고, 최대 시간 지나면 자동 종료)  4. 자동 업로드
 * props: info({date, className, student1, student2}), validate() → 오류문구|null, maxSeconds, scriptUrl, onReset()
 */
export default function LiveCapture({ info, validate, maxSeconds = 60, scriptUrl = '', onReset }) {
  const [phase, setPhase] = useState('idle'); // idle | opening | mark | ready | recording | uploading | done | error
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [marks, setMarks] = useState([]); // [{x, footY}] 학생1, 학생2 자리 (0~1)
  const [warn, setWarn] = useState('');   // 구도 경고
  const [orientNote, setOrientNote] = useState('');
  const [framingOn, setFramingOn] = useState(false);
  const [result, setResult] = useState(null);
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const poseRef = useRef(null);
  const marksRef = useRef(marks);
  const badRef = useRef(0);
  const startAtRef = useRef(0);
  const stoppingRef = useRef(false);
  const stopRef = useRef(null); // 시간 초과 시 호출할 촬영 종료 함수
  useEffect(() => { marksRef.current = marks; }, [marks]);

  useEffect(() => () => { stopStream(streamRef.current); }, []);

  // ── 표시 그리기 (두 학생 자리) ──
  useEffect(() => {
    const canvas = overlayRef.current, v = videoRef.current;
    if (!canvas || !v?.videoWidth) return;
    if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) { canvas.width = v.videoWidth; canvas.height = v.videoHeight; }
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, lw = Math.max(2, W / 320);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `bold ${Math.round(W / 32)}px sans-serif`; ctx.textAlign = 'center';
    const names = [info.student1 || '학생 1', info.student2 || '학생 2'];
    marks.forEach((m, i) => {
      const x = m.x * W, y = m.footY * H;
      ctx.strokeStyle = i === 0 ? '#00c8ff' : '#ffd600'; ctx.lineWidth = lw * 1.5;
      ctx.beginPath(); ctx.moveTo(x - lw * 10, y); ctx.lineTo(x + lw * 10, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - lw * 14); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const label = names[i];
      const tw = ctx.measureText(label).width + lw * 6;
      ctx.fillRect(x - tw / 2, y + lw * 3, tw, W / 32 + lw * 4);
      ctx.fillStyle = i === 0 ? '#00c8ff' : '#ffd600';
      ctx.fillText(label, x, y + lw * 3 + W / 32 + lw);
    });
    if (phase === 'mark' && marks.length < 2) {
      // 아직 안 찍은 쪽 안내
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, W / 32 + lw * 8);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${names[marks.length]}이(가) 선 자리(발)를 눌러 주세요`, W / 2, W / 32 + lw * 3);
    }
  }, [marks, phase, info.student1, info.student2]);

  // ── 구도 확인: 두 사람이 다 보이는지, 가장자리에 붙지 않았는지, 표시한 자리에서 많이 벗어나지 않았는지 ──
  useEffect(() => {
    if (!(phase === 'mark' || phase === 'ready' || phase === 'recording')) return;
    const v = videoRef.current, pose = poseRef.current;
    if (!v || !pose) return;
    let stopped = false, running = false;
    const check = () => {
      if (stopped || running || !v.videoWidth) return;
      running = true;
      try {
        const res = pose.detectForVideo(v, Math.round(performance.now()));
        const people = extractPeople(res).filter((p) => p.cx != null);
        let msg = '';
        if (people.length < 2) msg = people.length === 0 ? '사람이 보이지 않아요. 두 사람이 모두 화면에 들어오게 해 주세요.' : '한 사람만 보여요. 두 사람이 모두 화면에 들어오게 해 주세요.';
        else if (people.some((p) => p.cx < EDGE || p.cx > 1 - EDGE)) msg = '화면 가장자리에 너무 가까워요. 뒤로 물러나거나 폰을 돌려 주세요.';
        else if (marksRef.current.length === 2) {
          const far = marksRef.current.some((m) => !people.some((p) => Math.abs(p.cx - m.x) < DRIFT));
          if (far) msg = '표시한 자리에서 많이 벗어났어요. 처음 자리로 돌아가 주세요.';
        }
        badRef.current = msg ? badRef.current + 1 : 0;
        if (msg && badRef.current >= 2) {
          setWarn((w) => { if (!w && navigator.vibrate) navigator.vibrate(200); return msg; });
        } else if (!msg) setWarn('');
      } catch (e) {
        console.warn('구도 확인 실패', e);
      } finally { running = false; }
    };
    const id = setInterval(check, CHECK_MS);
    check();
    return () => { stopped = true; clearInterval(id); };
  }, [phase, framingOn]);

  // ── 촬영 시간 ──
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => {
      const t = (performance.now() - startAtRef.current) / 1000;
      setElapsed(t);
      if (t >= maxSeconds) stopRef.current?.(true);
    }, 250);
    return () => clearInterval(id);
  }, [phase, maxSeconds]);

  const open = async () => {
    const err = validate?.();
    if (err) { setMessage(err); return; }
    setMessage('');
    setPhase('opening');
    try {
      const stream = await openCamera();
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play();
      setOrientNote(v.videoWidth && v.videoHeight && v.videoWidth < v.videoHeight ? '📱 폰을 가로로 눕혀서 찍어 주세요. (세로로 찍으면 두 사람이 다 안 들어가요)' : '');
      // 사람 인식 모델 (구도 확인용). 못 불러오면 경고 없이 진행
      try {
        poseRef.current = poseRef.current || (await loadPoseLandmarker({ numPoses: 2 }));
        try { if (v.videoWidth) poseRef.current.detectForVideo(v, Math.round(performance.now())); } catch { /* 무시 */ }
        setFramingOn(true);
      } catch (e) {
        console.warn('포즈 모델 불러오기 실패', e);
        setFramingOn(false);
      }
      setMarks([]);
      setPhase('mark');
    } catch (e) {
      setPhase('error');
      setMessage(e?.message || '카메라를 열 수 없습니다.');
    }
  };

  // 화면을 누른 자리 → 영상 좌표(0~1)
  const toNorm = (e) => {
    const v = videoRef.current, canvas = overlayRef.current;
    if (!v?.videoWidth || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / v.videoWidth, rect.height / v.videoHeight);
    const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
    const nx = (e.clientX - rect.left - (rect.width - dw) / 2) / dw, ny = (e.clientY - rect.top - (rect.height - dh) / 2) / dh;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { x: nx, footY: ny };
  };

  const onOverlayClick = (e) => {
    if (phase !== 'mark') return;
    const p = toNorm(e);
    if (!p) return;
    const next = [...marks, p].slice(0, 2);
    setMarks(next);
    if (next.length === 2) setPhase('ready');
  };

  const redoMarks = () => { setMarks([]); setPhase('mark'); setMessage(''); };

  const startRecording = () => {
    const err = validate?.();
    if (err) { setMessage(err); return; }
    try {
      recorderRef.current = createRecorder(streamRef.current);
    } catch (e) { setMessage(e?.message || '녹화를 시작할 수 없습니다.'); return; }
    stoppingRef.current = false;
    startAtRef.current = performance.now();
    setElapsed(0);
    recorderRef.current.start();
    setMessage('');
    setPhase('recording');
  };

  const stopRecording = async (auto = false) => {
    const recorder = recorderRef.current;
    if (!recorder || stoppingRef.current) return;
    stoppingRef.current = true;
    const duration = Math.round((performance.now() - startAtRef.current) / 1000);
    setPhase('uploading');
    setProgress(0); setWarn('');
    setMessage(auto ? `${maxSeconds}초가 지나 촬영을 마쳤어요. 올리는 중...` : '');
    let blob;
    try {
      blob = await recorder.stop();
    } catch (e) {
      setPhase('error'); setMessage('녹화 파일을 만들지 못했습니다: ' + (e?.message || '')); return;
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    await doUpload(blob, duration);
  };

  const doUpload = async (blob, duration) => {
    const base = { sizeMb: Math.round(blob.size / MB * 10) / 10, duration, blob };
    setResult(base);
    try {
      const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
      const r = await submitVideo({
        info, blob,
        fileName: `${info.student1}_${info.student2}.${ext}`,
        durationSec: duration,
        playerMarks: marksRef.current.length === 2 ? marksRef.current.map((m, i) => ({ x: m.x, footY: m.footY, name: i === 0 ? info.student1 : info.student2 })) : null,
        scriptUrl,
        onStatus: setMessage,
        onProgress: setProgress,
      });
      setResult({ ...base, ...r, blob: null });
      setPhase('done');
      setMessage('');
    } catch (e) {
      console.error(e);
      setPhase('error');
      setMessage((e?.message || '올리는 중 문제가 생겼습니다.') + ' 촬영한 영상은 아래 버튼으로 다시 올릴 수 있습니다.');
    }
  };

  useEffect(() => { stopRef.current = stopRecording; });

  const retryUpload = async () => {
    if (!result?.blob) return;
    setPhase('uploading'); setProgress(0);
    await doUpload(result.blob, result.duration);
  };

  if (!canRecord()) {
    return <p className="cb-error">이 브라우저는 앱 안 촬영을 지원하지 않습니다. "찍어 둔 영상 올리기"를 이용해 주세요.</p>;
  }

  const showVideo = phase === 'mark' || phase === 'ready' || phase === 'recording';
  const remain = Math.max(0, maxSeconds - elapsed);

  return (
    <div className="cb-live">
      <div className={`cb-video-wrap ${showVideo ? '' : 'is-hidden'}`}>
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} className={`cb-overlay ${phase === 'mark' ? 'clickable' : ''}`} onClick={onOverlayClick} />
        {phase === 'recording' && (
          <div className="cb-rec-badge"><span className="dot" /> 촬영 중 {fmt(elapsed)} · 남은 시간 {fmt(remain)}</div>
        )}
        {warn && showVideo && <div className="cb-frame-warn">⚠️ {warn}</div>}
      </div>

      {phase === 'idle' && (
        <>
          <p className="cb-note">반과 이름을 고른 뒤 카메라를 켜세요. 촬영 중에는 횟수를 세지 않습니다. 선생님이 영상을 보고 채점합니다.</p>
          <button type="button" className="cb-btn big" onClick={open}>📷 카메라 켜기</button>
          {message && <p className="cb-error">{message}</p>}
        </>
      )}
      {phase === 'opening' && <p className="cb-note">카메라를 준비하는 중... (처음 한 번은 몇 초 걸립니다)</p>}
      {phase === 'mark' && (
        <>
          {orientNote && <p className="cb-warn">{orientNote}</p>}
          <p className="cb-note"><b>{marks.length === 0 ? `${info.student1}이(가)` : `${info.student2}이(가)`} 선 자리(발 근처)를 화면에서 눌러 주세요.</b> 두 사람이 옆모습으로 모두 보이게 휴대폰을 고정한 뒤에 누르세요. {framingOn ? '두 사람이 화면에서 벗어나면 경고가 뜹니다.' : '(사람 인식 모델을 못 불러와 구도 경고는 뜨지 않습니다)'}</p>
          {marks.length > 0 && <button type="button" className="cb-btn ghost" onClick={redoMarks}>자리 다시 찍기</button>}
        </>
      )}
      {phase === 'ready' && (
        <>
          {orientNote && <p className="cb-warn">{orientNote}</p>}
          <p className="cb-note">두 사람 자리를 표시했어요 ✅. 준비되면 촬영을 시작하세요. 최대 {maxSeconds}초이고, 시간이 되면 자동으로 끝나고 올라갑니다.</p>
          <div className="cb-row" style={{ margin: 0 }}>
            <button type="button" className="cb-btn big" style={{ flex: 1 }} onClick={startRecording}>⏺ 촬영 시작</button>
            <button type="button" className="cb-btn ghost" onClick={redoMarks}>자리 다시 찍기</button>
          </div>
        </>
      )}
      {phase === 'recording' && (
        <>
          <p className="cb-note">촬영 중입니다. 다 하면 아래 버튼을 누르세요. 남은 시간 <b>{fmt(remain)}</b></p>
          <button type="button" className="cb-btn big bad-solid" onClick={() => stopRecording(false)}>⏹ 촬영 끝 (자동으로 올라갑니다)</button>
        </>
      )}
      {phase === 'uploading' && (
        <div className="cb-upload-progress">
          {result && <p className="cb-note">촬영 {fmt(result.duration)} · {result.sizeMb}MB</p>}
          <div className="cb-progress-bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="cb-progress-text dark">{message || '올리는 중'} {Math.round(progress * 100)}%</div>
        </div>
      )}
      {phase === 'done' && result && (
        <div className="cb-done">
          <h2>✅ 제출 완료!</h2>
          <p className="cb-big">{info.className} · {info.student1} · {info.student2}</p>
          <p className="cb-note">촬영 {fmt(result.duration)} · {result.sizeMb}MB · {result.storage === 'drive' ? '선생님 구글 드라이브에 저장됨' : '서버에 저장됨'}. 선생님이 영상을 보고 채점합니다.</p>
          <button type="button" className="cb-btn big" onClick={() => onReset?.()}>다른 팀 영상 올리기</button>
        </div>
      )}
      {phase === 'error' && (
        <>
          <p className="cb-error">⚠️ {message}</p>
          <div className="cb-row">
            {result?.blob && <button type="button" className="cb-btn" onClick={retryUpload}>다시 올리기</button>}
            <button type="button" className="cb-btn ghost" onClick={() => { setPhase('idle'); setMessage(''); setResult(null); setMarks([]); }}>처음부터</button>
          </div>
        </>
      )}
      {message && (phase === 'ready' || phase === 'recording' || phase === 'mark') && <p className="cb-error">{message}</p>}
    </div>
  );
}
