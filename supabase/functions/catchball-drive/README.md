# 구글 드라이브 연결 설정 (catchball-drive 엣지 함수)

학생이 올린 영상을 **선생님 구글 드라이브**에 저장합니다. 파라런과 같은 방식입니다.
선생님이 앱에서 "구글 드라이브 연결"을 한 번 눌러 허락하면, 그 뒤로 학생은 구글 로그인 없이 올려도 선생님 드라이브 `캐치볼 제출 › 반 › 날짜` 폴더에 들어갑니다.

- 열쇠(refresh token)는 캐치볼 전용 수파베이스 DB 에만 있고, 이 함수만 읽습니다. 학생·선생님 화면으로는 나가지 않습니다.
- 권한은 `drive.file` 하나: 이 앱이 만든 파일·폴더만 다룹니다. 드라이브의 다른 파일은 보지도 못합니다.
- 영상은 학생 폰에서 드라이브로 바로 갑니다(함수는 업로드 주소만 열어 줌). 바로 못 가면 함수가 4MB 조각으로 대신 보냅니다. 그래도 안 되면 수파베이스 저장소에 저장됩니다.

## 1. 구글 클라우드: OAuth 클라이언트 만들기 (5분)

파라런 때 만든 구글 클라우드 프로젝트를 그대로 써도 됩니다.

1. https://console.cloud.google.com → 위쪽에서 파라런 프로젝트 선택
2. **API 및 서비스 › 사용자 인증 정보 › + 사용자 인증 정보 만들기 › OAuth 클라이언트 ID**
3. 애플리케이션 유형 **웹 애플리케이션**, 이름 `캐치볼`
4. **승인된 리디렉션 URI**에 아래 한 줄 추가:
   `https://acuyoomltvbqdetssfyl.supabase.co/functions/v1/catchball-drive`
5. 만들기 → 나오는 **클라이언트 ID**와 **클라이언트 보안 비밀번호**를 복사 (보안 비밀번호는 채팅에 붙여 넣지 말 것)
6. **API 및 서비스 › 라이브러리**에서 "Google Drive API"가 사용 설정돼 있는지 확인 (파라런에서 켜 두었으면 그대로)
7. OAuth 동의 화면이 "프로덕션(게시됨)"인지 확인. "테스트" 상태면 연결이 7일마다 끊깁니다.

## 2. 수파베이스(캐치볼 전용 프로젝트): 비밀값 넣기

https://supabase.com/dashboard/project/acuyoomltvbqdetssfyl/functions/secrets

- `GOOGLE_CLIENT_ID` = 1단계의 클라이언트 ID
- `GOOGLE_CLIENT_SECRET` = 1단계의 클라이언트 보안 비밀번호

## 3. 수파베이스: 함수 배포

https://supabase.com/dashboard/project/acuyoomltvbqdetssfyl/functions

1. **Deploy a new function › Via Editor**
2. 함수 이름 `catchball-drive` (정확히 이 이름)
3. 편집기의 `index.ts` 내용을 모두 지우고 이 폴더의 `index.ts` 전체를 붙여 넣기 → **Deploy**
4. 배포 후 함수 **Details(설정)**에서 **Enforce JWT verification(JWT 확인)을 끄기** → 저장
   (구글이 허락 후 돌아올 때는 로그인 정보가 없어서 꺼야 합니다. 대신 함수 안에서 학생·선생님을 직접 확인합니다.)

CLI 를 쓴다면: `supabase functions deploy catchball-drive --no-verify-jwt --project-ref acuyoomltvbqdetssfyl`

## 4. 앱에서 연결

선생님 화면 → 로그인 → ⚙️ 제출 설정 › 열기 → **구글 드라이브 연결** → 선생님 구글 계정 선택 → 허락
→ 앱으로 돌아와 "구글 드라이브가 연결됐습니다"와 계정 메일이 보이면 끝.

## 문제가 생기면

| 보이는 문구 | 할 일 |
|---|---|
| 드라이브 연결 함수(catchball-drive)가 아직 배포되지 않았어요 | 3단계 (이름이 정확히 `catchball-drive` 인지) |
| 엣지 함수 비밀값(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)… | 2단계 |
| 구글 화면에 "redirect_uri_mismatch" | 1단계 4번 주소가 한 글자도 틀리지 않았는지 |
| 로그인 정보가 없어요 / 401 | 3단계 4번 JWT 확인 끄기 |
| 구글 드라이브 연결이 끊겼어요 | 앱 설정에서 다시 "구글 드라이브 연결" (동의 화면이 테스트 상태면 7일마다 끊김) |
