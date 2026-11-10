// 앱 안에서 촬영하면서 실시간으로 공·손(글러브)·발목을 인식하고 캐치 횟수를 세는 부분
import { createCameraMotion, createMotionMap, createStaticMap, createTrackletTracker, createTrackWriter, DEFAULT_BALL_PARAMS, detectBallCandidates, detectEvents, playBandMaxY, summarize } from './analysis.js';
import { extractPeople } from './pose.js';

export const LIVE_WIDTH = 960; // 멀리 있는 작은 공을 잡으려면 이 정도 필요 (휴대폰에서도 색 검출은 충분히 빠름)

export async function openCamera({ facingMode = 'environment' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저는 카메라를 지원하지 않습니다.');
  const constraints = {
    audio: false,
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (e?.name === 'NotAllowedError') throw new Error('카메라 사용을 허용해 주세요.');
    // 후면 카메라가 없으면 아무 카메라나
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

function pickRecorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function canRecord() {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** 카메라 영상 녹화기 */
export function createRecorder(stream, { bitsPerSecond = 1_500_000 } = {}) {
  const mimeType = pickRecorderType();
  if (mimeType == null) throw new Error('이 브라우저는 영상 녹화를 지원하지 않습니다.');
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitsPerSecond } : { videoBitsPerSecond: bitsPerSecond });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  let stopped;
  return {
    start() { stopped = new Promise((r) => { rec.onstop = r; }); rec.start(1000); },
    async stop() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      const type = (rec.mimeType || mimeType || 'video/webm').split(';')[0];
      return new Blob(chunks, { type });
    },
    get mimeType() { return (rec.mimeType || mimeType || 'video/webm').split(';')[0]; },
  };
}

/**
 * 실시간 분석기. video(카메라 미리보기)를 초당 fps 장 읽어 공·사람을 찾고, 0.5초마다 캐치 판정을 다시 계산.
 *   onUpdate({ frame, recent, stats, events, groundY, poseMs })
 */
export function createLiveAnalyzer({ video, fps = 15, ballParams = DEFAULT_BALL_PARAMS, poseLandmarker = null, eventParams = {}, onUpdate }) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const staticMap = createStaticMap({ staticFrames: Math.round(fps * 1.5) });
  const camera = createCameraMotion();
  const motion = createMotionMap();
  const track = [];
  const recentAnkles = [];
  let lastMaxY = 1;
  const writer = createTrackWriter(track, () => lastMaxY);
  const tracker = createTrackletTracker({ onConfirm: (points, stats) => writer.confirm(points, stats) });
  const recent = [];
  let t0 = 0, running = false, rafId = 0, lastTick = 0, lastEval = 0, lastPoseTs = -1, poseMs = 0, lastPoseEnd = 0;
  let events = [], groundY = null, stats = summarize([]);

  const tick = () => {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const now = performance.now();
    if (now - lastTick < 1000 / fps) return;
    lastTick = now;
    if (!video.videoWidth) return;
    if (canvas.width !== LIVE_WIDTH) {
      canvas.width = LIVE_WIDTH;
      canvas.height = Math.max(1, Math.round(video.videoHeight * LIVE_WIDTH / video.videoWidth));
    }
    const t = (now - t0) / 1000;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let people;
    // 포즈(손목·발목) 인식은 느린 기기에서 화면을 멈추게 하므로, 한 번 걸린 시간의 3배는 쉬고 다시 돌림
    // (포즈가 전체 시간의 1/4 이상 차지하지 않게). 공 추적은 매 프레임 그대로.
    const poseDue = poseLandmarker && now - lastPoseEnd >= Math.max(0, poseMs * 3);
    if (poseDue) {
      const ts = Math.max(lastPoseTs + 1, Math.round(now));
      lastPoseTs = ts;
      const p0 = performance.now();
      try { people = extractPeople(poseLandmarker.detectForVideo(canvas, ts)); } catch { people = undefined; }
      lastPoseEnd = performance.now();
      poseMs = lastPoseEnd - p0;
    } else if (poseLandmarker) {
      const prev = track[track.length - 1];
      people = prev?.people; // 직전 결과를 잠시 재사용
    }

    for (const p of people || []) if (p.ankleY != null) { recentAnkles.push(p.ankleY); if (recentAnkles.length > 60) recentAnkles.shift(); }
    const maxY = playBandMaxY({ people, recentAnkles });
    lastMaxY = maxY;
    const cam = camera.update(img.data, canvas.width, canvas.height);
    const diff = motion.update(img.data, canvas.width, canvas.height, cam);
    const candidates = detectBallCandidates(img.data, canvas.width, canvas.height, ballParams, staticMap, 80, cam, maxY, diff);
    const ball = tracker.update(candidates, t, track.length, cam, maxY);

    const frame = { t, x: null, y: null, r: null, found: false, people: people || undefined };
    track.push(frame);
    writer.frame(track.length - 1, frame, ball);
    if (ball) { recent.push({ x: ball.x, y: ball.y }); if (recent.length > 8) recent.shift(); }

    if (now - lastEval > 500) {
      lastEval = now;
      const res = detectEvents(track, eventParams);
      events = res.events; groundY = res.groundY; stats = res.stats;
    }
    onUpdate?.({ frame, recent, stats, events, groundY, poseMs, t, candidates });
  };

  return {
    start() { running = true; t0 = performance.now(); lastTick = 0; lastEval = 0; tick(); },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
      const res = detectEvents(track, eventParams);
      return { track, events: res.events, groundY: res.groundY, stats: res.stats };
    },
    get track() { return track; },
  };
}

// 미리보기 위에 공·손목·바닥선·점수를 그림
// 촬영 전 미리보기: 공 색 후보만 찾아서 보여줌 (추적·녹화 없음). stop() 으로 멈춤
export function startCandidatePreview({ video, canvas, ballParams = DEFAULT_BALL_PARAMS, fps = 8, onFrame }) {
  const work = document.createElement('canvas');
  const ctx = work.getContext('2d', { willReadFrequently: true });
  let running = true, rafId = 0, last = 0;
  const tick = () => {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const now = performance.now();
    if (now - last < 1000 / fps || !video.videoWidth) return;
    last = now;
    if (work.width !== LIVE_WIDTH) { work.width = LIVE_WIDTH; work.height = Math.max(1, Math.round(video.videoHeight * LIVE_WIDTH / video.videoWidth)); }
    ctx.drawImage(video, 0, 0, work.width, work.height);
    const img = ctx.getImageData(0, 0, work.width, work.height);
    const candidates = detectBallCandidates(img.data, work.width, work.height, ballParams, null);
    drawLiveOverlay(canvas, video, { candidates });
    onFrame?.(candidates);
  };
  tick();
  return { stop() { running = false; cancelAnimationFrame(rafId); } };
}

export function drawLiveOverlay(canvas, video, { frame, recent, groundY, stats, event, candidates } = {}) {
  if (!canvas || !video?.videoWidth) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, lw = Math.max(2, W / 320);
  ctx.clearRect(0, 0, W, H);
  if (groundY != null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.setLineDash([lw * 4, lw * 4]); ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(0, groundY * H); ctx.lineTo(W, groundY * H); ctx.stroke(); ctx.setLineDash([]);
  }
  if (recent?.length > 1) {
    ctx.strokeStyle = 'rgba(255,214,0,0.8)'; ctx.lineWidth = lw; ctx.beginPath();
    recent.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
    ctx.stroke();
  }
  for (const person of frame?.people || []) {
    for (const w of person.wrists || []) {
      ctx.fillStyle = 'rgba(0,200,255,0.9)'; ctx.beginPath(); ctx.arc(w.x * W, w.y * H, lw * 4, 0, Math.PI * 2); ctx.fill();
    }
  }
  // 공 색 후보(아직 공으로 확정되지 않은 것)는 작은 주황 원으로 — "지금 무엇을 공 색으로 보고 있나" 확인용
  for (const c of candidates || []) {
    ctx.strokeStyle = 'rgba(255,160,0,0.85)'; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(c.x * W, c.y * H, Math.max(lw * 2.5, (c.r || 0.005) * W * 1.6), 0, Math.PI * 2); ctx.stroke();
  }
  if (frame?.found) {
    ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = lw * 1.5;
    ctx.beginPath(); ctx.arc(frame.x * W, frame.y * H, Math.max(lw * 4, (frame.r || 0.01) * W * 1.8), 0, Math.PI * 2); ctx.stroke();
  }
  if (event) {
    ctx.fillStyle = event.type === 'catch' ? 'rgba(52,199,89,0.95)' : 'rgba(255,59,48,0.95)';
    ctx.font = `bold ${Math.round(W / 14)}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(event.type === 'catch' ? '성공!' : '실패', event.x * W, Math.max(W / 14, event.y * H - W / 30));
  }
  if (stats) {
    const pad = W / 40, fs = Math.round(W / 16);
    ctx.font = `bold ${fs}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const text = `성공 ${stats.success}   실패 ${stats.fail}`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(pad, pad, tw + pad * 2, fs + pad);
    ctx.fillStyle = '#fff'; ctx.fillText(text, pad * 2, pad + pad / 2);
    ctx.textBaseline = 'alphabetic';
  }
}
