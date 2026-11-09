// MediaPipe 포즈 인식 래퍼. 두 아이의 손목·발목 위치를 뽑아냅니다.
// wasm 실행 파일은 npm 패키지(exports 에 wasm 경로가 없어 node_modules 경로로 직접 가져옴)에서 같이 빌드되고, 모델 파일(약 5MB)만 구글 CDN에서 받습니다.
import { PoseLandmarker } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url';
import wasmBinaryPath from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// 랜드마크 번호 (MediaPipe Pose 33개 중)
const L_SHOULDER = 11, R_SHOULDER = 12, L_WRIST = 15, R_WRIST = 16, L_ANKLE = 27, R_ANKLE = 28;

let cached = null;

export async function loadPoseLandmarker({ numPoses = 2 } = {}) {
  if (cached) return cached;
  const fileset = { wasmLoaderPath, wasmBinaryPath };
  const make = (delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    cached = await make('GPU');
  } catch (e) {
    console.warn('GPU 포즈 인식 실패, CPU로 다시 시도합니다', e);
    cached = await make('CPU');
  }
  return cached;
}

// 인식 결과 → 사람 목록 [{ wrists: [{x,y}], shoulders, ankleY, height }]
export function extractPeople(result) {
  const people = [];
  for (const lm of result?.landmarks || []) {
    const pick = (i) => {
      const p = lm[i];
      if (!p || (p.visibility != null && p.visibility < 0.3)) return null;
      return { x: p.x, y: p.y };
    };
    const wrists = [pick(L_WRIST), pick(R_WRIST)].filter(Boolean);
    const ankles = [pick(L_ANKLE), pick(R_ANKLE)].filter(Boolean);
    const shoulders = [pick(L_SHOULDER), pick(R_SHOULDER)].filter(Boolean);
    const ankleY = ankles.length ? Math.max(...ankles.map((a) => a.y)) : null;
    const shoulderY = shoulders.length ? shoulders.reduce((s, a) => s + a.y, 0) / shoulders.length : null;
    const cx = shoulders.length ? shoulders.reduce((s, a) => s + a.x, 0) / shoulders.length : wrists[0]?.x ?? null;
    people.push({
      wrists,
      shoulders,
      ankleY,
      cx,
      height: ankleY != null && shoulderY != null ? ankleY - shoulderY : null,
    });
  }
  return people;
}
