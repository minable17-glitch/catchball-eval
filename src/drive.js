// 구글 드라이브 저장(앱스크립트)과 통신하는 부분. apps-script/Code.gs 참고.
// 요청은 Content-Type 을 text/plain 으로 보내야 앱스크립트가 CORS 사전 요청 없이 받아 줍니다.

export const MAX_RELAY_BYTES = 40 * 1024 * 1024; // 앱스크립트를 거쳐 올리는 예비 경로의 최대 크기
const CHUNK = 6 * 1024 * 1024;

export function isValidScriptUrl(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test((url || '').trim()) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url || '');
}

export async function scriptPost(scriptUrl, action, payload = {}, { timeoutMs = 120000 } = {}) {
  if (!scriptUrl) throw new Error('드라이브 연결(앱스크립트 주소)이 설정되지 않았습니다.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('앱스크립트 응답을 읽을 수 없습니다. 배포 설정("액세스 권한: 모든 사용자")을 확인해 주세요.'); }
    if (!data.ok && !data.needKey) throw new Error(data.error || '앱스크립트 오류');
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('앱스크립트 응답이 너무 오래 걸립니다.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function pingScript(scriptUrl) { return scriptPost(scriptUrl, 'ping', {}, { timeoutMs: 20000 }); }

// 선생님 키 정하기 (처음이면 만들어지고, 이미 있으면 맞는지 확인)
export function setupScript(scriptUrl, key) { return scriptPost(scriptUrl, 'setup', { key }, { timeoutMs: 30000 }); }

export function makeTeacherKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return 'cb-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 드라이브 이어 올리기 세션에 영상 전체를 한 번에 PUT (진행률 표시 가능)
function putToDrive(uploadUrl, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', blob.type || 'video/webm');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let fileId = null;
        try { fileId = JSON.parse(xhr.responseText).id || null; } catch { /* 응답을 못 읽어도 이름으로 찾음 */ }
        resolve({ fileId });
      } else {
        reject(new Error('드라이브 업로드 실패 (' + xhr.status + ')'));
      }
    };
    xhr.onerror = () => reject(new Error('드라이브에 직접 올리지 못했습니다.'));
    xhr.ontimeout = () => reject(new Error('드라이브 업로드 시간 초과'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(blob);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 학생 영상을 드라이브에 올림. 1순위: 드라이브 직접 업로드, 실패하면 2순위: 앱스크립트 중계(40MB 이하).
 * 돌려줌: { fileId, fileName, link, size, route }
 */
export async function uploadToDrive({ scriptUrl, info, blob, fileName, onStatus, onProgress }) {
  const meta = {
    className: info.className, student1: info.student1, student2: info.student2, date: info.date,
    fileName, mimeType: blob.type || 'video/webm', size: blob.size,
  };
  let fileId = null, uploadedName = null, route = 'drive';
  try {
    onStatus?.('드라이브에 올릴 준비 중...');
    const start = await scriptPost(scriptUrl, 'start_upload', { ...meta, origin: window.location.origin });
    uploadedName = start.fileName;
    onStatus?.('드라이브로 올리는 중...');
    const put = await putToDrive(start.uploadUrl, blob, onProgress);
    fileId = put.fileId;
  } catch (e) {
    console.warn('드라이브 직접 업로드 실패, 앱스크립트 중계로 다시 시도', e);
    if (blob.size > MAX_RELAY_BYTES) throw new Error('드라이브에 직접 올리지 못했고, 영상이 커서(' + Math.round(blob.size / 1048576) + 'MB) 다른 방법으로도 올릴 수 없습니다. 더 짧게 찍어서 다시 올려 주세요.');
    route = 'relay';
    onStatus?.('다른 방법으로 올리는 중... (조금 더 걸립니다)');
    onProgress?.(0);
    const data = await blobToBase64(blob);
    const res = await scriptPost(scriptUrl, 'upload_whole', { ...meta, data }, { timeoutMs: 10 * 60 * 1000 });
    fileId = res.fileId;
    uploadedName = res.fileName;
    onProgress?.(1);
  }
  onStatus?.('올라간 파일 확인 중...');
  const done = await scriptPost(scriptUrl, 'finish_upload', { ...meta, fileId, fileName: uploadedName, description: `${info.className} ${info.student1}·${info.student2} ${info.date || ''}` });
  return { fileId: done.fileId, fileName: done.fileName, link: done.link, size: done.size, route };
}

// 선생님: 드라이브 영상을 조각으로 내려받아 Blob 으로
export async function fetchDriveVideo({ scriptUrl, teacherKey }, fileId, onProgress) {
  const parts = [];
  let offset = 0, size = null, mimeType = 'video/webm', fileName = 'video.webm';
  do {
    const r = await scriptPost(scriptUrl, 'get_file', { teacherKey, fileId, offset, length: CHUNK }, { timeoutMs: 5 * 60 * 1000 });
    size = r.size; mimeType = r.mimeType || mimeType; fileName = r.fileName || fileName;
    const bin = atob(r.data || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    parts.push(bytes);
    offset = r.end;
    onProgress?.(size ? offset / size : 1);
    if (!r.data && offset < size) throw new Error('영상 조각을 받지 못했습니다.');
  } while (offset < size);
  return { blob: new Blob(parts, { type: mimeType }), fileName };
}

export function deleteDriveFile({ scriptUrl, teacherKey }, fileId) {
  return scriptPost(scriptUrl, 'delete_file', { teacherKey, fileId }, { timeoutMs: 60000 });
}
