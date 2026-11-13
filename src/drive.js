// 구글 드라이브 저장. 파라런과 같은 방식: 선생님이 한 번 "구글 드라이브 연결"로 허락해 두면,
// 엣지 함수(supabase/functions/catchball-drive)가 그 열쇠로 업로드 주소를 열어 주고 학생 폰이 선생님 드라이브로 바로 올림.
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase.js';

const FN_URL = `${supabaseUrl}/functions/v1/catchball-drive`;
const RELAY_CHUNK = 4 * 1024 * 1024; // 예비 경로 조각 크기 (256KB 배수)

async function authHeaders() {
  let { data } = await supabase.auth.getSession();
  if (!data.session) { await supabase.auth.signInAnonymously(); ({ data } = await supabase.auth.getSession()); }
  return { Authorization: `Bearer ${data.session?.access_token || ''}`, apikey: supabaseAnonKey };
}

async function readResult(res) {
  let data = null;
  try { data = await res.json(); } catch { /* 아래에서 처리 */ }
  if (!res.ok || !data?.ok) {
    if (res.status === 404) throw new Error('드라이브 연결 함수(catchball-drive)가 아직 배포되지 않았어요.');
    throw new Error(data?.error || `드라이브 연결 오류 (${res.status})`);
  }
  return data;
}

export async function callDrive(action, payload = {}, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    return await readResult(res);
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('드라이브 연결 응답이 너무 오래 걸립니다.');
    throw e;
  } finally { clearTimeout(timer); }
}

// ── 선생님: 연결 상태 / 연결 / 끊기 ──
export const driveStatus = () => callDrive('status');
export async function startDriveConnect() {
  const back = new URL(window.location.href);
  back.search = ''; back.hash = '';
  const r = await callDrive('auth_url', { returnTo: back.toString() });
  window.location.href = r.url;
}
export const disconnectDrive = () => callDrive('disconnect');

// ── 학생 업로드 ──

// 드라이브 이어 올리기 주소로 영상 전체를 한 번에 PUT (진행률 표시)
function putDirect(uploadUrl, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', blob.type || 'video/webm');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let file = null;
        try { file = JSON.parse(xhr.responseText); } catch { /* 무시 */ }
        if (file?.id) resolve(file); else reject(new Error('드라이브 응답을 읽지 못했습니다.'));
      } else reject(new Error('드라이브 업로드 실패 (' + xhr.status + ')'));
    };
    xhr.onerror = () => reject(new Error('드라이브에 바로 올리지 못했습니다.'));
    xhr.ontimeout = () => reject(new Error('드라이브 업로드 시간 초과'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(blob);
  });
}

// 예비 경로: 엣지 함수를 거쳐 조각으로 보냄
async function putRelay(uploadUrl, blob, onProgress) {
  const headers = await authHeaders();
  const total = blob.size;
  for (let start = 0; start < total; start += RELAY_CHUNK) {
    const end = Math.min(total, start + RELAY_CHUNK);
    const res = await fetch(`${FN_URL}?action=relay&session=${encodeURIComponent(uploadUrl)}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
      body: blob.slice(start, end),
    });
    const r = await readResult(res);
    onProgress?.(end / total);
    if (r.done) return r.file;
  }
  throw new Error('드라이브 업로드가 끝나지 않았습니다.');
}

/** 학생 영상을 선생님 드라이브에 올림 → { fileId, fileName, link, size, route } */
export async function uploadToDrive({ info, blob, fileName, onStatus, onProgress }) {
  const meta = { round: info.round || '', className: info.className, student1: info.student1, student2: info.student2, date: info.date, fileName, mimeType: blob.type || 'video/webm', size: blob.size };
  onStatus?.('드라이브에 올릴 준비 중...');
  let start = await callDrive('start_upload', { ...meta, origin: window.location.origin });
  let file, route = 'direct';
  try {
    onStatus?.('선생님 드라이브로 올리는 중...');
    file = await putDirect(start.uploadUrl, blob, onProgress);
  } catch (e) {
    console.warn('드라이브 직접 업로드 실패, 함수를 거쳐 다시 시도', e);
    route = 'relay';
    onStatus?.('다른 길로 올리는 중... (조금 더 걸립니다)');
    onProgress?.(0);
    start = await callDrive('start_upload', meta);
    file = await putRelay(start.uploadUrl, blob, onProgress);
  }
  onStatus?.('올라간 파일 확인 중...');
  const done = await callDrive('finish_upload', { fileId: file.id });
  return { fileId: done.fileId, fileName: done.fileName || start.fileName, link: done.link, size: done.size, route };
}

// ── 선생님: 영상 가져오기 / 지우기 (선생님 드라이브 열쇠를 잠깐 받아 바로 내려받음) ──
let tokenCache = null;
async function teacherToken() {
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache;
  const r = await callDrive('token');
  tokenCache = { token: r.accessToken, apiBase: r.apiBase || 'https://www.googleapis.com', exp: Date.now() + 40 * 60 * 1000 };
  return tokenCache;
}

export async function fetchDriveVideo(fileId, onProgress) {
  const { token, apiBase } = await teacherToken();
  const res = await fetch(`${apiBase}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 401) tokenCache = null;
    if (res.status === 404) throw new Error('드라이브에서 영상을 찾지 못했습니다. (지워졌거나 휴지통에 있음)');
    throw new Error(`드라이브에서 영상을 가져오지 못했습니다 (${res.status}).`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress?.(got / total);
  }
  return new Blob(parts, { type: res.headers.get('content-type') || 'video/webm' });
}

export async function trashDriveFile(fileId) {
  const { token, apiBase } = await teacherToken();
  const res = await fetch(`${apiBase}/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok && res.status !== 404) throw new Error(`드라이브 영상 삭제 실패 (${res.status})`);
}
