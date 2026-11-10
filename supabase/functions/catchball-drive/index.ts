// 캐치볼 평가: 학생 영상을 선생님 구글 드라이브에 저장하는 엣지 함수.
// 파라런과 같은 방식: 선생님이 앱에서 "구글 드라이브 연결"을 한 번 눌러 허락하면(OAuth),
// 받은 열쇠(refresh token)를 이 프로젝트 DB 에만 보관하고, 그 뒤 학생 업로드는 이 함수가 선생님 드라이브로 보내 줌.
//
// 필요한 비밀값 (Supabase → Edge Functions → Secrets): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// 배포할 때 "Enforce JWT verification(JWT 확인)"은 끔 (구글이 돌아올 때는 로그인 정보가 없음. 대신 함수 안에서 직접 확인)
// 권한 범위는 drive.file: 이 앱이 만든 파일·폴더만 보고 고칠 수 있음 (선생님 드라이브의 다른 파일은 못 봄).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
const OAUTH_BASE = Deno.env.get('GOOGLE_OAUTH_BASE') ?? 'https://oauth2.googleapis.com';
const AUTH_BASE = Deno.env.get('GOOGLE_AUTH_BASE') ?? 'https://accounts.google.com';
const API_BASE = Deno.env.get('GOOGLE_API_BASE') ?? 'https://www.googleapis.com';
const FN_URL = Deno.env.get('CATCHBALL_FN_URL') ?? `${SUPABASE_URL}/functions/v1/catchball-drive`;
const ROOT_FOLDER_NAME = '캐치볼 제출';
const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, content-range',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

// ── 설정 표 (service role 로만 읽고 씀. 열쇠는 학생·선생님 화면으로 절대 내보내지 않음) ──
async function getSetting(key: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/catchball_settings?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new HttpError(500, '설정을 읽지 못했어요: ' + (await r.text()).slice(0, 200));
  const rows = await r.json();
  return rows[0]?.value ?? '';
}

async function setSetting(key: string, value: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/catchball_settings?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new HttpError(500, '설정을 저장하지 못했어요: ' + (await r.text()).slice(0, 200));
}

// ── 부른 사람 확인: 로그인(익명 포함)했는지, 선생님인지 ──
async function caller(req: Request): Promise<{ uid: string; teacher: boolean }> {
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer .+/.test(auth)) throw new HttpError(401, '로그인 정보가 없어요. 페이지를 새로고침해 주세요.');
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: auth } });
  if (!u.ok) throw new HttpError(401, '로그인이 만료됐어요. 페이지를 새로고침해 주세요.');
  const user = await u.json();
  if (!user?.id) throw new HttpError(401, '로그인 정보가 올바르지 않아요.');
  const t = await fetch(`${SUPABASE_URL}/rest/v1/rpc/catchball_current_teacher`, {
    method: 'POST', headers: { apikey: ANON_KEY, Authorization: auth, 'Content-Type': 'application/json' }, body: '{}',
  });
  const tid = t.ok ? await t.json() : null;
  return { uid: user.id, teacher: !!tid };
}

async function requireTeacher(req: Request) {
  const c = await caller(req);
  if (!c.teacher) throw new HttpError(403, '선생님 로그인이 필요해요.');
  return c;
}

// ── 구글 열쇠 ──
let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new HttpError(500, '엣지 함수 비밀값(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)이 없어요.');
  const refresh = await getSetting('drive_refresh_token');
  if (!refresh) throw new HttpError(409, '선생님이 아직 구글 드라이브를 연결하지 않았어요.');
  const r = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      await setSetting('drive_on', '0');
      throw new HttpError(409, '구글 드라이브 연결이 끊겼어요. 선생님 화면 설정에서 다시 연결해 주세요.');
    }
    throw new HttpError(502, '구글 열쇠를 받지 못했어요: ' + (data.error_description || data.error || r.status));
  }
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}

async function gapi(path: string, init: RequestInit = {}) {
  const token = await accessToken();
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new HttpError(502, `구글 드라이브 오류 (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return r;
}

const clean = (s: unknown, max = 40) => String(s ?? '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').trim().slice(0, max);
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findOrCreateFolder(name: string, parent: string | null): Promise<string> {
  const query = `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false` + (parent ? ` and '${q(parent)}' in parents` : ` and 'root' in parents`);
  const list = await (await gapi(`/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`)).json();
  if (list.files?.[0]?.id) return list.files[0].id;
  const made = await (await gapi('/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) }),
  })).json();
  return made.id;
}

async function rootFolder(): Promise<string> {
  const saved = await getSetting('drive_root_id');
  if (saved) {
    const r = await fetch(`${API_BASE}/drive/v3/files/${encodeURIComponent(saved)}?fields=id,trashed`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (r.ok && !(await r.json()).trashed) return saved;
  }
  const id = await findOrCreateFolder(ROOT_FOLDER_NAME, null);
  await setSetting('drive_root_id', id);
  return id;
}

// ── 동작들 ──

async function startUpload(body: Record<string, unknown>) {
  const s1 = clean(body.student1, 20), s2 = clean(body.student2, 20);
  if (!s1 || !s2) throw new HttpError(400, '학생 이름 두 개가 필요해요.');
  const className = clean(body.className, 30) || '반 미입력';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? '')) ? String(body.date) : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const root = await rootFolder();
  const folder = await findOrCreateFolder(date, await findOrCreateFolder(className, root));
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(String(body.fileName ?? ''))?.[1] || 'webm').toLowerCase();
  const stamp = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 19).replace(/:/g, '');
  const name = `${s1}_${s2}_${stamp}.${ext}`;
  const mime = /^video\/[\w.+-]+$/.test(String(body.mimeType ?? '')) ? String(body.mimeType) : 'video/webm';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mime,
  };
  const size = Number(body.size);
  if (Number.isFinite(size) && size > 0) headers['X-Upload-Content-Length'] = String(Math.round(size));
  if (typeof body.origin === 'string' && /^https?:\/\/[\w.:-]+$/.test(body.origin)) headers['Origin'] = body.origin; // 학생 브라우저가 바로 올릴 수 있게
  const r = await fetch(`${API_BASE}/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,mimeType,webViewLink`, {
    method: 'POST', headers,
    body: JSON.stringify({ name, parents: [folder], mimeType: mime, description: `${className} ${s1}·${s2} ${date}` }),
  });
  if (!r.ok) throw new HttpError(502, '드라이브 업로드 준비 실패: ' + (await r.text()).slice(0, 200));
  const uploadUrl = r.headers.get('location');
  if (!uploadUrl) throw new HttpError(502, '드라이브가 업로드 주소를 주지 않았어요.');
  return { uploadUrl, fileName: name };
}

// 예비 경로: 브라우저가 드라이브에 바로 못 보낼 때 조각을 받아 대신 보냄
async function relayChunk(req: Request, url: URL) {
  const session = url.searchParams.get('session') ?? '';
  if (!session.startsWith(`${API_BASE}/upload/drive/v3/files?`)) throw new HttpError(400, '업로드 주소가 올바르지 않아요.');
  const range = req.headers.get('content-range') ?? '';
  if (!/^bytes \d+-\d+\/\d+$/.test(range)) throw new HttpError(400, 'Content-Range 가 필요해요.');
  const buf = new Uint8Array(await req.arrayBuffer());
  const r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': range, 'Content-Length': String(buf.byteLength) }, body: buf });
  if (r.status === 308) return { done: false, range: r.headers.get('range') };
  if (r.ok) return { done: true, file: await r.json() };
  throw new HttpError(502, `드라이브로 보내기 실패 (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

async function finishUpload(body: Record<string, unknown>) {
  const id = String(body.fileId ?? '');
  if (!/^[\w-]{10,}$/.test(id)) throw new HttpError(400, '파일 ID 가 올바르지 않아요.');
  const f = await (await gapi(`/drive/v3/files/${id}?fields=id,name,size,mimeType,webViewLink,trashed`)).json();
  if (f.trashed) throw new HttpError(400, '파일이 휴지통에 있어요.');
  return { fileId: f.id, fileName: f.name, size: Number(f.size) || null, link: f.webViewLink || null, mimeType: f.mimeType };
}

async function authUrl(body: Record<string, unknown>) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new HttpError(500, '엣지 함수 비밀값(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)을 먼저 넣어 주세요.');
  const returnTo = String(body.returnTo ?? '');
  if (!/^(https:\/\/[\w.-]+\.github\.io\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(returnTo)) throw new HttpError(400, '돌아올 주소가 올바르지 않아요.');
  const nonce = crypto.randomUUID();
  await setSetting('drive_oauth_state', JSON.stringify({ nonce, returnTo, exp: Date.now() + 15 * 60_000 }));
  const p = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: FN_URL, response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: nonce,
  });
  return { url: `${AUTH_BASE}/o/oauth2/v2/auth?${p}` };
}

function back(returnTo: string, result: string) {
  const u = new URL(returnTo);
  u.searchParams.set('teacher', '1');
  u.searchParams.set('drive', result);
  return new Response(null, { status: 302, headers: { Location: u.toString() } });
}

async function oauthCallback(url: URL) {
  const raw = await getSetting('drive_oauth_state');
  let st: { nonce?: string; returnTo?: string; exp?: number } = {};
  try { st = JSON.parse(raw || '{}'); } catch { /* 무시 */ }
  if (!st.nonce || st.nonce !== url.searchParams.get('state') || !st.returnTo || (st.exp ?? 0) < Date.now()) {
    return new Response('연결 요청이 만료됐거나 올바르지 않아요. 앱에서 다시 "구글 드라이브 연결"을 눌러 주세요.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  await setSetting('drive_oauth_state', '');
  if (url.searchParams.get('error')) return back(st.returnTo, 'denied');
  const code = url.searchParams.get('code') ?? '';
  const r = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: FN_URL, grant_type: 'authorization_code' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.refresh_token) return back(st.returnTo, 'error');
  let email = '';
  try { email = JSON.parse(atob(String(data.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || ''; } catch { /* 무시 */ }
  await setSetting('drive_refresh_token', data.refresh_token);
  await setSetting('drive_email', email);
  await setSetting('drive_root_id', '');
  await setSetting('drive_on', '1');
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  try { await rootFolder(); } catch { /* 폴더는 첫 업로드 때 다시 만듦 */ }
  return back(st.returnTo, 'ok');
}

async function disconnect() {
  const refresh = await getSetting('drive_refresh_token');
  if (refresh) { try { await fetch(`${OAUTH_BASE}/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }); } catch { /* 무시 */ } }
  await setSetting('drive_refresh_token', '');
  await setSetting('drive_on', '0');
  cached = null;
  return { ok: true };
}

async function status() {
  const on = (await getSetting('drive_on')) === '1' && !!(await getSetting('drive_refresh_token'));
  return { connected: on, email: on ? await getSetting('drive_email') : '', configured: !!(CLIENT_ID && CLIENT_SECRET) };
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method === 'GET' && (url.searchParams.has('code') || url.searchParams.has('error'))) return await oauthCallback(url);
    if (req.method === 'GET') return json({ ok: true, service: 'catchball-drive' });
    if (url.searchParams.get('action') === 'relay') {
      await caller(req);
      return json({ ok: true, ...(await relayChunk(req, url)) });
    }
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case 'status': await requireTeacher(req); return json({ ok: true, ...(await status()) });
      case 'auth_url': await requireTeacher(req); return json({ ok: true, ...(await authUrl(body)) });
      case 'disconnect': await requireTeacher(req); return json(await disconnect());
      case 'token': await requireTeacher(req); return json({ ok: true, accessToken: await accessToken(), apiBase: API_BASE });
      case 'start_upload': await caller(req); return json({ ok: true, ...(await startUpload(body)) });
      case 'finish_upload': await caller(req); return json({ ok: true, ...(await finishUpload(body)) });
      default: throw new HttpError(400, '알 수 없는 요청: ' + body.action);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, status);
  }
}

Deno.serve(handle);
