// 영상을 브라우저 안에서 작게 다시 녹화 (640px 폭). 1분 영상이 100MB → 5~10MB 정도로 줄어듦.
// 영상을 실제로 한 번 재생하면서 녹화하므로 영상 길이만큼 시간이 걸립니다.

export const COMPRESS_WIDTH = 640;

export function canCompress() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function waitEvent(el, name, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(name + ' 대기 시간 초과')), timeoutMs);
    el.addEventListener(name, () => { clearTimeout(t); resolve(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); reject(new Error('영상을 재생할 수 없습니다.')); }, { once: true });
  });
}

/**
 * @param file  원본 영상 File/Blob
 * @param opts  { width, fps, bitsPerSecond, onProgress(0~1), signal }
 * @returns { blob, mimeType, duration, width, height }
 */
export async function compressVideo(file, { width = COMPRESS_WIDTH, fps = 30, bitsPerSecond = 1_200_000, onProgress, signal } = {}) {
  if (!canCompress()) throw new Error('이 브라우저는 영상 압축을 지원하지 않습니다.');
  const mimeType = pickMimeType();
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await waitEvent(video, 'loadedmetadata');
    if (!video.videoWidth) throw new Error('영상 크기를 읽을 수 없습니다.');
    if (!Number.isFinite(video.duration)) {
      // 길이 정보가 없는 영상(브라우저 녹화 webm 등): 끝으로 한 번 건너뛰면 길이를 알아냄
      await new Promise((resolve) => {
        const done = () => { video.removeEventListener('durationchange', done); resolve(); };
        video.addEventListener('durationchange', done);
        video.currentTime = 1e9;
        setTimeout(done, 3000);
      });
      video.currentTime = 0;
      await waitEvent(video, 'seeked', 5000).catch(() => {});
    }
    const scale = Math.min(1, width / video.videoWidth);
    const w = Math.round(video.videoWidth * scale / 2) * 2;
    const h = Math.round(video.videoHeight * scale / 2) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitsPerSecond } : { videoBitsPerSecond: bitsPerSecond });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });

    let stop = false;
    const abort = () => { stop = true; video.pause(); };
    signal?.addEventListener('abort', abort);

    const duration = Number.isFinite(video.duration) ? video.duration : null;
    // 프레임이 바뀔 때마다 캔버스에 그림
    const draw = () => { ctx.drawImage(video, 0, 0, w, h); if (duration) onProgress?.(Math.min(1, video.currentTime / duration)); };
    let rafId = 0;
    const loop = () => {
      if (stop || video.ended) return;
      draw();
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(loop);
      else rafId = requestAnimationFrame(loop);
    };

    rec.start(500);
    draw();
    loop();
    await video.play();
    await new Promise((resolve) => {
      video.addEventListener('ended', resolve, { once: true });
      const check = setInterval(() => { if (stop) { clearInterval(check); resolve(); } }, 200);
      video.addEventListener('ended', () => clearInterval(check), { once: true });
    });
    cancelAnimationFrame(rafId);
    draw();
    rec.stop();
    await stopped;
    signal?.removeEventListener('abort', abort);
    if (stop) throw new DOMException('압축이 취소되었습니다.', 'AbortError');
    const type = rec.mimeType || mimeType || 'video/webm';
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    if (!blob.size) throw new Error('압축 결과가 비어 있습니다.');
    return { blob, mimeType: blob.type, duration: video.duration, width: w, height: h };
  } finally {
    video.pause();
    video.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

export function extForMime(mime) {
  if (/mp4/.test(mime)) return 'mp4';
  if (/webm/.test(mime)) return 'webm';
  return 'webm';
}
