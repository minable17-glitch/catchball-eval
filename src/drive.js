// 구글 드라이브 저장. 파라런과 같은 방식: 선생님이 한 번 "구글 드라이브 연결"로 허락해 두면,
// 엣지 함수(supabase/functions/catchball-drive)가 그 열쇠로 업로드 주소를 열어 주고 학생 폰이 선생님 드라이브로 바로 올림.
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase.js';
import { waitUsable } from './keepAwake.js';

const STALL_MS = 40000; // 이만큼 아무것도 안 올라가면 멈춘 것으로 보고 끊고 다시 시도
// 전송이 조용히 멈추는 경우(이동통신에서 흔함)를 잡는 감시: 진행이 없으면 abort → onerror 대신 여기서 실패 처리
function watchStall(xhr, reject) {
  let last = Date.now();
  const tick = () => { last = Date.now(); };
  xhr.upload.addEventListener('progress', tick);
  xhr.addEventListener('readystatechange', tick);
  const id = setInterval(() => {
    if (document.visibilityState !== 'visible') { last = Date.now(); return; } // 화면이 꺼진 동안은 세지 않음
    if (Date.now() - last > STALL_MS) { clearInterval(id); try { xhr.abort(); } catch { /* 무시 */ } reject(Object.assign(new Error('전송이 멈췄습니다.'), { network: true, detail: '멈춤' })); }
  }, 5000);
  xhr.addEventListener('loadend', () => clearInterval(id));
}

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
    if (e instanceof TypeError) throw Object.assign(new Error('드라이브 연결 서버에 닿지 못했어요. 인터넷 연결을 확인해 주세요.'), { network: true });
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

// 폰이 고른 영상 파일을 브라우저에 실제로 넘겨주는지 확인 (갤러리의 클라우드 전용·변환 중 영상은 읽기가 실패함).
// 읽기 실패는 인터넷 문제와 증상이 같아서(다시 시도해도 계속 실패) 따로 잡아냄.
export const FILE_READ_HELP = '폰이 이 영상 파일을 넘겨주지 못하고 있어요. ① 아래 "파일 앱에서 고르기"로 다시 골라 보세요. ② 그래도 안 되면 "바로 촬영해서 제출"로 찍어 주세요.';
async function readPart(blob, start, end) {
  try {
    return await blob.slice(start, end).arrayBuffer();
  } catch (e) {
    throw Object.assign(new Error(FILE_READ_HELP), { fileRead: true, detail: `읽기 실패 ${e?.name || ''} @${Math.round(start / 1048576)}MB` });
  }
}
/** 고른 파일의 앞·가운데·끝을 조금씩 읽어 봄. 실패하면 fileRead 오류 */
export async function probeFile(file) {
  const n = 256 * 1024, size = file.size;
  if (!size) throw Object.assign(new Error(FILE_READ_HELP), { fileRead: true, detail: '크기 0' });
  const spots = [0, Math.max(0, Math.floor(size / 2) - n), Math.max(0, size - n)];
  let got = 0;
  for (const s of spots) got += (await readPart(file, s, Math.min(size, s + n))).byteLength;
  if (!got) throw Object.assign(new Error(FILE_READ_HELP), { fileRead: true, detail: '빈 파일' });
}

// 드라이브 이어 올리기 주소로 영상 전체를 한 번에 PUT (진행률 표시)
async function putDirect(uploadUrl, blob, onProgress) {
  // 작은 영상은 메모리로 읽은 뒤 보냄 (파일 읽기 실패와 인터넷 실패를 구분하려고). 큰 파일은 그대로 흘려 보냄
  const body = blob.size <= SINGLE_PUT_MAX ? await readPart(blob, 0, blob.size) : blob;
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
    watchStall(xhr, reject);
    xhr.send(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIRECT_CHUNK = 8 * 1024 * 1024; // 큰 영상은 8MB 조각으로 (256KB 배수). 끊겨도 그 조각부터 다시
const SINGLE_PUT_MAX = 24 * 1024 * 1024; // 이보다 작으면 한 번에

// 조각 하나 보내기 → { done, file } 또는 { done:false, next }
async function putChunk(uploadUrl, blob, start, end, total, onProgress) {
  const body = end > start ? await readPart(blob, start, end) : null; // 조각을 먼저 읽음: 읽기 실패면 fileRead 오류
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    if (end > start) xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
    else xhr.setRequestHeader('Content-Range', `bytes */${total}`); // 지금까지 몇 바이트 받았는지 묻기
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 308) {
        const m = /bytes=0-(\d+)/.exec(xhr.getResponseHeader('Range') || '');
        resolve({ done: false, next: m ? Number(m[1]) + 1 : (end > start ? end : null) });
      } else if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve({ done: true, file: JSON.parse(xhr.responseText) }); } catch { reject(new Error('드라이브 응답을 읽지 못했습니다.')); }
      } else reject(Object.assign(new Error('드라이브 업로드 실패 (' + xhr.status + ')'), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('인터넷 연결이 끊겼습니다.'), { network: true }));
    xhr.ontimeout = () => reject(Object.assign(new Error('드라이브 업로드 시간 초과'), { network: true }));
    xhr.timeout = 5 * 60 * 1000;
    watchStall(xhr, reject);
    xhr.send(body);
  });
}

// 큰 영상: 조각으로 나눠 보내고, 끊기면 드라이브에 물어서 받은 데까지 확인한 뒤 이어서 보냄 (조각마다 최대 5번)
async function putDirectChunked(uploadUrl, blob, onProgress, onStatus) {
  const total = blob.size;
  let offset = 0, failures = 0;
  while (offset < total) {
    const end = Math.min(total, offset + DIRECT_CHUNK);
    try {
      const r = await putChunk(uploadUrl, blob, offset, end, total, (p) => onProgress?.((offset + p * (end - offset)) / total));
      if (r.done) return r.file;
      offset = r.next ?? end;
      failures = 0;
    } catch (e) {
      if (e.fileRead) throw e; // 파일을 못 읽는 것은 다시 해도 소용없음
      if (offset === 0 && !e.network) throw e; // 처음부터 막히면(브라우저가 막음 등) 다른 길로
      if (++failures > (offset === 0 ? 2 : 8)) throw Object.assign(e, { detail: `${e.detail || '끊김'} @${Math.round(offset / 1048576)}MB` }); // 한 조각도 못 보냈으면 오래 끌지 않고 다른 길로
      onStatus?.(`연결이 끊겨 이어서 올리는 중... (${failures}번째)`);
      await sleep(Math.min(15000, 2000 * failures));
      await waitUsable(); // 화면이 꺼졌거나 인터넷이 끊긴 동안은 기다렸다가
      try {
        const st = await putChunk(uploadUrl, blob, 0, 0, total);
        if (st.done) return st.file;
        if (st.next != null) offset = st.next;
      } catch { /* 다음 시도에서 다시 */ }
      onStatus?.('선생님 드라이브로 올리는 중...');
    }
  }
  const st = await putChunk(uploadUrl, blob, 0, 0, total);
  if (st.done) return st.file;
  throw new Error('드라이브 업로드가 끝나지 않았습니다.');
}

// 예비 경로: 엣지 함수를 거쳐 조각으로 보냄 (조각마다 최대 4번 다시 시도)
async function putRelay(uploadUrl, blob, onProgress, onStatus) {
  const total = blob.size;
  for (let start = 0; start < total; start += RELAY_CHUNK) {
    const end = Math.min(total, start + RELAY_CHUNK);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${FN_URL}?action=relay&session=${encodeURIComponent(uploadUrl)}`, {
          method: 'POST',
          headers: { ...(await authHeaders()), 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
          body: await readPart(blob, start, end),
        });
        const r = await readResult(res);
        onProgress?.(end / total);
        if (r.done) return r.file;
        break;
      } catch (e) {
        if (e.fileRead || attempt >= 6) throw Object.assign(e, { detail: `${e.detail || '중계 끊김'} @${Math.round(start / 1048576)}MB` });
        onStatus?.(`연결이 끊겨 이어서 올리는 중... (${attempt}번째)`);
        await sleep(2000 * attempt);
        await waitUsable();
      }
    }
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
    if (blob.size <= SINGLE_PUT_MAX) file = await putDirect(start.uploadUrl, blob, onProgress);
    else {
      try { file = await putDirectChunked(start.uploadUrl, blob, onProgress, onStatus); }
      catch (e) {
        if (e.network || e.fileRead) throw e;
        // 조각 보내기가 처음부터 막히는 브라우저: 한 번에 보내기
        start = await callDrive('start_upload', { ...meta, origin: window.location.origin });
        file = await putDirect(start.uploadUrl, blob, onProgress);
      }
    }
  } catch (e) {
    if (e.fileRead) throw e;
    console.warn('드라이브 직접 업로드 실패, 함수를 거쳐 다시 시도', e);
    route = 'relay';
    onStatus?.('다른 길로 올리는 중... (조금 더 걸립니다)');
    onProgress?.(0);
    start = await callDrive('start_upload', meta);
    file = await putRelay(start.uploadUrl, blob, onProgress, onStatus);
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
