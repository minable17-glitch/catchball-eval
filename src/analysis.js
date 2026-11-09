// 캐치볼 영상 분석의 핵심 계산 부분.
// 브라우저 API를 전혀 쓰지 않는 순수 함수들이라 node 에서도 그대로 시험해 볼 수 있습니다.
//
// 좌표는 모두 화면 기준 0~1 사이 값(normalized)을 씁니다.
//   x: 0 = 왼쪽 끝, 1 = 오른쪽 끝 / y: 0 = 위, 1 = 아래

// ── 노란 공 색 기준값 ───────────────────────────────────────
// hue 는 0~360 (노란색은 대략 45~65), sat/val 은 0~1
// 실제 촬영 영상(2026-11, 운동장)의 공은 주황~살구색(색상 18~45, 채도 0.35~0.5)이었음. 햇빛 아래 '노란 공'은
// 카메라에 주황 쪽으로 찍히므로 기본 범위를 주황~노랑으로 넓게 잡고, 살색·흙·단풍과는 움직임·고정물 제외로 구분함.
export const DEFAULT_BALL_PARAMS = {
  hueMin: 15,
  hueMax: 65,
  satMin: 0.3,
  valMin: 0.4,
  minArea: 4, // 픽셀 수 (분석용 축소 화면 너비 960 기준). 멀리 있는 공은 지름 3~5픽셀
  maxAreaFrac: 0.004, // 화면 전체 픽셀 대비 최대 비율 (얼굴·옷 등 큰 덩어리 제외)
  motionMin: 10, // 직전 프레임과의 밝기 차이(0~255 평균)가 이보다 작으면 '안 움직이는 것'으로 보고 제외 (추적 중인 공 근처는 예외)
};

// ── 캐치 판정 기준값 ────────────────────────────────────────
export const DEFAULT_EVENT_PARAMS = {
  minTravel: 0.12, // 한 번 던진 공이 최소 이만큼(화면 너비 비율)은 가로로 이동해야 '던지기'로 인정
  groundY: 0.88, // 공의 y 가 이보다 아래(크면)면 바닥으로 봄 (사람 발목이 보이면 그 값으로 대체)
  catchRadius: 0.1, // 손목과 공 사이 거리가 이 안이면 '손으로 잡음'으로 신뢰도 높임
  minEventGap: 0.35, // 초. 이보다 가까운 연속 이벤트는 하나로 합침
  maxGapFrames: 6, // 공이 이 프레임 수 이하로 사라지면 그냥 이어진 것으로 보고 보간
  restFrames: 5, // 영상 끝에서 공이 이만큼 거의 안 움직이면 '잡고 있음'으로 봄
};

// RGB(0~255) → HSV (h: 0~360, s: 0~1, v: 0~1)
export function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

// 한 픽셀이 '공 색'인지
export function isBallColor(r, g, b, p = DEFAULT_BALL_PARAMS) {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (s < p.satMin || v < p.valMin) return false;
  if (p.hueMin <= p.hueMax) return h >= p.hueMin && h <= p.hueMax;
  // 빨간색처럼 0도를 걸치는 범위도 지원
  return h >= p.hueMin || h <= p.hueMax;
}

// ImageData(data: RGBA 배열) → 공 색 마스크(Uint8Array, 1/0)
export function makeColorMask(data, width, height, p = DEFAULT_BALL_PARAMS) {
  const mask = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    if (isBallColor(data[j], data[j + 1], data[j + 2], p)) mask[i] = 1;
  }
  return mask;
}

// 마스크에서 붙어 있는 덩어리(blob)들을 찾음. 4방향 연결. weights 가 있으면 덩어리별 평균값(motion)도 계산
export function findBlobs(mask, width, height, { minArea = 1, weights = null } = {}) {
  const labels = new Int32Array(width * height); // 0 = 미방문
  const blobs = [];
  const stack = [];
  let nextLabel = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = nextLabel++;
    let area = 0, sx = 0, sy = 0, core = 0, wsum = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width, y = (idx - x) / width;
      area++; sx += x; sy += y;
      if (weights) wsum += weights[idx];
      // 상하좌우가 모두 공 색인 '속 픽셀'. 물체 가장자리에서 색이 섞여 생기는 얇은 테두리는 속 픽셀이 없음
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1 && mask[idx - 1] && mask[idx + 1] && mask[idx - width] && mask[idx + width]) core++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = label; stack.push(idx - 1); }
      if (x < width - 1 && mask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = label; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width] && !labels[idx - width]) { labels[idx - width] = label; stack.push(idx - width); }
      if (y < height - 1 && mask[idx + width] && !labels[idx + width]) { labels[idx + width] = label; stack.push(idx + width); }
    }
    if (area >= minArea) {
      const w = maxX - minX + 1, h = maxY - minY + 1;
      blobs.push({
        area,
        core,
        motion: weights ? wsum / area : null,
        cx: sx / area,
        cy: sy / area,
        w, h,
        aspect: w / h,
        fill: area / (w * h), // 네모 안을 얼마나 채우는지 (동그라미면 약 0.78)
      });
    }
  }
  return blobs;
}

// 덩어리 하나가 '공처럼 생겼는지' 점수 (0~1). 동그랗고 꽉 찬 모양일수록 높음
export function ballShapeScore(blob) {
  const aspectScore = 1 - Math.min(1, Math.abs(Math.log(blob.aspect)) / Math.log(2.5)); // 가로세로비 2.5배 넘으면 0
  const fillScore = Math.min(1, blob.fill / 0.6);
  return aspectScore * 0.5 + fillScore * 0.5;
}

// 한 프레임의 RGBA 픽셀에서 공 위치를 찾음.
//   prev: 직전 프레임에서 예상되는 공 위치 {x, y} (0~1) — 있으면 가까운 덩어리를 우선
// 반환: { x, y, r, area, score } (0~1 좌표) 또는 null
// motionMap: createMotionMap() 결과. 있으면 직전 프레임과의 차이로 '움직이는 것'만 공 후보로 봄
export function detectBall(data, width, height, params = DEFAULT_BALL_PARAMS, prev = null, staticMap = null, motionMap = null) {
  const p = { ...DEFAULT_BALL_PARAMS, ...params };
  const mask = makeColorMask(data, width, height, p);
  const weights = motionMap ? motionMap.update(data, width, height) : null;
  const blobs = findBlobs(mask, width, height, { minArea: p.minArea, weights });
  staticMap?.update(mask, width, height);
  return pickBall(blobs, width, height, p, prev, staticMap ? (x, y) => staticMap.isStatic(x, y) : null);
}

// 카메라(화면 전체) 움직임 추정: 1/8 크기 흑백 축소판을 직전 프레임과 ±5칸씩 밀어 보며 가장 잘 겹치는 이동량을 찾음.
// 손으로 찍어 흔들리거나 공을 따라 카메라를 돌려도, 고정물이 화면에서 밀린 양을 알 수 있음. 결과는 0~1 좌표 단위.
export function createCameraMotion({ scale = 8, search = 5 } = {}) {
  let prev = null, pw = 0, ph = 0;
  return {
    update(data, width, height) {
      const w = Math.floor(width / scale), h = Math.floor(height / scale);
      const cur = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // 블록 평균 밝기
          let sum = 0;
          for (let yy = 0; yy < scale; yy++) {
            let j = ((y * scale + yy) * width + x * scale) * 4;
            for (let xx = 0; xx < scale; xx++, j += 4) sum += data[j] * 0.3 + data[j + 1] * 0.6 + data[j + 2] * 0.1;
          }
          cur[y * w + x] = sum / (scale * scale);
        }
      }
      let best = { dx: 0, dy: 0 };
      if (prev && pw === w && ph === h) {
        const sadAt = (dx, dy, step) => {
          const m = Math.abs(dx) + Math.abs(dy) + 1;
          let sad = 0, n = 0;
          for (let y = m; y < h - m; y += step) {
            for (let x = m; x < w - m; x += step) { sad += Math.abs(cur[y * w + x] - prev[(y - dy) * w + (x - dx)]); n++; }
          }
          return sad / Math.max(1, n);
        };
        // 거친 탐색(4칸 간격으로 샘플, ±2·search) → 그 주변 세밀 탐색(±2). 빠르게 돌리는 카메라도 따라감
        let bestSad = Infinity;
        for (let dy = -2 * search; dy <= 2 * search; dy += 2) {
          for (let dx = -2 * search; dx <= 2 * search; dx += 2) {
            const sad = sadAt(dx, dy, 4);
            if (sad < bestSad) { bestSad = sad; best = { dx, dy }; }
          }
        }
        const c = best; bestSad = Infinity;
        for (let dy = c.dy - 2; dy <= c.dy + 2; dy++) {
          for (let dx = c.dx - 2; dx <= c.dx + 2; dx++) {
            const sad = sadAt(dx, dy, 2);
            if (sad < bestSad) { bestSad = sad; best = { dx, dy }; }
          }
        }
      }
      prev = cur; pw = w; ph = h;
      return { dx: best.dx * scale / width, dy: best.dy * scale / height };
    },
    reset() { prev = null; },
  };
}

// 직전 프레임과의 밝기 차이(픽셀마다 0~255). 첫 프레임은 차이를 모르므로 모두 255(움직임 있음)로 둠
export function createMotionMap() {
  let prevGray = null;
  let diff = null;
  return {
    update(data, width, height) {
      const n = width * height;
      if (!prevGray || prevGray.length !== n) { prevGray = new Uint8Array(n); diff = new Uint8Array(n); diff.fill(255); for (let i = 0, j = 0; i < n; i++, j += 4) prevGray[i] = (data[j] * 3 + data[j + 1] * 6 + data[j + 2]) / 10; return diff; }
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const g = (data[j] * 3 + data[j + 1] * 6 + data[j + 2]) / 10;
        const d = g - prevGray[i];
        diff[i] = d < 0 ? -d : d;
        prevGray[i] = g;
      }
      return diff;
    },
    reset() { prevGray = null; },
  };
}

// 화면을 작은 칸으로 나눠, 각 칸에 공 색이 연속으로 몇 프레임 있었는지 기억.
// 오랫동안(기본 3초) 계속 있던 칸은 고정 물체(노란 콘, 표지판, 옷)로 봄.
export function createStaticMap({ cols = 24, rows = 14, staticFrames = 45 } = {}) {
  const persist = new Uint16Array(cols * rows);
  const seen = new Uint8Array(cols * rows);
  return {
    update(mask, width, height) {
      seen.fill(0);
      const cw = width / cols, ch = height / rows;
      for (let y = 0; y < height; y++) {
        const row = y * width, cy = Math.min(rows - 1, Math.floor(y / ch));
        for (let x = 0; x < width; x++) {
          if (mask[row + x]) seen[cy * cols + Math.min(cols - 1, Math.floor(x / cw))] = 1;
        }
      }
      for (let i = 0; i < persist.length; i++) persist[i] = seen[i] ? Math.min(65000, persist[i] + 1) : Math.max(0, persist[i] - 1);
    },
    isStatic(nx, ny) {
      const cx = Math.min(cols - 1, Math.floor(nx * cols)), cy = Math.min(rows - 1, Math.floor(ny * rows));
      return persist[cy * cols + cx] > staticFrames;
    },
  };
}

// isStatic(nx, ny): 그 자리에 오랫동안 계속 공 색이 있었는지 (노란 표지판·콘 같은 고정 물체 제외용)
export function pickBall(blobs, width, height, p = DEFAULT_BALL_PARAMS, prev = null, isStatic = null) {
  const maxArea = width * height * p.maxAreaFrac;
  let best = null, bestScore = -Infinity;
  for (const b of blobs) {
    if (b.area < p.minArea || b.area > maxArea) continue;
    if (b.core != null && b.core === 0) continue; // 속이 없는 얇은 테두리
    const shape = ballShapeScore(b);
    if (shape < 0.35) continue;
    const nx = b.cx / width, ny = b.cy / height;
    if (isStatic && isStatic(nx, ny)) continue; // 한참 동안 그 자리에 있던 노란 것(콘·표지판·옷)은 공이 아님
    // 움직임이 거의 없는 덩어리는 공이 아님 (단, 추적 중인 공 바로 근처는 '들고 있는 공'일 수 있어 허용)
    if (b.motion != null && p.motionMin > 0 && b.motion < p.motionMin) {
      if (!prev || Math.hypot(nx - prev.x, ny - prev.y) > 0.03) continue;
    }
    // 모양 점수 + 크기(너무 작은 점보다는 조금 큰 쪽 선호) + 움직임 + 직전 위치와의 거리
    let score = shape + Math.min(1, b.area / 40) * 0.3 + (b.motion != null ? Math.min(1, b.motion / 40) * 0.6 : 0);
    if (prev) {
      const d = Math.hypot(nx - prev.x, ny - prev.y);
      if (d > 0.3) continue; // 한 프레임 사이에 화면의 30% 넘게 순간이동하는 공은 없음
      score += Math.max(0, 1 - d / 0.25) * 1.2; // 직전 위치에서 화면의 1/4 이내면 가산점
      if (prev.area) {
        // 직전에 본 공과 크기가 너무 다르면 다른 물체. 4배 이상은 아예 제외, 2.5배부터 감점
        const ratio = Math.max(b.area / prev.area, prev.area / b.area);
        if (ratio > 4) continue;
        if (ratio > 2.5) score -= (ratio - 2.5) * 0.6;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = { x: nx, y: ny, r: Math.sqrt(b.area / Math.PI) / width, area: b.area, score };
    }
  }
  return best;
}

// 한 프레임의 공 후보 전부 (색·크기·모양 기준 통과, 고정물 제외). 0~1 좌표. 모양 점수 높은 순.
export function detectBallCandidates(data, width, height, params = DEFAULT_BALL_PARAMS, staticMap = null, maxCount = 40) {
  const p = { ...DEFAULT_BALL_PARAMS, ...params };
  const mask = makeColorMask(data, width, height, p);
  const blobs = findBlobs(mask, width, height, { minArea: p.minArea });
  staticMap?.update(mask, width, height);
  const maxArea = width * height * p.maxAreaFrac;
  const out = [];
  for (const b of blobs) {
    if (b.area < p.minArea || b.area > maxArea) continue;
    if (b.core === 0 && b.area >= 8) continue; // 속 픽셀 없는 얇은 테두리 제외 (아주 작은 점은 원래 속이 없으니 면제)
    const shape = ballShapeScore(b);
    if (shape < 0.35) continue;
    const nx = b.cx / width, ny = b.cy / height;
    if (staticMap && staticMap.isStatic(nx, ny)) continue;
    out.push({ x: nx, y: ny, r: Math.sqrt(b.area / Math.PI) / width, area: b.area, shape });
  }
  out.sort((a, b) => b.shape - a.shape);
  return out.slice(0, maxCount);
}

/**
 * 궤적(tracklet) 추적기. 프레임마다 여러 후보를 받아 서로 이어 붙이고, 화면을 어느 정도 가로질러
 * '날아간' 궤적만 공으로 인정합니다. 얼굴·손처럼 제자리에서 흔들리는 살색 덩어리는 이어 붙여도
 * 멀리 가지 않으므로 끝내 인정되지 않습니다. 손으로 찍어 흔들리는 영상에서도 동작합니다.
 *
 *   update(candidates, t, frame) → 이 프레임에서 인정된 공 위치({x,y,r,area}) 또는 null
 *   궤적이 뒤늦게 인정되면 onConfirm(points) 로 앞 프레임들을 채워 넣을 수 있게 알려줌 (points: [{frame, x, y, r, area}])
 */
// 값들을 등간격으로 보고 2차식 y = a·k² + b·k + c 로 최소제곱 맞춤 → a (가속도, 프레임²당)
export function quadraticAccel(ys) {
  const n = ys.length;
  if (n < 6) return 0;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let k = 0; k < n; k++) {
    const y = ys[k], k2 = k * k;
    s1 += k; s2 += k2; s3 += k2 * k; s4 += k2 * k2; t0 += y; t1 += k * y; t2 += k2 * y;
  }
  // 정규방정식 3x3 풀이 (크래머)
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = [s4, s3, s2, s3, s2, s1, s2, s1, s0];
  const D = det(M);
  if (Math.abs(D) < 1e-12) return 0;
  const Ma = [t2, s3, s2, t1, s2, s1, t0, s1, s0];
  return det(Ma) / D;
}

export function createTrackletTracker({ linkRadius = 0.06, maxMissed = 5, minLen = 6, minTravel = 0.08, minSpeed = 0.015, minGravity = 0.0012, windowFrames = 24, stillFrames = 22, onConfirm = null } = {}) {
  let active = [];
  let nextId = 1;
  const confirmedIds = new Set();
  let gX = 0, gY = 0; // 카메라 움직임 누적 (화면이 통째로 밀린 양)
  return {
    // camera: createCameraMotion().update() 결과 {dx, dy} (이 프레임에서 화면이 밀린 양). 없으면 궤적들의 중앙값으로 추정
    update(candidates, t, frame, camera = null) {
      const taken = new Set();
      const moves = []; // 이 프레임에서 이어 붙은 궤적들의 이동량 (카메라 움직임 추정용)
      // 1) 기존 궤적에 가장 가까운 후보를 붙임 (속도를 반영한 예상 위치 기준)
      for (const tr of active) {
        const dt = Math.max(1, frame - tr.lastFrame);
        const px = tr.x + tr.vx * dt, py = tr.y + tr.vy * dt;
        const radius = linkRadius + Math.hypot(tr.vx, tr.vy) * dt * 1.5;
        let best = null, bestD = Infinity;
        candidates.forEach((c, i) => {
          if (taken.has(i)) return;
          const d = Math.hypot(c.x - px, c.y - py);
          // 크기가 갑자기 4배 넘게 달라지면 다른 물체
          const ratio = tr.area ? Math.max(c.area / tr.area, tr.area / c.area) : 1;
          if (d < radius && d < bestD && ratio < 4) { best = i; bestD = d; }
        });
        if (best != null) {
          const c = candidates[best];
          taken.add(best);
          moves.push({ dx: (c.x - tr.x) / dt, dy: (c.y - tr.y) / dt });
          // 공이 느려졌는지 (카메라 움직임을 뺀 실제 이동량 기준). 잡힌 뒤 글러브·손을 계속 따라가지 않도록 셈
          const realStep = Math.hypot((c.x - tr.x) / dt - (camera ? camera.dx : 0), (c.y - tr.y) / dt - (camera ? camera.dy : 0));
          tr.slowFrames = realStep < minSpeed * 0.8 ? (tr.slowFrames || 0) + 1 : 0;
          tr.vx = 0.5 * tr.vx + 0.5 * ((c.x - tr.x) / dt);
          tr.vy = 0.5 * tr.vy + 0.5 * ((c.y - tr.y) / dt);
          tr.x = c.x; tr.y = c.y; tr.area = tr.area * 0.7 + c.area * 0.3;
          tr.lastFrame = frame; tr.missed = 0;
          tr.points.push({ frame, t, x: c.x, y: c.y, r: c.r, area: c.area });
          tr.minX = Math.min(tr.minX, c.x); tr.maxX = Math.max(tr.maxX, c.x);
        } else {
          tr.missed++;
        }
      }
      // 카메라 움직임 추정: 이어 붙은 것이 넉넉히(4개 이상) 있으면 그 이동량의 중앙값을 카메라가 밀린 양으로 봄.
      // (낙엽·울타리 같은 고정물은 모두 같은 방향으로 밀리고, 공 하나만 다르게 움직임)
      if (camera) {
        gX += camera.dx; gY += camera.dy;
      } else if (moves.length >= 4) {
        const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
        const mx = med(moves.map((m) => m.dx)), my = med(moves.map((m) => m.dy));
        gX += Math.max(-0.03, Math.min(0.03, mx)); gY += Math.max(-0.03, Math.min(0.03, my));
      }
      // 이 프레임에 붙은 점들에 '카메라 움직임을 뺀 좌표'를 기록
      for (const tr of active) {
        if (tr.lastFrame !== frame) continue;
        const pt = tr.points[tr.points.length - 1];
        pt.cx = pt.x - gX; pt.cy = pt.y - gY;
      }
      // 2) 아무 궤적에도 안 붙은 후보는 새 궤적 시작
      candidates.forEach((c, i) => {
        if (taken.has(i)) return;
        active.push({ id: nextId++, x: c.x, y: c.y, vx: 0, vy: 0, area: c.area, lastFrame: frame, missed: 0, minX: c.x, maxX: c.x, points: [{ frame, t, x: c.x, y: c.y, r: c.r, area: c.area, cx: c.x - gX, cy: c.y - gY }], confirmed: false });
      });
      // 3) 짧은 시간(windowFrames) 안에 충분히 날아간 궤적은 '공'으로 확정.
      //    (카메라가 천천히 움직여 고정물이 화면에서 밀리는 것은 느려서 걸리지 않음)
      for (const tr of active) {
        if (tr.confirmed || tr.points.length < minLen) continue;
        const recent = tr.points.slice(-windowFrames);
        let lo = Infinity, hi = -Infinity, pathX = 0, maxStep = 0;
        const steps = [];
        for (let k = 0; k < recent.length; k++) {
          const pt = recent[k]; // 카메라 움직임을 뺀 좌표로 판단
          if (pt.cx < lo) lo = pt.cx; if (pt.cx > hi) hi = pt.cx;
          if (k > 0) {
            const gap = Math.max(1, pt.frame - recent[k - 1].frame);
            const dx = Math.abs(pt.cx - recent[k - 1].cx) / gap; // 프레임당 이동
            pathX += dx * gap; steps.push(dx); if (dx > maxStep) maxStep = dx;
          }
        }
        const frames = Math.max(1, recent[recent.length - 1].frame - recent[0].frame);
        const sorted = steps.slice().sort((a, b) => a - b);
        const medStep = sorted[Math.floor(sorted.length / 2)] || 0;
        // 실제 던진 공: 한 방향으로 거의 완벽하게 매끄럽고(길이 합 ≤ 순이동의 1.1배), 프레임당 이동이 고름(최대가 중앙값의 2.5배 이내),
        // 그리고 '던진 공'답게 빠름(프레임당 평균 이동 ≥ minSpeed). 글러브·사람은 여러 덩어리를 번갈아 잇느라 들쭉날쭉함.
        // 첫 1초(15프레임)는 카메라 움직임·고정물 지도가 아직 준비되지 않아 확정하지 않음.
        const uniform = maxStep <= Math.max(0.03, medStep * 2.5) && maxStep <= 0.15;
        // 중력 검사: 던진 공은 세로 방향으로 아래로 가속(포물선)한다. 카메라에 밀린 나무·낙엽이나 걷는 사람은 가속이 없다.
        // 세로 좌표를 2차식으로 맞춰 2차 계수(프레임²당)가 양수(아래쪽)로 충분해야 함
        const grav = quadraticAccel(recent.map((pt) => pt.cy));
        if (recent[0].frame >= 15 && hi - lo >= minTravel && pathX <= (hi - lo) * 1.1 && uniform && (hi - lo) / frames >= minSpeed && grav >= minGravity) {
          tr.confirmed = true;
          confirmedIds.add(tr.id);
          tr.confirmStats = { travel: hi - lo, frames, speed: (hi - lo) / frames, pathRatio: pathX / (hi - lo), maxStep, grav, n: recent.length, t0: recent[0].t, t1: recent[recent.length - 1].t };
          onConfirm?.(tr.points, tr.confirmStats);
        }
      }
      // 4) 오래 끊긴 궤적 정리. 확정된 궤적도 1.5초 넘게 제자리면 끝냄
      //    (잡고 있는 공은 다음 던지기 때 새 궤적으로 다시 확정되고, 고정물이 카메라 흔들림으로 붙은 경우는 그대로 끝남)
      active = active.filter((tr) => {
        if (tr.missed > maxMissed) return false;
        // 확정된(날아간) 궤적이 0.5초 넘게 느리면 '잡힌 것'으로 보고 끝냄. 다음 던지기는 새 궤적으로 다시 확정됨
        if (tr.confirmed && (tr.slowFrames || 0) > 6) return false;
        if (tr.confirmed && tr.points.length > stillFrames) {
          const recent = tr.points.slice(-stillFrames);
          let lo = Infinity, hi = -Infinity, loY = Infinity, hiY = -Infinity;
          for (const pt of recent) { if (pt.cx < lo) lo = pt.cx; if (pt.cx > hi) hi = pt.cx; if (pt.cy < loY) loY = pt.cy; if (pt.cy > hiY) hiY = pt.cy; }
          if (hi - lo < 0.02 && hiY - loY < 0.02) return false;
        }
        return true;
      });
      // 5) 이 프레임에서 갱신된 확정 궤적 중 가장 긴 것의 위치를 돌려줌
      let out = null;
      for (const tr of active) {
        if (tr.confirmed && tr.lastFrame === frame && (!out || tr.points.length > out.len)) {
          const pt = tr.points[tr.points.length - 1];
          out = { x: pt.x, y: pt.y, r: pt.r, area: pt.area, len: tr.points.length };
        }
      }
      return out;
    },
    reset() { active = []; confirmedIds.clear(); },
  };
}

// 같은 영상에서 프레임마다 공을 이어서 따라가도록 도와주는 작은 추적기 (단일 후보용. 색 확인 미리보기 등에 사용)
export function createBallTracker({ parkAfterSec = 1.0 } = {}) {
  let last = null; // {x, y, t, area}
  let lastVel = { vx: 0, vy: 0 };
  let missed = 0;
  let stillSince = null; // 공이 거의 안 움직이기 시작한 시각
  let parked = false; // 1초 넘게 제자리면 '잡고 있거나 공이 아님'으로 보고 추적 우선권을 내려놓음
  return {
    // 다음 프레임에서 공이 있을 법한 위치 (직전 위치 + 속도). 제자리에 오래 있으면 null (가까운 것 우선 안 함)
    predict(t) {
      if (!last || parked) return null;
      const dt = Math.min(0.5, Math.max(0, t - last.t));
      return { x: last.x + lastVel.vx * dt, y: last.y + lastVel.vy * dt, area: last.area };
    },
    update(detection, t) {
      if (!detection) {
        missed++;
        if (missed > 15) { last = null; lastVel = { vx: 0, vy: 0 }; parked = false; stillSince = null; }
        return;
      }
      if (last && t > last.t) {
        const dt = t - last.t;
        const moved = Math.hypot(detection.x - last.x, detection.y - last.y);
        if (parked && moved > 0.03) { parked = false; stillSince = null; lastVel = { vx: 0, vy: 0 }; } // 새로 날아가기 시작
        else if (moved < 0.004) { if (stillSince == null) stillSince = last.t; if (t - stillSince >= parkAfterSec) parked = true; }
        else stillSince = null;
        // 속도는 조금 부드럽게 (갑자기 튀는 값 완화)
        lastVel = {
          vx: 0.5 * lastVel.vx + 0.5 * ((detection.x - last.x) / dt),
          vy: 0.5 * lastVel.vy + 0.5 * ((detection.y - last.y) / dt),
        };
      }
      // 크기는 천천히 따라가게 (가려지면서 작아 보이는 순간에 휘둘리지 않도록)
      const area = last?.area ? last.area * 0.7 + detection.area * 0.3 : detection.area;
      last = { x: detection.x, y: detection.y, t, area };
      missed = 0;
    },
    get parked() { return parked; },
    reset() { last = null; lastVel = { vx: 0, vy: 0 }; missed = 0; parked = false; stillSince = null; },
  };
}

// ── 궤적 → 캐치 이벤트 ─────────────────────────────────────

// 짧게 사라진 구간은 선형 보간으로 채움. 긴 구간은 그대로 둠(found=false)
export function interpolateGaps(track, maxGapFrames) {
  const out = track.map((f) => ({ ...f, interpolated: false }));
  let i = 0;
  while (i < out.length) {
    if (out[i].found) { i++; continue; }
    const start = i;
    while (i < out.length && !out[i].found) i++;
    const end = i; // [start, end) 가 빈 구간
    const before = out[start - 1], after = out[end];
    if (before && after && end - start <= maxGapFrames) {
      for (let k = start; k < end; k++) {
        const a = (k - start + 1) / (end - start + 1);
        out[k] = { ...out[k], x: before.x + (after.x - before.x) * a, y: before.y + (after.y - before.y) * a, found: true, interpolated: true };
      }
    }
  }
  return out;
}

// x 좌표를 3프레임 이동평균으로 부드럽게 (공이 보이는 프레임만)
function smoothX(track) {
  return track.map((f, i) => {
    if (!f.found) return f;
    const a = track[i - 1], b = track[i + 1];
    const vals = [f.x];
    if (a?.found) vals.push(a.x);
    if (b?.found) vals.push(b.x);
    return { ...f, sx: vals.reduce((s, v) => s + v, 0) / vals.length };
  });
}

// 손목 정보가 있으면 공과 가장 가까운 손목 거리, 없으면 null
function nearestWristDistance(frame) {
  if (!frame?.people?.length) return null;
  let best = null;
  for (const person of frame.people) {
    for (const w of person.wrists || []) {
      if (!w) continue;
      const d = Math.hypot(w.x - frame.x, w.y - frame.y);
      if (best == null || d < best) best = d;
    }
  }
  return best;
}

// 사람 발목이 보이면 그걸로 '바닥 높이'를 정함 (가장 낮은 발목보다 약간 위)
function estimateGroundY(track, fallback) {
  const ankles = [];
  for (const f of track) {
    for (const p of f.people || []) if (p.ankleY != null) ankles.push(p.ankleY);
  }
  if (ankles.length < 10) return fallback;
  ankles.sort((a, b) => a - b);
  const median = ankles[Math.floor(ankles.length / 2)];
  return Math.min(0.97, median - 0.03);
}

/**
 * 공 궤적에서 "방향이 바뀐 순간"들을 찾아 캐치/실패 이벤트로 만듭니다.
 *
 * track: [{ t, x, y, found, people?: [{ wrists: [{x,y}], ankleY }] }]
 * 반환: { events: [{ t, x, y, type: 'catch'|'drop', confidence, reason }], groundY, stats }
 */
export function detectEvents(rawTrack, params = {}) {
  const p = { ...DEFAULT_EVENT_PARAMS, ...params };
  const track = smoothX(interpolateGaps(rawTrack, p.maxGapFrames));
  const groundY = estimateGroundY(track, p.groundY);
  const visible = track.filter((f) => f.found);
  const events = [];
  if (visible.length < 3) return { events, groundY, stats: summarize(events) };

  // 지그재그(zigzag) 방식: 현재 진행 방향의 극값을 기억하다가, 반대로 minTravel 이상
  // 되돌아오면 그 극값 지점을 '방향 전환'으로 확정합니다. 작은 떨림은 무시됩니다.
  let dir = 0; // +1 오른쪽으로 이동 중, -1 왼쪽으로, 0 아직 모름
  let anchor = visible[0]; // 직전 확정 전환점(또는 시작점)
  let extreme = visible[0]; // 현재 방향의 극값 후보
  const turning = [];

  for (let i = 1; i < visible.length; i++) {
    const f = visible[i];
    if (dir === 0) {
      const dx = f.sx - anchor.sx;
      if (Math.abs(dx) >= p.minTravel) { dir = dx > 0 ? 1 : -1; extreme = f; }
      else if (Math.abs(dx) > Math.abs(extreme.sx - anchor.sx)) extreme = f;
      continue;
    }
    if ((f.sx - extreme.sx) * dir > 0) { extreme = f; continue; } // 같은 방향으로 더 나아감
    if ((extreme.sx - f.sx) * dir >= p.minTravel) {
      // 반대 방향으로 충분히 되돌아옴 → extreme 이 전환점.
      // 공을 들고 한참 있으면 극값이 그 사이 아무 때나 찍히므로, 극값 근처(최소 던지기 거리의 1/4 이내)에 처음 닿은 순간을 시각으로 씀
      const travelIn = Math.abs(extreme.sx - anchor.sx);
      let first = extreme;
      for (let k = visible.indexOf(anchor) + 1; k < visible.length; k++) {
        if (Math.abs(visible[k].sx - extreme.sx) <= p.minTravel * 0.25) { first = visible[k]; break; }
      }
      turning.push({ frame: first, anchor, travelIn, confirmed: true });
      anchor = extreme;
      extreme = f;
      dir = -dir;
    }
  }
  // 영상 끝: 마지막 극값까지 충분히 날아왔고, 그 뒤로 공이 거의 안 움직였다면 '마지막 캐치'
  if (dir !== 0) {
    const travelIn = Math.abs(extreme.sx - anchor.sx);
    const after = visible.filter((f) => f.t > extreme.t);
    const stillAfter = after.length >= p.restFrames && after.every((f) => Math.abs(f.sx - extreme.sx) < p.minTravel * 0.4);
    const endedSoon = after.length < p.restFrames;
    if (travelIn >= p.minTravel && (stillAfter || endedSoon)) {
      turning.push({ frame: extreme, anchor, travelIn, confirmed: stillAfter });
    }
  }

  // 전환점 하나하나를 캐치/실패로 분류.
  // 공이 손에 들어와 멈춰 있는 구간(전환점 앞뒤로 가로 이동이 거의 없는 프레임들) 전체를 보고,
  // 그 사이에 한 번이라도 바닥에 닿았으면 '실패'로 봅니다. (떨어뜨린 공을 주워서 던지면
  // 가로 방향의 극값이 손 위치에 생기기 때문에 전환점 한 프레임만 봐서는 놓칩니다.)
  turning.forEach((tp, k) => {
    const f = tp.frame;
    const next = turning[k + 1]?.frame || visible[visible.length - 1];
    const win = holdWindow(visible, tp.anchor, f, next);
    const groundFrame = win.find((w) => w.y >= groundY - 0.01); // 공 반지름만큼 여유
    const bounceFrame = win.find((w) => isBounce(track, w));
    const wristDist = wristDistanceNear(track, f, 3);
    let type, confidence, reason, at = f;
    if (groundFrame || bounceFrame) {
      type = 'drop';
      confidence = groundFrame && bounceFrame ? 0.95 : 0.75;
      reason = bounceFrame ? '공이 바닥에 튐' : '공이 바닥까지 떨어짐';
      at = groundFrame || bounceFrame; // 실패 시각은 바닥에 닿은 순간으로
    } else {
      type = 'catch';
      if (wristDist != null && wristDist <= p.catchRadius) { confidence = 0.95; reason = '손 가까이에서 공이 멈추고 되돌아감'; }
      else if (wristDist != null) { confidence = 0.6; reason = '공은 되돌아갔지만 손과 거리가 멂'; }
      else { confidence = 0.75; reason = '공이 되돌아감 (손 위치 정보 없음)'; }
      if (!tp.confirmed) { confidence = Math.min(confidence, 0.6); reason += ' · 영상 끝부분'; }
    }
    events.push({ t: round2(at.t), x: at.x, y: at.y, type, confidence, reason, auto: true });
  });

  // 너무 가까운 이벤트 합치기 (공이 바닥에서 여러 번 튀는 경우 등)
  const merged = [];
  for (const e of events.sort((a, b) => a.t - b.t)) {
    const last = merged[merged.length - 1];
    if (last && e.t - last.t < p.minEventGap) {
      if (e.type === 'drop' && last.type !== 'drop') merged[merged.length - 1] = e; // 실패가 우선
      continue;
    }
    merged.push(e);
  }
  return { events: merged, groundY, stats: summarize(merged) };
}

function round2(v) { return Math.round(v * 100) / 100; }

// 공이 '받는 사람 쪽에 머문 구간': 날아온 거리의 70%를 지난 때부터, 되돌아가는 거리의 30%를
// 가기 전까지의 프레임들. (앞 전환점 a → 이번 전환점 e → 다음 전환점 n)
function holdWindow(visible, a, e, n) {
  const ia = visible.indexOf(a), ie = visible.indexOf(e), inx = visible.indexOf(n);
  const out = [];
  const travelIn = Math.abs(e.sx - a.sx);
  for (let k = Math.max(0, ia); k <= ie; k++) {
    const f = visible[k];
    if (Math.abs(f.sx - a.sx) >= travelIn * 0.7) out.push(f);
  }
  const travelOut = Math.abs(n.sx - e.sx);
  for (let k = ie + 1; k <= inx; k++) {
    const f = visible[k];
    if (Math.abs(f.sx - e.sx) <= travelOut * 0.3) out.push(f);
    else break;
  }
  return out;
}

// 전환점 전후 ±k 프레임 중 손목과 가장 가까웠던 거리
function wristDistanceNear(track, frame, k) {
  const i = track.indexOf(frame);
  let best = null;
  for (let j = Math.max(0, i - k); j <= Math.min(track.length - 1, i + k); j++) {
    const f = track[j];
    if (!f.found) continue;
    const d = nearestWristDistance(f);
    if (d != null && (best == null || d < best)) best = d;
  }
  return best;
}

// 전환점 근처에서 공이 빠르게 내려오다가 갑자기 올라가면(튀어오름) 바닥에 떨어진 것
function isBounce(track, frame) {
  // 프레임 수가 아니라 시간(앞뒤 0.4초)으로 창을 잡음. 실시간 모드에서 프레임 간격이 들쭉날쭉해도 같은 기준이 되도록.
  const i = track.indexOf(frame);
  const before = [], after = [];
  for (let k = i - 1; k >= 0 && frame.t - track[k].t <= 0.4; k--) if (track[k].found) before.unshift(track[k]);
  for (let k = i + 1; k < track.length && track[k].t - frame.t <= 0.4; k++) if (track[k].found) after.push(track[k]);
  if (before.length < 1 || after.length < 1) return false;
  const vyBefore = (frame.y - before[0].y) / Math.max(1e-3, frame.t - before[0].t);
  // 튀어오른 뒤 가장 높이 간 지점(y 최소)까지의 속도
  const top = after.reduce((m, f) => (f.y < m.y ? f : m), after[0]);
  const vyAfter = (top.y - frame.y) / Math.max(1e-3, top.t - frame.t);
  // 1초에 화면 높이의 60% 이상 속도로 내려오다가 비슷한 세기로 튀어오름
  return vyBefore > 0.6 && vyAfter < -0.4 && frame.y > 0.6;
}

export function summarize(events) {
  let success = 0, fail = 0, streak = 0, bestStreak = 0;
  for (const e of events) {
    if (e.type === 'catch') { success++; streak++; if (streak > bestStreak) bestStreak = streak; }
    else { fail++; streak = 0; }
  }
  return { success, fail, bestStreak, total: success + fail };
}
