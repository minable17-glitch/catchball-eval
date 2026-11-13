-- ============================================================
-- 캐치볼 평가 v3: 평가 회차(수행평가 1, 수행평가 2 …)
--  - 제출·채점 결과에 회차를 남기고, 학생은 선생님이 고른 "지금 받는 회차"로 제출
--  - 드라이브 폴더도 회차별로: 캐치볼 제출 › 수행평가 2 › 반 › 날짜
--  - 같은 팀 다시 제출 막기도 회차별로 따짐
-- catchball.sql, catchball_v2.sql 을 실행한 뒤 SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전함.
-- ============================================================

-- 이미 있는 제출·결과는 수행평가 1 로 봄
alter table catchball_submissions add column if not exists eval_round text not null default '수행평가 1';
alter table catchball_results add column if not exists eval_round text;
update catchball_results r set eval_round = s.eval_round
  from catchball_submissions s where r.submission_id = s.id and r.eval_round is null;

insert into catchball_settings (key, value) values
  ('rounds', E'수행평가 1\n수행평가 2'),
  ('open_round', '수행평가 2')
on conflict (key) do nothing;

create or replace function catchball_public_settings()
returns table(key text, value text)
language sql security definer set search_path = public as $$
  select key, value from catchball_settings
  where key in ('roster', 'guide_text', 'max_seconds', 'allow_resubmit', 'drive_on', 'rounds', 'open_round');
$$;
grant execute on function catchball_public_settings() to anon, authenticated;

create or replace function catchball_set_setting(p_key text, p_value text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if catchball_current_teacher() is null then
    raise exception '선생님 로그인이 필요해요';
  end if;
  if p_key not in ('roster', 'guide_text', 'max_seconds', 'allow_resubmit', 'signup_code', 'rounds', 'open_round') then
    raise exception '바꿀 수 없는 설정이에요: %', p_key;
  end if;
  insert into catchball_settings (key, value) values (p_key, left(coalesce(p_value, ''), 20000))
  on conflict (key) do update set value = excluded.value;
end;
$$;
grant execute on function catchball_set_setting(text, text) to anon, authenticated;

-- 제출: 회차 추가 (이전 모양 함수는 지움)
drop function if exists catchball_submit_v2(date, text, text, text, text, text, text, text, bigint, text, int, jsonb);
drop function if exists catchball_submit_v2(date, text, text, text, text, text, text, text, bigint, text, int, jsonb, text);
create function catchball_submit_v2(
  p_eval_date date, p_class_name text, p_student1 text, p_student2 text,
  p_storage_path text, p_drive_file_id text, p_drive_link text,
  p_file_name text, p_size_bytes bigint, p_mime_type text, p_duration_sec int,
  p_player_marks jsonb, p_eval_round text
)
returns table(id uuid, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_allow text;
  v_round text := coalesce(nullif(left(trim(p_eval_round), 30), ''), '수행평가 1');
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
      and s.eval_round = v_round
      and ((s.student1 = left(trim(p_student1), 20) and s.student2 = left(trim(p_student2), 20))
        or (s.student1 = left(trim(p_student2), 20) and s.student2 = left(trim(p_student1), 20)))
  ) then
    raise exception '이 팀은 % 에 이미 제출했어요. 다시 내려면 선생님께 말씀해 주세요', v_round;
  end if;
  insert into catchball_submissions
    (eval_date, class_name, student1, student2, storage_path, drive_file_id, drive_link, file_name, size_bytes, mime_type, duration_sec, player_marks, eval_round, uploader_uid)
  values
    (coalesce(p_eval_date, (now() at time zone 'Asia/Seoul')::date), left(trim(p_class_name), 30), left(trim(p_student1), 20), left(trim(p_student2), 20),
     p_storage_path, p_drive_file_id, left(p_drive_link, 300), left(p_file_name, 120), p_size_bytes, left(p_mime_type, 60), p_duration_sec, p_player_marks, v_round, auth.uid())
  returning catchball_submissions.id into v_id;
  return query select s.id, s.created_at from catchball_submissions s where s.id = v_id;
end;
$$;
grant execute on function catchball_submit_v2(date, text, text, text, text, text, text, text, bigint, text, int, jsonb, text) to anon, authenticated;

-- 올리기 전 확인: 회차 추가 (회차가 다르면 같은 팀도 낼 수 있음)
drop function if exists catchball_can_submit(date, text, text, text);
drop function if exists catchball_can_submit(date, text, text, text, text);
create function catchball_can_submit(p_eval_date date, p_class_name text, p_student1 text, p_student2 text, p_eval_round text)
returns boolean
language sql security definer set search_path = public as $$
  select not (
    coalesce((select value from catchball_settings where key = 'allow_resubmit'), '1') = '0'
    and exists (
      select 1 from catchball_submissions s
      where s.class_name = left(trim(p_class_name), 30)
        and s.eval_round = coalesce(nullif(left(trim(p_eval_round), 30), ''), '수행평가 1')
        and ((s.student1 = left(trim(p_student1), 20) and s.student2 = left(trim(p_student2), 20))
          or (s.student1 = left(trim(p_student2), 20) and s.student2 = left(trim(p_student1), 20)))
    )
  );
$$;
grant execute on function catchball_can_submit(date, text, text, text, text) to anon, authenticated;

-- 채점 결과 저장: 제출물의 회차를 결과에도 남김 (함수 모양은 그대로)
create or replace function catchball_save_result(
  p_submission_id uuid, p_eval_date date, p_class_name text, p_student1 text, p_student2 text,
  p_success int, p_fail int, p_best_streak int, p_duration_sec int, p_video_name text, p_memo text, p_events jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_teacher uuid := catchball_current_teacher();
  v_id uuid;
begin
  if v_teacher is null then
    raise exception '선생님 로그인이 필요해요';
  end if;
  insert into catchball_results
    (submission_id, teacher_id, eval_date, class_name, student1, student2, success, fail, best_streak, duration_sec, video_name, memo, events, eval_round)
  values
    (p_submission_id, v_teacher, p_eval_date, left(p_class_name, 30), left(p_student1, 20), left(p_student2, 20),
     coalesce(p_success, 0), coalesce(p_fail, 0), coalesce(p_best_streak, 0), p_duration_sec, left(p_video_name, 120), left(p_memo, 300), p_events,
     (select s.eval_round from catchball_submissions s where s.id = p_submission_id))
  returning id into v_id;
  if p_submission_id is not null then
    update catchball_submissions set status = '채점완료' where id = p_submission_id;
  end if;
  return v_id;
end;
$$;
grant execute on function catchball_save_result(uuid, date, text, text, text, int, int, int, int, text, text, jsonb) to anon, authenticated;
