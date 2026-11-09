// 수파베이스(저장소 + 데이터베이스)와 통신하는 부분.
// 영상은 storage 버킷 catchball-videos 에, 제출 목록·채점 결과는 RPC(supabase/catchball.sql)로 저장.
import { supabase, supabaseAnonKey, supabaseUrl, VIDEO_BUCKET } from './supabase.js';

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

/**
 * 영상 제출 전체 흐름: storage 업로드 → 제출 기록(RPC)
 * onStatus(text), onProgress(0~1)
 */
export async function submitVideo({ info, blob, fileName, durationSec = null, extra = {}, onStatus, onProgress }) {
  onStatus?.('영상 올리는 중...');
  const { path } = await uploadVideo({ blob, fileName, onProgress });
  onStatus?.('제출 기록 남기는 중...');
  const rows = await rpc('catchball_submit', {
    p_eval_date: info.date || null,
    p_class_name: info.className,
    p_student1: info.student1,
    p_student2: info.student2,
    p_storage_path: path,
    p_file_name: safeName(fileName),
    p_size_bytes: blob.size,
    p_mime_type: blob.type || 'video/webm',
    p_duration_sec: durationSec,
    p_auto_success: extra.autoSuccess ?? null,
    p_auto_fail: extra.autoFail ?? null,
    p_auto_events: extra.autoEvents ?? null,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { id: row?.id, path, fileName: safeName(fileName) };
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

// 채점할 영상 내려받기 → Blob
export async function fetchVideo(path) {
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
  if (target) {
    const { error } = await supabase.storage.from(VIDEO_BUCKET).remove([target]);
    if (error) throw new Error('기록은 지웠지만 영상 파일 삭제에 실패했습니다: ' + error.message);
  }
}
