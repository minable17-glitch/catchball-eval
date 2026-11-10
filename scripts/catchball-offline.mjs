// 캐치볼 영상을 브라우저 없이 검사하는 개발용 도구 (ffmpeg 필요, 포즈/손 인식은 제외).
// 실제 촬영 영상으로 공 색 기준값·판정 기준을 맞춰 볼 때 씁니다.
//
//   node scripts/catchball-offline.mjs 영상파일.mp4 [초당프레임=15] [분석너비=960]
//   DUMP=8-12 node scripts/catchball-offline.mjs 영상파일.mp4   ← 8~12초 구간의 공 위치를 프레임마다 출력
import { execFileSync } from 'node:child_process';
import { createCameraMotion, createMotionMap, createStaticMap, createTrackletTracker, createTrackWriter, detectBallCandidates, detectEvents, playBandMaxY, DEFAULT_BALL_PARAMS } from '../src/analysis.js';

const [video, fpsArg = '15', widthArg = '960'] = process.argv.slice(2);
const fps = Number(fpsArg), W = Number(widthArg);
const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]).toString().trim().split(',').map(Number);
const H = Math.round(probe[1] * W / probe[0]);
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${fps},scale=${W}:${H}`, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: 4 * 1024 * 1024 * 1024 });
const frameBytes = W * H * 4;
const n = Math.floor(raw.length / frameBytes);
const staticMap = createStaticMap({ staticFrames: Math.round(fps * 1.5) });
const camera = createCameraMotion();
const motion = createMotionMap();
const params = { ...DEFAULT_BALL_PARAMS, ...(process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {}) };
// PLAYERS="x,footY;x,footY" : 채점자가 찍는 두 아이 발 위치 (바닥선·공 구역·잡음 제거에 쓰임)
const players = process.env.PLAYERS ? process.env.PLAYERS.split(';').map((p) => { const [x, footY] = p.split(',').map(Number); return { x, footY }; }) : null;
const maxY = playBandMaxY({ players });
const track = [];
const writer = createTrackWriter(track, () => maxY);
const tracker = createTrackletTracker({
  onReject: (st) => { if (process.env.REJECT_LOG) console.log(`check t=${st.t0.toFixed(2)}..${st.t1.toFixed(2)} travel=${st.travel.toFixed(3)} ratio=${st.ratio.toFixed(2)} uniform=${st.uniform} step=${st.maxStep.toFixed(3)}/${st.medStep.toFixed(3)} speed=${st.speed.toFixed(4)} grav=${st.grav.toFixed(4)} n=${st.n}`); },
  onConfirm: (points, st) => {
    if (process.env.CONFIRM_LOG && st) console.log(`CONFIRM t=${st.t0.toFixed(2)}..${st.t1.toFixed(2)} travel=${st.travel.toFixed(3)} speed=${st.speed.toFixed(4)}/f ratio=${st.pathRatio.toFixed(2)} step=${st.maxStep.toFixed(3)} grav=${(st.grav ?? 0).toFixed(4)} n=${st.n} x=${points[0].x.toFixed(2)},y=${points[0].y.toFixed(2)}`); for (const pt of points) { const f = track[pt.frame]; if (f && !f.found) { f.x = pt.x; f.y = pt.y; f.r = pt.r; f.area = pt.area; f.found = true; } } },
});
for (let i = 0; i < n; i++) {
  const t = i / fps;
  const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset + i * frameBytes, frameBytes);
  const cam = camera.update(data, W, H);
  const diff = motion.update(data, W, H, cam);
  const candidates = detectBallCandidates(data, W, H, params, staticMap, 80, cam, maxY, diff);
  const ball = tracker.update(candidates, t, i, cam, maxY);
  const frame = { t, x: null, y: null, r: null, area: null, found: false };
  track.push(frame);
  writer.frame(i, frame, ball);
}
const { events, stats, groundY } = detectEvents(track, { players });
if (process.env.TRACK_OUT) (await import('node:fs')).writeFileSync(process.env.TRACK_OUT, JSON.stringify({ track, events, groundY }));
console.log(`frames=${n} found=${track.filter(f => f.found).length} groundY=${groundY.toFixed(3)}`);
console.log('stats', stats);
for (const e of events) console.log(`${e.t.toFixed(2)}s ${e.type} ${(e.confidence*100)|0}% ${e.reason}`);
if (process.env.DUMP) {
  const [a, b] = process.env.DUMP.split('-').map(Number);
  for (const f of track) if (f.t >= a && f.t <= b) console.log(f.t.toFixed(2), f.found ? `${f.x.toFixed(3)},${f.y.toFixed(3)} area=${f.area}` : '--');
}
