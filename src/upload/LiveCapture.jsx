import { useEffect, useRef, useState } from 'react';
import { submitVideo } from '../api.js';
import { canRecord, createLiveAnalyzer, createRecorder, drawLiveOverlay, openCamera, stopStream } from '../live.js';
import { loadPoseLandmarker } from '../pose.js';
import { DEFAULT_BALL_PARAMS, sampleBallParams } from '../analysis.js';

const MB = 1024 * 1024;

function fmt(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

/**
 * 앱 안에서 촬영 → 실시간 카운트 → 촬영 끝나면 자동 제출
 * props: info({date, className, student1, student2}), validate() → 오류문구|null, onDone(result)
 */
export default function LiveCapture({ info, validate, onDone }) {
  const [phase, setPhase] = useState('idle'); // idle | opening | ready | recording | uploading | done | error
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [live, setLive] = useState({ stats: { success: 0, fail: 0, bestStreak: 0 }, t: 0, poseMs: 0, poseOn: false });
  const [result, setResult] = useState(null);
  const [ballParams, setBallParams] = useState({ ...DEFAULT_BALL_PARAMS });
  const [ballPicked, setBallPicked] = useState(false);
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const streamRef = useRef(null);
  const analyzerRef = useRef(null);
  const recorderRef = useRef(null);
  const poseRef = useRef(null);
  const lastEventRef = useRef(null);
  const lastUiRef = useRef(0);

  useEffect(() => () => { analyzerRef.current?.stop?.(); stopStream(streamRef.current); }, []);

  const open = async () => {
    setMessage('');
    setPhase('opening');
    try {
      const stream = await openCamera();
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play();
      // 손·발목 인식 모델 (처음 한 번만 내려받음). 실패하면 공만으로 셈
      try {
        poseRef.current = poseRef.current || (await loadPoseLandmarker({ numPoses: 2 }));
        // 첫 인식은 몇 초 걸리므로 촬영 전에 미리 한 번 돌려 둠 (촬영 시작 직후 멈춤 방지)
        try { if (v.videoWidth) poseRef.current.detectForVideo(v, Math.round(performance.now())); } catch { /* 무시 */ }
        setLive((s) => ({ ...s, poseOn: true }));
      } catch (e) {
        console.warn('포즈 모델 불러오기 실패', e);
        setMessage('손 인식 모델을 못 불러와 공만으로 셉니다.');
      }
      setPhase('ready');
    } catch (e) {
      setPhase('error');
      setMessage(e?.message || '카메라를 열 수 없습니다.');
    }
  };

  const startRecording = () => {
    const err = validate?.();
    if (err) { setMessage(err); return; }
    const v = videoRef.current;
    try {
      recorderRef.current = createRecorder(streamRef.current);
    } catch (e) { setMessage(e?.message || '녹화를 시작할 수 없습니다.'); return; }
    lastEventRef.current = null;
    const analyzer = createLiveAnalyzer({
      video: v,
      fps: 15,
      ballParams,
      poseLandmarker: poseRef.current,
      onUpdate: ({ frame, recent, stats, events, groundY, poseMs, t }) => {
        const latest = events[events.length - 1];
        if (latest && latest !== lastEventRef.current) { lastEventRef.current = latest; lastEventRef.flashUntil = performance.now() + 900; }
        const flash = lastEventRef.flashUntil > performance.now() ? lastEventRef.current : null;
        drawLiveOverlay(overlayRef.current, v, { frame, recent, groundY, stats, event: flash });
        const now = performance.now();
        if (now - lastUiRef.current > 250) { lastUiRef.current = now; setLive((s) => ({ ...s, stats, t, poseMs })); }
      },
    });
    analyzerRef.current = analyzer;
    recorderRef.current.start();
    analyzer.start();
    setMessage('');
    setPhase('recording');
  };

  const stopRecording = async () => {
    const analyzer = analyzerRef.current, recorder = recorderRef.current;
    if (!analyzer || !recorder) return;
    setPhase('uploading');
    setProgress(0);
    const final = analyzer.stop();
    analyzerRef.current = null;
    window.__catchballLive = final; // 문제 확인용 (콘솔에서 볼 수 있음)
    let blob;
    try {
      blob = await recorder.stop();
    } catch (e) {
      setPhase('error'); setMessage('녹화 파일을 만들지 못했습니다: ' + (e?.message || '')); return;
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    const summary = { stats: final.stats, events: final.events, sizeMb: Math.round(blob.size / MB * 10) / 10, duration: Math.round(final.track[final.track.length - 1]?.t || 0) };
    setResult(summary);
    try {
      const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
      const r = await submitVideo({
        info: { className: info.className.trim(), student1: info.student1.trim(), student2: info.student2.trim(), date: info.date },
        blob,
        fileName: `${info.student1.trim()}_${info.student2.trim()}.${ext}`,
        durationSec: summary.duration,
        extra: { autoSuccess: final.stats.success, autoFail: final.stats.fail, autoEvents: final.events.map((e) => ({ t: e.t, type: e.type })) },
        onStatus: setMessage,
        onProgress: setProgress,
      });
      setResult({ ...summary, ...r });
      setPhase('done');
      setMessage('');
      onDone?.({ ...summary, ...r });
    } catch (e) {
      console.error(e);
      setPhase('error');
      setMessage((e?.message || '올리는 중 문제가 생겼습니다.') + ' 촬영한 영상은 아래 버튼으로 다시 올릴 수 있습니다.');
      setResult({ ...summary, blob });
    }
  };

  const retryUpload = async () => {
    if (!result?.blob) return;
    setPhase('uploading'); setProgress(0);
    try {
      const ext = /mp4/.test(result.blob.type) ? 'mp4' : 'webm';
      const r = await submitVideo({
        info: { className: info.className.trim(), student1: info.student1.trim(), student2: info.student2.trim(), date: info.date },
        blob: result.blob, fileName: `${info.student1.trim()}_${info.student2.trim()}.${ext}`,
        durationSec: result.duration,
        extra: { autoSuccess: result.stats.success, autoFail: result.stats.fail, autoEvents: result.events.map((e) => ({ t: e.t, type: e.type })) },
        onStatus: setMessage, onProgress: setProgress,
      });
      setResult({ ...result, ...r, blob: null });
      setPhase('done'); setMessage('');
    } catch (e) {
      setPhase('error'); setMessage(e?.message || '다시 올리기에 실패했습니다.');
    }
  };

  // 촬영 전 미리보기에서 공을 누르면 그 색으로 기준을 잡음 (조명·공 색이 달라도 정확해짐)
  const onPreviewClick = (e) => {
    if (phase !== 'ready') return;
    const v = videoRef.current, canvas = overlayRef.current;
    if (!v?.videoWidth || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / v.videoWidth, rect.height / v.videoHeight);
    const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
    const nx = (e.clientX - rect.left - (rect.width - dw) / 2) / dw, ny = (e.clientY - rect.top - (rect.height - dh) / 2) / dh;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    const w = 960, h = Math.round(v.videoHeight * w / v.videoWidth);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const params = sampleBallParams(ctx.getImageData(0, 0, w, h).data, w, h, nx, ny);
    if (!params) { setMessage('그 자리에서 공 색을 못 잡았어요. 공의 한가운데를 다시 눌러 주세요.'); return; }
    setBallParams({ ...DEFAULT_BALL_PARAMS, ...params });
    setBallPicked(true);
    setMessage(`공 색을 잡았어요 (색상 ${params.sample.h}). 이제 촬영을 시작하세요.`);
  };

  if (!canRecord()) {
    return <p className="cb-error">이 브라우저는 앱 안 촬영을 지원하지 않습니다. "찍어 둔 영상 올리기"를 이용해 주세요.</p>;
  }

  return (
    <div className="cb-live">
      <div className={`cb-video-wrap ${phase === 'idle' || phase === 'opening' ? 'is-hidden' : ''}`}>
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} className={`cb-overlay ${phase === 'ready' ? 'clickable' : ''}`} onClick={onPreviewClick} />
        {phase === 'recording' && (
          <div className="cb-rec-badge"><span className="dot" /> 촬영 중 {fmt(live.t)}{live.poseOn ? '' : ' · 공만 인식'}</div>
        )}
      </div>

      {phase === 'idle' && (
        <button type="button" className="cb-btn big" onClick={open}>📷 카메라 켜기</button>
      )}
      {phase === 'opening' && <p className="cb-note">카메라와 인식 모델을 준비하는 중... (처음 한 번은 몇 초 걸립니다)</p>}
      {phase === 'ready' && (
        <>
          <p className="cb-note">두 사람이 옆모습으로 화면에 다 들어오게 휴대폰을 고정하세요. <b>화면 속 공을 한 번 눌러</b> 공 색을 알려 주면 더 정확합니다{ballPicked ? ' (잡았어요 ✅)' : ''}. 준비되면 촬영을 시작하세요.</p>
          <button type="button" className="cb-btn big" onClick={startRecording}>⏺ 촬영 시작</button>
        </>
      )}
      {phase === 'recording' && (
        <>
          <div className="cb-stats" style={{ marginTop: 10 }}>
            <div className="cb-stat ok"><b>{live.stats.success}</b><span>성공</span></div>
            <div className="cb-stat bad"><b>{live.stats.fail}</b><span>실패</span></div>
            <div className="cb-stat"><b>{live.stats.bestStreak}</b><span>최대 연속</span></div>
            <div className="cb-stat"><b>{fmt(live.t)}</b><span>시간</span></div>
          </div>
          <button type="button" className="cb-btn big bad-solid" onClick={stopRecording}>⏹ 촬영 끝 (자동으로 올라갑니다)</button>
        </>
      )}
      {phase === 'uploading' && (
        <div className="cb-upload-progress">
          {result && <p className="cb-note">촬영 중 센 결과: 성공 {result.stats.success} · 실패 {result.stats.fail} ({result.sizeMb}MB)</p>}
          <div className="cb-progress-bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="cb-progress-text dark">{message || '올리는 중'} {Math.round(progress * 100)}%</div>
        </div>
      )}
      {phase === 'done' && result && (
        <div className="cb-done">
          <h2>✅ 제출 완료!</h2>
          <div className="cb-stats">
            <div className="cb-stat ok"><b>{result.stats.success}</b><span>성공</span></div>
            <div className="cb-stat bad"><b>{result.stats.fail}</b><span>실패</span></div>
            <div className="cb-stat"><b>{result.stats.bestStreak}</b><span>최대 연속</span></div>
            <div className="cb-stat"><b>{fmt(result.duration)}</b><span>길이</span></div>
          </div>
          <p className="cb-note">자동으로 센 횟수는 참고용이고, 선생님이 영상을 보고 최종 확인합니다.</p>
        </div>
      )}
      {phase === 'error' && (
        <>
          <p className="cb-error">⚠️ {message}</p>
          <div className="cb-row">
            {result?.blob && <button type="button" className="cb-btn" onClick={retryUpload}>다시 올리기</button>}
            <button type="button" className="cb-btn ghost" onClick={() => { setPhase('idle'); setMessage(''); setResult(null); }}>처음부터</button>
          </div>
        </>
      )}
      {message && (phase === 'ready' || phase === 'recording') && <p className="cb-note">{message}</p>}
    </div>
  );
}
