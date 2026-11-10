// 수파베이스(저장소 + 데이터베이스)와 통신하는 부분.
// 영상은 storage 버킷 catchball-videos 에, 제출 목록·채점 결과는 RPC(supabase/catchball.sql)로 저장.
import { supabase, supabaseAnonKey, supabaseUrl, VIDEO_BUCKET } from './supabase.js';
import { fetchDriveVideo, trashDriveFile, uploadToDrive } from './drive.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 버킷 파일 크기 제한

// 세션이 없으면 익명으로 로그인 (학생 제출, 선생님 로그인 전 단계 모두 이걸 거침)
export async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: anon, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error('수파베이스 익명 로그인에 실패했습니다: ' + error.message);
  return anon.session;
}

async function rpc(name, params = {}) {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw new Error(error.message || '서버 오류');
  return data;
}

function safeName(name) {
  return String(name || 'video').replace(/[^\w.가-힣-]+/g, '_').slice(0, 80);
}

// ── 학생 업로드 ──

// storage 에 영상 올리기 (진행률을 보여 주려고 XHR 로 직접 보냄)
export async function uploadVideo({ blob, fileName, onProgress }) {
  const session = await ensureSession();
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`영상이 너무 큽니다 (${Math.round(blob.size / 1048576)}MB). 50MB 이하로 줄여서 올려 주세요.`);
  const uid = session.user.id;
  const path = `${uid}/${Date.now()}_${safeName(fileName)}`;
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${supabaseUrl}/storage/v1/object/${VIDEO_BUCKET}/${path}`, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', supabaseAnonKey);
    xhr.setRequestHeader('Content-Type', blob.type || 'video/webm');
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = '';
        try { msg = JSON.parse(xhr.responseText).message || JSON.parse(xhr.responseText).error || ''; } catch { /* 무시 */ }
        reject(new Error(`영상 올리기 실패 (${xhr.status}) ${msg}`.trim()));
      }
    };
    xhr.onerror = () => reject(new Error('영상을 올리지 못했습니다. 인터넷 연결을 확인해 주세요.'));
    xhr.ontimeout = () => reject(new Error('영상 올리기 시간 초과'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(blob);
  });
  return { path };
}

// ── 설정 (명렬표, 촬영 안내, 촬영 시간, 드라이브 연결) ──

export const DEFAULT_GUIDE = '두 사람이 옆모습으로 한 화면에 다 들어오게, 휴대폰을 가로로 눕혀 고정하고 찍어 주세요. 촬영 전에 화면에서 두 사람이 선 자리를 한 번씩 눌러 표시합니다.';

function rowsToMap(rows) { const m = {}; for (const r of rows || []) m[r.key] = r.value ?? ''; return m; }

// 명렬표 글: "1학년 3반" 줄 다음에 이름들(쉼표·띄어쓰기·줄바꿈 구분). 반 줄은 "반"으로 끝나거나 #, [ 로 시작.
export function parseRoster(text) {
  const classes = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[#[]/.test(line) || /반\s*\]?\s*$/.test(line)) {
      cur = { name: line.replace(/^[#[]\s*|\s*\]$/g, '').trim(), students: [] };
      classes.push(cur);
      continue;
    }
    if (!cur) { cur = { name: '', students: [] }; classes.push(cur); }
    for (const n of line.split(/[,，、·/\s]+/)) { const nm = n.trim(); if (nm && !cur.students.includes(nm)) cur.students.push(nm); }
  }
  return classes.filter((c) => c.students.length);
}

function normalizeSettings(m) {
  return {
    roster: m.roster || '',
    classes: parseRoster(m.roster || ''),
    guideText: m.guide_text || '',
    maxSeconds: Math.max(10, Math.min(600, Number(m.max_seconds) || 60)),
    allowResubmit: (m.allow_resubmit ?? '1') !== '0',
    driveOn: m.drive_on === '1',
    driveEmail: m.drive_email || '',
    signupCode: m.signup_code || '',
  };
}

// 학생 화면: 공개 설정 (아직 v2 SQL 을 안 돌린 서버면 기본값)
export async function getPublicSettings() {
  await ensureSession();
  let rows = [];
  try { rows = await rpc('catchball_public_settings'); } catch (e) { console.warn('설정을 못 읽어 기본값으로 진행', e); }
  return normalizeSettings(rowsToMap(rows));
}

// 선생님: 설정 (드라이브 열쇠는 서버 밖으로 안 나옴)
export async function getSettings() {
  const rows = await rpc('catchball_get_settings');
  return normalizeSettings(rowsToMap(rows));
}

export async function setSetting(key, value) {
  await rpc('catchball_set_setting', { p_key: key, p_value: value == null ? '' : String(value) });
}

export const isDrivePath = (path) => typeof path === 'string' && path.startsWith('drive:');

/**
 * 영상 제출 전체 흐름: 드라이브가 연결돼 있으면 드라이브로, 아니면 수파베이스 storage 로 올린 뒤 제출 기록(RPC)
 * onStatus(text), onProgress(0~1)
 */
export async function submitVideo({ info, blob, fileName, durationSec = null, playerMarks = null, useDrive = false, onStatus, onProgress }) {
  let path, driveFileId = null, driveLink = null, finalName = safeName(fileName), size = blob.size;
  // 다시 제출이 막혀 있으면 영상을 올리기 전에 알려 줌 (v2 SQL 전 서버면 건너뜀)
  try {
    const ok = await rpc('catchball_can_submit', { p_eval_date: info.date || null, p_class_name: info.className, p_student1: info.student1, p_student2: info.student2 });
    if (ok === false) throw new Error('이 팀은 오늘 이미 제출했어요. 다시 내려면 선생님께 말씀해 주세요');
  } catch (e) {
    if (/이미 제출/.test(e?.message || '')) throw e;
    console.warn('제출 가능 여부 확인 건너뜀', e);
  }
  let storage = 'supabase', note = '';
  if (useDrive) {
    try {
      const up = await uploadToDrive({ info, blob, fileName: finalName, onStatus, onProgress });
      driveFileId = up.fileId; driveLink = up.link || null; finalName = up.fileName || finalName; size = up.size || size;
      path = 'drive:' + driveFileId;
      storage = 'drive';
    } catch (e) {
      // 두 번째 길: 드라이브가 안 되면 수파베이스 저장소에 (영상을 잃지 않게)
      console.warn('드라이브 저장 실패, 수파베이스 저장소로 올립니다', e);
      if (blob.size > MAX_UPLOAD_BYTES) throw e;
      note = '드라이브에 못 올려 서버에 대신 저장했어요. (' + (e?.message || '') + ')';
      onStatus?.('드라이브 대신 서버에 올리는 중...');
      onProgress?.(0);
    }
  }
  if (!path) {
    onStatus?.(storage === 'drive' ? '' : '영상 올리는 중...');
    ({ path } = await uploadVideo({ blob, fileName, onProgress }));
  }
  onStatus?.('제출 기록 남기는 중...');
  const rows = await rpc('catchball_submit_v2', {
    p_eval_date: info.date || null,
    p_class_name: info.className,
    p_student1: info.student1,
    p_student2: info.student2,
    p_storage_path: path,
    p_drive_file_id: driveFileId,
    p_drive_link: driveLink,
    p_file_name: finalName,
    p_size_bytes: size,
    p_mime_type: blob.type || 'video/webm',
    p_duration_sec: durationSec,
    p_player_marks: playerMarks,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { id: row?.id, path, fileName: finalName, driveLink, storage, note };
}

// ── 선생님 ──

const TEACHER_NAME_KEY = 'catchball_teacher_username';

export function getSavedTeacherUsername() {
  try { return localStorage.getItem(TEACHER_NAME_KEY) || ''; } catch { return ''; }
}

// 선생님 가입 (첫 선생님은 코드 없이, 그 뒤는 가입 코드 필요 — supabase/catchball.sql 의 catchball_settings)
export async function teacherSignup({ username, password, code }) {
  await ensureSession();
  const rows = await rpc('catchball_teacher_signup', { p_username: username.trim(), p_password: password, p_code: code?.trim() || null });
  const me = Array.isArray(rows) ? rows[0] : rows;
  try { localStorage.setItem(TEACHER_NAME_KEY, me?.username || username.trim()); } catch { /* 무시 */ }
  return me;
}

export async function teacherChangePassword({ oldPassword, newPassword }) {
  return rpc('catchball_change_password', { p_old: oldPassword, p_new: newPassword });
}

export async function teacherLogin({ username, password }) {
  await ensureSession();
  const rows = await rpc('catchball_teacher_login', { p_username: username.trim(), p_password: password });
  const me = Array.isArray(rows) ? rows[0] : rows;
  try { localStorage.setItem(TEACHER_NAME_KEY, me?.username || username.trim()); } catch { /* 무시 */ }
  return me;
}

// 이미 로그인된 선생님이 있으면 {id, username}, 없으면 null
export async function teacherMe() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  const rows = await rpc('catchball_me');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function teacherLogout() {
  try { await rpc('catchball_teacher_logout'); } catch { /* 세션이 이미 없을 수 있음 */ }
  await supabase.auth.signOut();
}

export async function listSubmissions() {
  const rows = (await rpc('catchball_list_submissions')) || [];
  return rows.map((r) => ({
    id: r.id,
    submittedAt: r.created_at,
    date: r.eval_date,
    className: r.class_name, student1: r.student1, student2: r.student2,
    path: r.storage_path, fileName: r.file_name,
    sizeMb: r.size_bytes ? Math.round(r.size_bytes / 1048576 * 10) / 10 : 0,
    durationSec: r.duration_sec,
    status: r.status,
    autoSuccess: r.auto_success, autoFail: r.auto_fail,
    driveFileId: r.drive_file_id || null, driveLink: r.drive_link || null,
    playerMarks: Array.isArray(r.player_marks) ? r.player_marks : null,
  }));
}

export async function listResults() {
  const rows = (await rpc('catchball_list_results')) || [];
  return rows.map((r) => ({
    id: r.id, gradedAt: r.created_at, date: r.eval_date,
    className: r.class_name, student1: r.student1, student2: r.student2,
    success: r.success, fail: r.fail, bestStreak: r.best_streak,
    duration: r.duration_sec, memo: r.memo, submissionId: r.submission_id,
  }));
}

// 채점할 영상 내려받기 → Blob (드라이브 영상이면 선생님 드라이브에서 바로 받기)
export async function fetchVideo(path, onProgress) {
  if (isDrivePath(path)) return fetchDriveVideo(path.slice('drive:'.length), onProgress);
  const { data, error } = await supabase.storage.from(VIDEO_BUCKET).download(path);
  if (error) throw new Error('영상을 가져오지 못했습니다: ' + (error.message || ''));
  return data;
}

export async function saveResult(record) {
  return rpc('catchball_save_result', {
    p_submission_id: record.submissionId || null,
    p_eval_date: record.date || null,
    p_class_name: record.className,
    p_student1: record.student1,
    p_student2: record.student2,
    p_success: record.success,
    p_fail: record.fail,
    p_best_streak: record.bestStreak,
    p_duration_sec: record.duration ?? null,
    p_video_name: record.videoName || null,
    p_memo: record.memo || null,
    p_events: record.events || [],
  });
}

export async function deleteResult(id) {
  return rpc('catchball_delete_result', { p_id: id });
}

// 제출 기록과 영상 파일 삭제 (저장 용량 정리용)
export async function deleteSubmission(item) {
  const path = await rpc('catchball_delete_submission', { p_id: item.id });
  const target = path || item.path;
  if (isDrivePath(target)) {
    try { await trashDriveFile(target.slice('drive:'.length)); } catch (e) { throw new Error('기록은 지웠지만 드라이브 영상 삭제에 실패했습니다: ' + (e?.message || '')); }
    return;
  }
  if (target) {
    const { error } = await supabase.storage.from(VIDEO_BUCKET).remove([target]);
    if (error) throw new Error('기록은 지웠지만 영상 파일 삭제에 실패했습니다: ' + error.message);
  }
}

// ── 공 위치 표시 (학습 자료) ──

export async function listLabelCounts() {
  const rows = (await rpc('catchball_label_counts')) || [];
  const map = {};
  for (const r of rows) map[r.submission_id] = { n: r.n, nPresent: r.n_present };
  return map;
}

export async function listLabels(submissionId) {
  const rows = (await rpc('catchball_list_labels', { p_submission_id: submissionId })) || [];
  return rows.map((r) => ({ t: Number(r.t), present: !!r.present, x: r.x, y: r.y, r: r.r }));
}

// labels: [{t, present, x, y, r}]
export async function saveLabels(submissionId, labels) {
  return rpc('catchball_save_labels', { p_submission_id: submissionId, p_labels: labels });
}

export async function deleteLabels(submissionId) {
  return rpc('catchball_delete_labels', { p_submission_id: submissionId });
}
