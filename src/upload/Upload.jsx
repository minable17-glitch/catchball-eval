import { useEffect, useRef, useState } from 'react';
import { DEFAULT_GUIDE, getPublicSettings, MAX_UPLOAD_BYTES, submitVideo } from '../api.js';
import { canCompress, compressVideo, extForMime } from '../compress.js';
import { todayKST } from '../records.js';
import LiveCapture from './LiveCapture.jsx';
import { canRecord } from '../live.js';

const MB = 1024 * 1024;
const LAST_KEY = 'catchball_upload_last';

// 학생 제출 화면: 반·이름을 명렬표에서 고르고, 앱 안에서 촬영(또는 찍어 둔 영상)해서 올리기만 함.
// 횟수 세기는 여기서 하지 않음 (선생님이 영상을 보고 채점).
export default function Upload() {
  const [settings, setSettings] = useState(null); // {classes, guideText, maxSeconds, scriptUrl, allowResubmit}
  const [settingsErr, setSettingsErr] = useState('');
  const [info, setInfo] = useState(() => {
    let className = '';
    try { className = JSON.parse(localStorage.getItem(LAST_KEY) || '{}').className || ''; } catch { /* 무시 */ }
    return { date: todayKST(), className, student1: '', student2: '' };
  });
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | compressing | uploading | done | error
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [compress, setCompress] = useState(canCompress());
  const [mode, setMode] = useState(() => (canRecord() ? 'live' : 'file')); // live: 앱 안에서 촬영 / file: 찍어 둔 영상
  const abortRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    getPublicSettings()
      .then((s) => { if (!cancelled) setSettings(s); })
      .catch((e) => { if (!cancelled) { setSettingsErr(e?.message || '설정을 불러오지 못했습니다.'); setSettings({ classes: [], guideText: '', maxSeconds: 60, scriptUrl: '', allowResubmit: true }); } });
    return () => { cancelled = true; };
  }, []);

  const classes = settings?.classes || [];
  const useRoster = classes.length > 0;
  const currentClass = classes.find((c) => c.name === info.className) || null;
  const students = currentClass?.students || [];
  const guide = settings?.guideText?.trim() || DEFAULT_GUIDE;

  const validateInfo = () => {
    if (!info.className.trim() || !info.student1.trim() || !info.student2.trim()) return useRoster ? '반과 두 사람 이름을 모두 골라 주세요.' : '반과 두 사람 이름을 모두 적어 주세요.';
    if (info.student1.trim() === info.student2.trim()) return '두 사람 이름이 같아요. 다시 골라 주세요.';
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ className: info.className.trim() })); } catch { /* 무시 */ }
    return null;
  };

  const cleanInfo = () => ({ className: info.className.trim(), student1: info.student1.trim(), student2: info.student2.trim(), date: info.date });
  const busy = status === 'compressing' || status === 'uploading';

  const start = async () => {
    const err = validateInfo();
    if (err) { setMessage(err); return; }
    if (!file) { setMessage('영상을 먼저 골라 주세요.'); return; }
    setMessage('');
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;

    let blob = file, fileName = file.name, durationSec = null;
    try {
      if (compress) {
        setStatus('compressing'); setProgress(0);
        try {
          const out = await compressVideo(file, { onProgress: setProgress, signal: controller.signal });
          blob = out.blob;
          durationSec = Number.isFinite(out.duration) ? Math.round(out.duration) : null;
          fileName = file.name.replace(/\.[^.]+$/, '') + '.' + extForMime(out.mimeType);
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          console.warn('압축 실패, 원본을 그대로 올립니다', e);
          setMessage('압축이 안 되어 원본을 그대로 올립니다.');
        }
      }
      if (!settings?.scriptUrl && blob.size > MAX_UPLOAD_BYTES) throw new Error(`영상이 너무 큽니다 (${Math.round(blob.size / MB)}MB). "올리기 전에 영상 줄이기"를 켜거나 더 짧게 찍어 주세요.`);
      setStatus('uploading'); setProgress(0);
      const r = await submitVideo({ info: cleanInfo(), blob, fileName, durationSec, scriptUrl: settings?.scriptUrl || '', onStatus: setMessage, onProgress: setProgress });
      setResult({ ...r, sizeMb: Math.round(blob.size / MB * 10) / 10, originalMb: Math.round(file.size / MB * 10) / 10 });
      setStatus('done');
      setMessage('');
    } catch (e) {
      if (e?.name === 'AbortError') { setStatus('idle'); setMessage('취소했습니다.'); return; }
      console.error(e);
      setStatus('error');
      setMessage(e?.message || '올리는 중 문제가 생겼습니다.');
    }
  };

  const reset = () => { setFile(null); setStatus('idle'); setMessage(''); setResult(null); setInfo((v) => ({ ...v, student1: '', student2: '' })); };

  const pick = (field) => (e) => setInfo({ ...info, [field]: e.target.value });

  return (
    <div className="cb-app">
      <header className="cb-header">
        <h1>⚾ 캐치볼 영상 제출</h1>
        <p>반과 이름을 고르고, 앱에서 바로 촬영하면 끝나는 즉시 선생님께 올라갑니다. 영상은 선생님만 볼 수 있습니다.</p>
      </header>

      {status === 'done' && result ? (
        <section className="cb-card cb-done">
          <h2>✅ 제출 완료!</h2>
          <p className="cb-big">{info.className} · {info.student1} · {info.student2}</p>
          <p className="cb-note">파일: {result.fileName} ({result.sizeMb}MB{result.originalMb ? `, 원본 ${result.originalMb}MB` : ''}) · {result.storage === 'drive' ? '선생님 구글 드라이브에 저장됨' : '서버에 저장됨'}</p>
          <button type="button" className="cb-btn big" onClick={reset}>다른 팀 영상 올리기</button>
        </section>
      ) : (
        <section className="cb-card">
          {!settings && !settingsErr && <p className="cb-note">준비 중...</p>}
          {settingsErr && <p className="cb-warn">⚠️ {settingsErr} (이름을 직접 적어 제출할 수 있어요)</p>}
          {settings && (
            <>
              <div className="cb-tips cb-guide">
                <b>📋 촬영 안내</b>
                <p>{guide}</p>
                <small>촬영 시간은 최대 {settings.maxSeconds}초입니다. 시간이 되면 자동으로 끝나고 올라갑니다.</small>
              </div>
              <div className="cb-grid" style={{ marginTop: 12 }}>
                {useRoster ? (
                  <>
                    <label>반
                      <select value={currentClass ? info.className : ''} onChange={(e) => setInfo({ ...info, className: e.target.value, student1: '', student2: '' })} disabled={busy}>
                        <option value="">반 고르기</option>
                        {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    </label>
                    <label>학생 1
                      <select value={info.student1} onChange={pick('student1')} disabled={busy || !currentClass}>
                        <option value="">이름 고르기</option>
                        {students.filter((n) => n !== info.student2).map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                    <label>학생 2
                      <select value={info.student2} onChange={pick('student2')} disabled={busy || !currentClass}>
                        <option value="">이름 고르기</option>
                        {students.filter((n) => n !== info.student1).map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <label>반<input placeholder="예: 1학년 3반" value={info.className} onChange={pick('className')} disabled={busy} /></label>
                    <label>학생 1<input placeholder="이름" value={info.student1} onChange={pick('student1')} disabled={busy} /></label>
                    <label>학생 2<input placeholder="이름" value={info.student2} onChange={pick('student2')} disabled={busy} /></label>
                  </>
                )}
              </div>

              {canRecord() && (
                <div className="cb-mode" style={{ marginTop: 12 }}>
                  <button type="button" className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')} disabled={busy}>📹 바로 촬영해서 제출</button>
                  <button type="button" className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')} disabled={busy}>📁 찍어 둔 영상 올리기</button>
                </div>
              )}

              {mode === 'live' && (
                <LiveCapture key={`${info.className}|${info.student1}|${info.student2}`} info={cleanInfo()} validate={validateInfo} maxSeconds={settings.maxSeconds} scriptUrl={settings.scriptUrl} onReset={reset} />
              )}

              {mode === 'file' && (<>
              <label className={`cb-drop ${busy ? 'is-busy' : ''}`} style={{ marginTop: 12 }}>
                <input type="file" accept="video/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} disabled={busy} />
                <span>{file ? `📼 ${file.name} (${Math.round(file.size / MB)}MB)` : '여기를 눌러 영상 고르기'}</span>
                <small>캐치볼하는 두 사람이 옆모습으로 한 화면에 나오게 찍은 영상이어야 합니다.</small>
              </label>

              {canCompress() && (
                <label className="cb-check" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} disabled={busy} />
                  올리기 전에 영상 줄이기 (권장. 데이터와 시간을 아낍니다. 영상 길이만큼 걸립니다)
                </label>
              )}

              {busy && (
                <div className="cb-upload-progress">
                  <div className="cb-progress-bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <div className="cb-progress-text dark">
                    {status === 'compressing' ? `영상 줄이는 중 ${Math.round(progress * 100)}%` : `${message || '올리는 중'} ${Math.round(progress * 100)}%`}
                  </div>
                  <button type="button" className="cb-btn ghost" onClick={() => abortRef.current?.abort()}>취소</button>
                </div>
              )}
              {!busy && message && <p className={status === 'error' ? 'cb-error' : 'cb-note'}>{message}</p>}

              <button type="button" className="cb-btn big" onClick={start} disabled={busy}>영상 올리기</button>
              </>)}
            </>
          )}
        </section>
      )}
    </div>
  );
}
