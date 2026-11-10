# 캐치볼 영상 평가 (catchball-eval)

체육 수행평가용 도구. 두 학생이 캐치볼하는 영상을 올리면 **노란 공**과 아이들의 **손목·발목**을 브라우저 안에서 인식해
성공(잡음)/실패(떨어뜨림) 횟수를 자동으로 세고, 선생님이 확인·수정해서 기록합니다. 영상 인식은 전부 브라우저에서 돌아가고,
영상과 기록은 수파베이스(Supabase)에 저장됩니다.

주소는 하나입니다. 위쪽 버튼으로 화면을 바꿉니다 (`src/Root.jsx`).
- 🎒 **학생 제출** (기본 화면): 반·이름 입력 → 📹 앱 안에서 촬영(실시간 카운트, 끝나면 자동 업로드) 또는 📁 찍어 둔 영상 압축 업로드.
- 👩‍🏫 **선생님**: 전용 선생님 계정으로 로그인(처음엔 "계정 만들기") → 영상을 올리면 **기준 찍기**(화면 속 공 한 번, 두 아이 발 한 번씩 누르기 — 건너뛰기 가능) → 학생이 제출한 영상 목록 → 채점 → 저장. 로그인 없이도 이 기기에서 영상을 올려 채점·기록 가능. 마지막에 보던 화면을 기억하므로 선생님 기기에서는 다음부터 바로 선생님 화면이 뜸. `?teacher` 를 주소 뒤에 붙여도 선생님 화면으로 열림.

## 처음 설정 (한 번만)

이 도구는 **전용 수파베이스 프로젝트**를 씁니다. 다른 앱과 표·저장소·계정을 전혀 공유하지 않습니다.

1. **수파베이스 프로젝트 만들기**: https://supabase.com/dashboard → New project → 이름 `catchball-eval`, 지역 Northeast Asia (Seoul). 무료 플랜은 조직당 활성 프로젝트 2개까지이므로, 자리가 없으면 안 쓰는 프로젝트를 Pause 하거나 새 Organization 을 만드세요.
2. **익명 로그인 켜기**: 대시보드 → Authentication → Sign In / Providers → **Anonymous Sign-Ins** 켜기.
3. **SQL 실행**: 대시보드 → SQL Editor → `supabase/catchball.sql` 내용을 붙여 넣고 Run. (버킷 `catchball-videos` 와 `catchball_` 표·함수가 만들어짐)
4. **주소·키 넣기**: 대시보드 → Project Settings → API 에서 Project URL 과 publishable key 를 복사해 `.github/workflows/deploy.yml` 의 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 에 넣고 커밋.
5. **GitHub Pages 켜기**: 저장소 Settings → Pages → Source 를 **GitHub Actions** 로. 이후 `main` 에 push 하면 자동 배포.
   - 주소: `https://<아이디>.github.io/<저장소이름>/` (학생·선생님 공통, 위쪽 버튼으로 전환)
6. **선생님 계정 만들기**: 배포된 주소 → 위쪽 "선생님" → "계정 만들기". 첫 계정은 가입 코드 없이 만들어지고, 두 번째부터는 가입 코드(`catchball.sql` 의 `signup_code`, 기본 `catch-2026`)가 필요합니다.

## 로컬 개발

```
npm install
cp .env.example .env
npm run dev          # http://localhost:5173/
npm run build && npm run preview
```

## 실제 영상으로 기준 맞추기

ffmpeg 가 있으면 브라우저 없이 영상을 검사할 수 있습니다 (손 인식은 제외, 공 궤적만).

```
node scripts/catchball-offline.mjs 영상.mp4            # 성공/실패 판정 결과
DUMP=8-12 node scripts/catchball-offline.mjs 영상.mp4  # 8~12초 구간 프레임별 공 위치
```

브라우저에서는 채점이 끝난 뒤 콘솔의 `window.__catchballDebug` (track, events, groundY)로 같은 데이터를 볼 수 있습니다.
공 색 기준값은 `src/analysis.js` 의 `DEFAULT_BALL_PARAMS`(기본: 주황~노랑), 궤적 확정 기준은 `createTrackletTracker` 의 옵션, 캐치 판정 기준은 `DEFAULT_EVENT_PARAMS` 입니다.
`CONFIRM_LOG=1` 을 붙이면 어떤 궤적이 왜 공으로 인정됐는지(이동 거리·속도·매끄러움·중력)가 출력됩니다.

## 잘 찍는 요령

- 두 아이가 **옆모습**으로 한 화면에 들어오고, 공이 화면에서 **좌우로** 오가도록. (카메라 쪽으로 던지는 영상은 판정 불가)
- 휴대폰 **고정**(삼각대·책상). 한 영상에 **한 팀(2명)** 만.
- 노란 공이 잘 보이게 노란 옷·노란 배경·역광은 피하기.
- 자동 판정은 참고용. 결과 목록에서 성공/실패를 눌러 바꾸거나 지우고, 빠진 건 추가.

## 구조 (자세한 내용은 HANDOFF.md)

```
src/
  analysis.js   공 검출(HSV 색)·추적·캐치 판정 (순수 함수, node 에서도 실행 가능)
  analyzer.js   영상을 프레임 단위로 읽어 분석
  pose.js       MediaPipe 포즈(손목·발목) 래퍼
  live.js       촬영하면서 실시간 분석
  compress.js   브라우저에서 640px 로 압축
  api.js        수파베이스 저장소·RPC 통신
  supabase.js   수파베이스 클라이언트
  records.js    기기 저장(localStorage) + 엑셀 내려받기
  Root.jsx      화면 전환 (학생 제출 / 선생님)
  App.jsx       선생님 채점 화면
  upload/       학생 제출 화면 (Upload.jsx, LiveCapture.jsx)
supabase/catchball.sql   DB·스토리지 설정 (SQL Editor 에서 실행)
scripts/catchball-offline.mjs   ffmpeg 기반 오프라인 검사 도구
```
