import { useEffect, useState } from 'react';
import Upload from './upload/Upload.jsx';
import App from './App.jsx';

// 주소 하나로 운영: 기본은 학생 제출 화면, 위쪽 버튼으로 선생님(관리자) 화면 전환.
// 선생님이 마지막에 보던 화면은 기억해 두어 다음에 열 때 바로 그 화면으로.
const KEY = 'catchball_screen';

export default function Root() {
  const [screen, setScreen] = useState(() => {
    try {
      if (new URLSearchParams(window.location.search).has('teacher')) return 'teacher';
      return localStorage.getItem(KEY) === 'teacher' ? 'teacher' : 'student';
    } catch { return 'student'; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, screen); } catch { /* 무시 */ } }, [screen]);

  return (
    <>
      <nav className="cb-nav">
        <button type="button" className={screen === 'student' ? 'on' : ''} onClick={() => setScreen('student')}>🎒 학생 제출</button>
        <button type="button" className={screen === 'teacher' ? 'on' : ''} onClick={() => setScreen('teacher')}>👩‍🏫 선생님</button>
      </nav>
      {screen === 'student' ? <Upload /> : <App />}
    </>
  );
}
