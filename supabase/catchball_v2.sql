-- ============================================================
-- 캐치볼 평가 v2: 구글 드라이브 저장 + 제출 설정(명렬표·촬영 안내·촬영 시간) + 학생 위치 표시
-- supabase/catchball.sql 을 이미 실행한 프로젝트에서 이 파일을 SQL Editor 에 붙여넣고 Run.
-- 여러 번 실행해도 안전함.
-- 드라이브 열쇠(drive_refresh_token 등)는 엣지 함수(supabase/functions/catchball-drive)만 service role 로 읽고 씀.
-- ============================================================

-- 제출 표: 드라이브 파일 정보와 학생이 촬영 전에 찍은 두 사람 위치
alter table catchball_submissions add column if not exists drive_file_id text;
alter table catchball_submissions add column if not exists drive_link text;
alter table catchball_submissions add column if not exists player_marks jsonb;

-- 기본 설정값 (없을 때만 넣음)
insert into catchball_settings (key, value) values
  ('roster', ''),
  ('guide_text', ''),
  ('max_seconds', '60'),
  ('allow_resubmit', '1'),
  ('drive_on', '0')
on conflict (key) do nothing;
-- 이전 버전(앱스크립트 방식)에서 쓰던 값 정리
delete from catchball_settings where key in ('script_url', 'drive_key');

-- 학생 화면용 공개 설정 (가입 코드·선생님 키는 제외)
create or replace function catchball_public_settings()
returns table(key text, value text)
language sql security definer set search_path = public as $$
  select key, value from catchball_settings
  where key in ('roster', 'guide_text', 'max_seconds', 'allow_resubmit', 'drive_on');
$$;
grant execute on function catchball_public_settings() to anon, authenticated;

-- 선생님용 설정 (드라이브 열쇠는 빼고)
create or replace function catchball_get_settings()
returns table(key text, value text)
language sql security definer set search_path = public as $$
  select key, value from catchball_settings
  where catchball_current_teacher() is not null
    and key not in ('drive_refresh_token', 'drive_oauth_state');
$$;
grant execute on function catchball_get_settings() to anon, authenticated;

-- 선생님: 설정 바꾸기
create or replace function catchball_set_setting(p_key text, p_value text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if catchball_current_teacher() is null then
    raise exception '선생님 로그인이 필요해요';
  end if;
  if p_key not in ('roster', 'guide_text', 'max_seconds', 'allow_resubmit', 'signup_code') then
    raise exception '바꿀 수 없는 설정이에요: %', p_key;
  end if;
  insert into catchball_settings (key, value) values (p_key, left(coalesce(p_value, ''), 20000))
  on conflict (key) do update set value = excluded.value;
end;
$$;
grant execute on function catchball_set_setting(text, text) to anon, authenticated;

-- 학생 제출 v2: 영상이 수파베이스 storage 에 있든(uid/...) 드라이브에 있든(drive:파일ID) 기록
create or replace function catchball_submit_v2(
  p_eval_date date, p_class_name text, p_student1 text, p_student2 text,
  p_storage_path text, p_drive_file_id text, p_drive_link text,
  p_file_name text, p_size_bytes bigint, p_mime_type text, p_duration_sec int,
  p_player_marks jsonb default null
)
returns table(id uuid, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_allow text;
begin
  if auth.uid() is null then
    raise exception '세션이 없어요. 페이지를 새로고침해 주세요';
  end if;
  if p_storage_path is null then
    raise exception '영상 경로가 없어요';
  end if;
  if position('drive:' in p_storage_path) = 1 then
    if coalesce(p_drive_file_id, '') = '' or p_storage_path <> 'drive:' || p_drive_file_id then
      raise exception '드라이브 파일 정보가 올바르지 않아요';
    end if;
  elsif position(auth.uid()::text || '/' in p_storage_path) <> 1 then
    raise exception '영상 경로가 올바르지 않아요';
  end if;
  if coalesce(trim(p_class_name), '') = '' or coalesce(trim(p_student1), '') = '' or coalesce(trim(p_student2), '') = '' then
    raise exception '반과 학생 이름을 모두 골라 주세요';
  end if;
  select value into v_allow from catchball_settings where key = 'allow_resubmit';
  if coalesce(v_allow, '1') = '0' and exists (
    select 1 from catchball_submissions s
    where s.class_name = left(trim(p_class_name), 30)
      and s.eval_date = coalesce(p_eval_date, (now() at time zone 'Asia/Seoul')::date)
      and ((s.student1 = left(trim(p_student1), 20) and s.student2 = left(trim(p_student2), 20))
        or (s.student1 = left(trim(p_student2), 20) and s.student2 = left(trim(p_student1), 20)))
  ) then
    raise exception '이 팀은 오늘 이미 제출했어요. 다시 내려면 선생님께 말씀해 주세요';
  end if;
  insert into catchball_submissions
    (eval_date, class_name, student1, student2, storage_path, drive_file_id, drive_link, file_name, size_bytes, mime_type, duration_sec, player_marks, uploader_uid)
  values
    (coalesce(p_eval_date, (now() at time zone 'Asia/Seoul')::date), left(trim(p_class_name), 30), left(trim(p_student1), 20), left(trim(p_student2), 20),
     p_storage_path, p_drive_file_id, left(p_drive_link, 300), left(p_file_name, 120), p_size_bytes, left(p_mime_type, 60), p_duration_sec, p_player_marks, auth.uid())
  returning catchball_submissions.id into v_id;
  return query select s.id, s.created_at from catchball_submissions s where s.id = v_id;
end;
$$;
grant execute on function catchball_submit_v2(date, text, text, text, text, text, text, text, bigint, text, int, jsonb) to anon, authenticated;

-- 제출 삭제: 경로를 돌려줌 (드라이브 영상이면 선생님 화면이 드라이브 휴지통으로 보냄)
create or replace function catchball_delete_submission(p_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_path text;
begin
  if catchball_current_teacher() is null then
    raise exception '선생님 로그인이 필요해요';
  end if;
  delete from catchball_submissions where id = p_id returning storage_path into v_path;
  return v_path;
end;
$$;

-- 학생 화면: 올리기 전에 미리 확인 (다시 제출이 막혀 있으면 영상을 올리기 전에 알려 줌)
create or replace function catchball_can_submit(p_eval_date date, p_class_name text, p_student1 text, p_student2 text)
returns boolean
language sql security definer set search_path = public as $$
  select not (
    coalesce((select value from catchball_settings where key = 'allow_resubmit'), '1') = '0'
    and exists (
      select 1 from catchball_submissions s
      where s.class_name = left(trim(p_class_name), 30)
        and s.eval_date = coalesce(p_eval_date, (now() at time zone 'Asia/Seoul')::date)
        and ((s.student1 = left(trim(p_student1), 20) and s.student2 = left(trim(p_student2), 20))
          or (s.student1 = left(trim(p_student2), 20) and s.student2 = left(trim(p_student1), 20)))
    )
  );
$$;
grant execute on function catchball_can_submit(date, text, text, text) to anon, authenticated;
