/**
 * 캐치볼 영상 평가 — 구글 드라이브 저장용 앱스크립트
 *
 * 하는 일
 *  1. 학생이 올린 영상을 선생님 드라이브의 "캐치볼 제출" 폴더에 반/날짜별로 저장
 *  2. 선생님 페이지가 채점할 영상을 받아 가거나 지울 수 있게 함
 * 제출 목록·채점 결과·공 표시 같은 기록은 수파베이스에 남고, 영상 파일만 드라이브에 둡니다.
 *
 * 설치 방법은 같은 폴더의 README.md 를 보세요.
 * (script.google.com 새 프로젝트 → 이 파일 붙여넣기 → 배포 > 새 배포 > 웹 앱,
 *  "다음 사용자 인증 정보로 실행: 나", "액세스 권한: 모든 사용자" → 웹 앱 URL 을 선생님 화면 설정에 붙여넣기)
 *
 * 선생님 키(TEACHER_KEY)는 선생님 화면에서 "연결"을 누르면 처음 한 번 자동으로 정해져 스크립트 속성에 저장됩니다.
 * 직접 정하고 싶으면 프로젝트 설정 > 스크립트 속성에 TEACHER_KEY 를 넣어 두세요.
 *  ROOT_FOLDER_ID : 영상을 넣을 드라이브 폴더 ID (선택). 비워 두면 "캐치볼 제출" 폴더를 자동으로 만듦.
 */

var ROOT_FOLDER_NAME = '캐치볼 제출';
var MAX_RELAY_BYTES = 40 * 1024 * 1024; // 앱스크립트를 거쳐 올리는 경우(예비 경로) 최대 크기
var CHUNK_BYTES = 6 * 1024 * 1024;      // 선생님 페이지로 영상을 보낼 때 한 번에 보내는 크기

function doGet() {
  return json_({ ok: true, service: 'catchball-drive', version: 2 });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return json_({ ok: false, error: '요청 형식이 잘못되었습니다.' });
  }
  try {
    switch (req.action) {
      case 'ping':
        return json_({ ok: true, version: 2, hasKey: !!prop_('TEACHER_KEY') });
      case 'setup':
        return json_(setup_(req));
      case 'start_upload':
        return json_(startUpload_(req));
      case 'upload_whole':
        return json_(uploadWhole_(req));
      case 'finish_upload':
        return json_(finishUpload_(req));
      case 'get_file':
        requireTeacher_(req);
        return json_(getFile_(req));
      case 'delete_file':
        requireTeacher_(req);
        return json_(deleteFile_(req));
      default:
        return json_({ ok: false, error: '알 수 없는 요청: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ── 공통 ──────────────────────────────────────────────

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(key) {
  return (PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

/** 선생님 키 정하기: 아직 없으면 보내온 키를 저장, 이미 있으면 같은지만 확인 */
function setup_(req) {
  var key = String(req.key || '').trim();
  if (key.length < 12) throw new Error('키가 너무 짧습니다.');
  var cur = prop_('TEACHER_KEY');
  if (!cur) {
    PropertiesService.getScriptProperties().setProperty('TEACHER_KEY', key);
    rootFolder_(); // 폴더도 미리 만들어 둠
    return { ok: true, created: true };
  }
  if (cur === key) return { ok: true, created: false };
  return { ok: false, needKey: true, error: '이 스크립트에는 이미 선생님 키가 있습니다. 프로젝트 설정 > 스크립트 속성의 TEACHER_KEY 값을 넣어 주세요.' };
}

function requireTeacher_(req) {
  var key = prop_('TEACHER_KEY');
  if (!key) throw new Error('선생님 키가 아직 없습니다. 선생님 화면 설정에서 "연결"을 먼저 눌러 주세요.');
  if (!req.teacherKey || req.teacherKey !== key) throw new Error('선생님 키가 맞지 않습니다.');
}

function clean_(s, max) {
  return String(s == null ? '' : s).replace(/[\\/:*?"<>|\n\r\t]/g, ' ').trim().slice(0, max || 40);
}

function rootFolder_() {
  var id = prop_('ROOT_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var it = DriveApp.getRootFolder().getFoldersByName(ROOT_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.getRootFolder().createFolder(ROOT_FOLDER_NAME);
}

function subFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function targetFolder_(req) {
  var className = clean_(req.className, 30) || '반 미입력';
  var date = /^\d{4}-\d{2}-\d{2}$/.test(req.date || '') ? req.date : Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  return subFolder_(subFolder_(rootFolder_(), className), date);
}

function makeFileName_(req, originalName) {
  var ext = 'webm';
  var m = /\.([a-z0-9]{2,5})$/i.exec(originalName || '');
  if (m) ext = m[1].toLowerCase();
  var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'HHmmss');
  return clean_(req.student1, 20) + '_' + clean_(req.student2, 20) + '_' + stamp + '.' + ext;
}

// ── 학생 업로드 ─────────────────────────────────────────

/**
 * 1순위 경로: 드라이브 "이어 올리기(resumable)" 세션을 열어 주고, 학생 브라우저가 그 주소로 영상을 직접 보냄.
 * 영상이 앱스크립트를 거치지 않으므로 크기 제한이 사실상 없음.
 */
function startUpload_(req) {
  if (!clean_(req.student1) || !clean_(req.student2)) throw new Error('학생 이름 두 개를 입력해 주세요.');
  var folder = targetFolder_(req);
  var fileName = makeFileName_(req, req.fileName);
  var mime = req.mimeType || 'video/webm';
  var headers = {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    'X-Upload-Content-Type': mime,
  };
  if (req.size) headers['X-Upload-Content-Length'] = String(req.size);
  if (req.origin) headers['Origin'] = req.origin; // 브라우저에서 바로 PUT 할 수 있게 CORS 출처 등록
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: headers,
    payload: JSON.stringify({ name: fileName, parents: [folder.getId()], mimeType: mime }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('드라이브 업로드 세션을 열지 못했습니다: ' + res.getContentText().slice(0, 200));
  var location = res.getHeaders()['Location'] || res.getHeaders()['location'];
  if (!location) throw new Error('드라이브가 업로드 주소를 주지 않았습니다.');
  return { ok: true, uploadUrl: location, folderId: folder.getId(), fileName: fileName };
}

/** 예비 경로: 영상을 base64 로 앱스크립트에 보내면 여기서 드라이브에 저장. (40MB 이하) */
function uploadWhole_(req) {
  if (!clean_(req.student1) || !clean_(req.student2)) throw new Error('학생 이름 두 개를 입력해 주세요.');
  if (!req.data) throw new Error('영상 데이터가 없습니다.');
  var bytes = Utilities.base64Decode(req.data);
  if (bytes.length > MAX_RELAY_BYTES) throw new Error('영상이 너무 큽니다 (' + Math.round(bytes.length / 1048576) + 'MB). 더 짧게 찍어서 다시 올려 주세요.');
  var folder = targetFolder_(req);
  var fileName = makeFileName_(req, req.fileName);
  var file = folder.createFile(Utilities.newBlob(bytes, req.mimeType || 'video/webm', fileName));
  return { ok: true, fileId: file.getId(), fileName: fileName, size: bytes.length, link: file.getUrl() };
}

/** 업로드가 끝났는지 확인하고 파일 정보(ID, 링크, 크기)를 돌려줌 */
function finishUpload_(req) {
  var file = null;
  if (req.fileId) {
    file = DriveApp.getFileById(req.fileId);
  } else if (req.fileName) {
    // 브라우저가 드라이브 응답을 못 읽은 경우: 폴더에서 이름으로 찾음
    var it = targetFolder_(req).getFilesByName(req.fileName);
    if (it.hasNext()) file = it.next();
  }
  if (!file) throw new Error('올라간 파일을 찾지 못했습니다.');
  if (req.description) {
    try { file.setDescription(String(req.description).slice(0, 500)); } catch (e) { /* 무시 */ }
  }
  return { ok: true, fileId: file.getId(), fileName: file.getName(), link: file.getUrl(), size: file.getSize(), mimeType: file.getMimeType() };
}

// ── 선생님 ───────────────────────────────────────────

/** 채점할 영상을 조각(base64)으로 돌려줌: {fileId, offset, length} → 그 부분만 */
function getFile_(req) {
  if (!req.fileId) throw new Error('fileId 가 없습니다.');
  var file = DriveApp.getFileById(req.fileId);
  var blob = file.getBlob();
  var bytes = blob.getBytes();
  var size = bytes.length;
  var offset = Math.max(0, Number(req.offset || 0));
  var length = Math.min(CHUNK_BYTES, Number(req.length || CHUNK_BYTES));
  var end = Math.min(size, offset + length);
  var part = offset === 0 && end === size ? bytes : bytes.slice(offset, end);
  return {
    ok: true, fileName: file.getName(), mimeType: blob.getContentType() || 'video/webm', size: size,
    offset: offset, end: end, data: Utilities.base64Encode(part), link: file.getUrl(),
  };
}

function deleteFile_(req) {
  if (!req.fileId) throw new Error('fileId 가 없습니다.');
  try {
    DriveApp.getFileById(req.fileId).setTrashed(true);
  } catch (e) {
    return { ok: true, missing: true };
  }
  return { ok: true };
}
