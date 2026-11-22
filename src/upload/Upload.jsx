import { useEffect, useRef, useState } from 'react';
import { DEFAULT_GUIDE, getPublicSettings, MAX_UPLOAD_BYTES, submitVideo } from '../api.js';
import { canCompress, compressVideo, extForMime } from '../compress.js';
import { todayKST } from '../records.js';
import { FILE_READ_HELP, probeFile } from '../drive.js';
import { keepAwake } from '../keepAwake.js';
import LiveCapture from './LiveCapture.jsx';
import { canRecord } from '../live.js';

const MB = 1024 * 1024;
const LAST_KEY = 'catchball_upload_last';

// 학생 제출 화면: 반·이름을 명렬표에서 고르고, 앱 안에서 촬영(또는 찍어 둔 영상)해서 올리기만 함.
// 횟수 세기는 여기서 하지 않음 (선생님이 영상을 보고 채점).
export default function Upload() {
  const [settings, setSettings] = useState(null); // {classes, guideText, maxSeconds, driveOn, allowResubmit}
  const [settingsErr, setSettingsErr] = useState('');
  const [info, setInfo] = useState(() => {
    let className = '';
    try { className = JSON.parse(localStorage.getItem(LAST_KEY) || '{}').className || ''; } catch { /* 무시 */ }
    return { date: todayKST(), className, student1: '', student2: '' };
  });
  const [round, setRound] = useState(''); // 학생이 고른 평가 회차
  const [file, setFile] = useState(null);
  const [fileProblem, setFileProblem] = useState(''); // 고른 파일을 폰이 넘겨주지 않을 때의 안내
  const pickSeq = useRef(0);
  const [status, setStatus] = useState('idle'); // idle | compressing | uploading | done | error
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [compress, setCompress] = useState(false); // 기본은 줄이지 않고 원본 그대로 (1분 안쪽 영상은 그대로도 잘 올라감)
  const [mode, setMode] = useState(() => (canRecord() ? 'live' : 'file')); // live: 앱 안에서 촬영 / file: 찍어 둔 영상
  const abortRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    getPublicSettings()
      .then((s) => { if (!cancelled) setSettings(s); })
      .catch((e) => { if (!cancelled) { setSettingsErr(e?.message || '설정을 불러오지 못했습니다.'); setSettings({ classes: [], guideText: '', maxSeconds: 60, driveOn: false, allowResubmit: true, rounds: ['수행평가 1'] }); } });
    return () => { cancelled = true; };
  }, []);

  const classes = settings?.classes || [];
  const useRoster = classes.length > 0;
  const currentClass = classes.find((c) => c.name === info.className) || null;
  const students = currentClass?.students || [];
  const guide = settings?.guideText?.trim() || DEFAULT_GUIDE;

  const rounds = settings?.rounds?.length ? settings.rounds : ['수행평가 1'];
  const chosenRound = rounds.length === 1 ? rounds[0] : round;

  // 영상을 고르면 바로 읽어 봄: 못 읽는 파일이면 기다리게 하지 않고 곧바로 알려 줌
  const pickFile = async (f) => {
    const seq = ++pickSeq.current;
    setFile(f || null); setFileProblem(''); setMessage(''); if (status === 'error') setStatus('idle');
    if (!f) return;
    if (f.type && !/^video\//.test(f.type) && !/\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(f.name)) { setFileProblem('영상 파일이 아니에요. 영상을 골라 주세요.'); return; }
    try { await probeFile(f); }
    catch (e) { if (seq === pickSeq.current) setFileProblem(`${e?.message || FILE_READ_HELP}${e?.detail ? ` (${e.detail})` : ''}`); }
  };

  const validateInfo = () => {
    if (!chosenRound) return '몇 번째 수행평가인지 먼저 골라 주세요.';
    if (!info.className.trim() || !info.student1.trim() || !info.student2.trim()) return useRoster ? '반과 두 사람 이름을 모두 골라 주세요.' : '반과 두 사람 이름을 모두 적어 주세요.';
    if (info.student1.trim() === info.student2.trim()) return '두 사람 이름이 같아요. 다시 골라 주세요.';
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ className: info.className.trim() })); } catch { /* 무시 */ }
    return null;
  };

  const cleanInfo = () => ({ round: chosenRound, className: info.className.trim(), student1: info.student1.trim(), student2: info.student2.trim(), date: info.date });
  const busy = status === 'compressing' || status === 'uploading';

  const start = async () => {
    const err = validateInfo();
    if (err) { setMessage(err); return; }
    if (!file) { setMessage('영상을 먼저 골라 주세요.'); return; }
    try { await probeFile(file); }
    catch (e) { setStatus('error'); setFileProblem(`${e?.message || FILE_READ_HELP}${e?.detail ? ` (${e.detail})` : ''}`); return; }
    setFileProblem('');
    setMessage('');
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;

    let blob = file, fileName = file.name, durationSec = null, compressNote = '';
    const release = await keepAwake(); // 줄이고 올리는 동안 화면이 꺼지지 않게
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
          compressNote = `영상 줄이기가 안 되어(${String(e?.message || e?.name || '').slice(0, 40)}) 원본(${Math.round(file.size / MB)}MB)을 그대로 올립니다. 시간이 걸릴 수 있어요.`;
        }
      }
      if (!settings?.driveOn && blob.size > MAX_UPLOAD_BYTES) throw new Error(`영상이 너무 큽니다 (${Math.round(blob.size / MB)}MB). "영상을 줄여서 올리기"를 켜거나 더 짧게 찍어 주세요.`);
      setStatus('uploading'); setProgress(0);
      const r = await submitVideo({ info: cleanInfo(), blob, fileName, durationSec, useDrive: !!settings?.driveOn, onStatus: (m) => setMessage(compressNote ? `${compressNote} ${m}` : m), onProgress: setProgress });
      setResult({ ...r, sizeMb: Math.round(blob.size / MB * 10) / 10, originalMb: Math.round(file.size / MB * 10) / 10 });
      setStatus('done');
      setMessage('');
    } catch (e) {
      if (e?.name === 'AbortError') { setStatus('idle'); setMessage('취소했습니다.'); return; }
      console.error(e);
      setStatus('error');
      if (e?.fileRead) { setMessage(''); setFileProblem(`${e.message}${e.detail ? ` (${e.detail})` : ''}`); }
      else setMessage(e?.message || '올리는 중 문제가 생겼습니다.');
    } finally { release(); }
  };

  const reset = () => { setFileProblem(''); setFile(null); setStatus('idle'); setMessage(''); setResult(null); setInfo((v) => ({ ...v, student1: '', student2: '' })); };

  const pick = (field) => (e) => setInfo({ ...info, [field]: e.target.value });

  return (
    <div className="cb-app">
      <header className="cb-header">
        <h1>⚾ 캐치볼 영상 제출</h1>
        <p>반과 이름을 고르고 앱에서 바로 촬영하세요. 찍은 영상을 확인한 뒤 올리면 선생님께 전달됩니다. 영상은 선생님만 볼 수 있습니다.</p>
      </header>

      {status === 'done' && result ? (
        <section className="cb-card cb-done">
          <h2>✅ 제출 완료!</h2>
          <p className="cb-big">{chosenRound} · {info.className} · {info.student1} · {info.student2}</p>
          <p className="cb-note">파일: {result.fileName} ({result.sizeMb}MB{result.originalMb ? `, 원본 ${result.originalMb}MB` : ''}) · {result.storage === 'drive' ? '선생님 구글 드라이브에 저장됨' : '서버에 저장됨'}</p>
          <button type="button" className="cb-btn big" onClick={reset}>다른 팀 영상 올리기</button>
        </section>
      ) : (
        <section className="cb-card">
          {!settings && !settingsErr && <p className="cb-note">준비 중...</p>}
          {settingsErr && <p className="cb-warn">⚠️ {settingsErr} (이름을 직접 적어 제출할 수 있어요)</p>}
          {settings && (
            <>
              {rounds.length > 1 ? (
                <div className="cb-round-pick">
                  <div className="cb-round-pick-title">📝 어떤 수행평가를 내나요?</div>
                  <div className="cb-mode">
                    {rounds.map((r) => <button key={r} type="button" className={chosenRound === r ? 'on' : ''} onClick={() => setRound(r)} disabled={busy}>{r}</button>)}
                  </div>
                </div>
              ) : <div className="cb-round-badge">📝 <b>{chosenRound}</b> 제출</div>}
              <div className="cb-tips cb-guide">
                <b>📋 촬영 안내</b>
                <p>{guide}</p>
                <small>촬영 시간은 최대 {settings.maxSeconds}초입니다. 시간이 되면 촬영이 자동으로 끝나고, 영상을 확인한 뒤 올릴지 다시 찍을지 고릅니다.</small>
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
                <LiveCapture key={`${chosenRound}|${info.className}|${info.student1}|${info.student2}`} info={cleanInfo()} validate={validateInfo} maxSeconds={settings.maxSeconds} useDrive={settings.driveOn} onReset={reset} />
              )}

              {mode === 'file' && (<>
              <label className={`cb-drop ${busy ? 'is-busy' : ''}`} style={{ marginTop: 12 }}>
                <input type="file" accept="video/*" onChange={(e) => pickFile(e.target.files?.[0])} disabled={busy} />
                <span>{file ? `📼 ${file.name} (${Math.round(file.size / MB)}MB)` : '여기를 눌러 앨범에서 영상 고르기'}</span>
                <small>캐치볼하는 두 사람이 옆모습으로 한 화면에 나오게 찍은 영상이어야 합니다.</small>
                {file && file.size > 100 * MB && <small style={{ color: '#a4262c', fontWeight: 700 }}>영상이 커요({Math.round(file.size / MB)}MB). 올리는 데 1~3분쯤 걸릴 수 있어요. 화면을 켜 둔 채로 기다려 주세요.</small>}
              </label>

              {fileProblem && <p className="cb-error" style={{ marginTop: 10 }}>⚠️ {fileProblem}</p>}
              {/* 갤러리(사진 선택기)가 영상을 못 넘겨줄 때: 영상 말고 다른 종류도 받는다고 하면 폰이 '파일' 앱 선택기를 엶 */}
              <label className={`cb-file-alt ${busy ? 'is-busy' : ''}`}>
                <input type="file" accept=".mp4,.mov,.m4v,.webm,.mkv,.3gp,application/octet-stream" onChange={(e) => pickFile(e.target.files?.[0])} disabled={busy} />
                📂 파일 앱에서 고르기 <span className="cb-sub">(위에서 고른 영상이 안 올라갈 때)</span>
              </label>

              {canCompress() && (
                <label className="cb-check" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} disabled={busy} />
                  영상을 줄여서 올리기 (선택. 데이터가 부족할 때만 켜세요. 영상 길이만큼 더 걸리고, 일부 폰에서는 안 됩니다)
                </label>
              )}

              {busy && (
                <div className="cb-upload-progress">
                  <div className="cb-progress-bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <div className="cb-progress-text dark">
                    {status === 'compressing' ? `영상 줄이는 중 ${Math.round(progress * 100)}%` : `${message || '올리는 중'} ${Math.round(progress * 100)}%${file && file.size > 30 * MB && !compress ? ` (${Math.round(progress * file.size / MB)}/${Math.round(file.size / MB)}MB)` : ''}`}
                  </div>
                  <p className="cb-note" style={{ margin: '4px 0' }}>📱 끝날 때까지 <b>이 화면을 켜 둔 채로</b> 기다려 주세요. 다른 앱으로 가거나 화면이 꺼지면 올리기가 멈춥니다.</p>
                  <button type="button" className="cb-btn ghost" onClick={() => abortRef.current?.abort()}>취소</button>
                </div>
              )}
              {!busy && message && <p className={status === 'error' ? 'cb-error' : 'cb-note'}>{message}</p>}

              <button type="button" className="cb-btn big" onClick={start} disabled={busy || !!fileProblem}>영상 올리기</button>
              </>)}
            </>
          )}
        </section>
      )}
    </div>
  );
}
