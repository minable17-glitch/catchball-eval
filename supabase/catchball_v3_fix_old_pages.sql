-- ============================================================
-- 캐치볼 v3 보완: 새로고침 안 한 예전 화면(회차 기능 전 버전)에서도 제출이 되게
--  v3 에서 예전 모양의 제출 함수를 지웠더니, 열어 둔 채 새로고침하지 않은 폰에서
--  "Could not find the function catchball_submit_v2(...)" 오류가 났음. 예전 모양을 다시 받아 줌.
--  예전 화면은 회차를 보내지 않으므로: 설정의 회차가 하나뿐이면 그 회차, 아니면 수행평가 1 로 기록.
-- SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전함.
-- ============================================================

create or replace function catchball_submit_v2(
  p_eval_date date, p_class_name text, p_student1 text, p_student2 text,
  p_storage_path text, p_drive_file_id text, p_drive_link text,
  p_file_name text, p_size_bytes bigint, p_mime_type text, p_duration_sec int,
  p_player_marks jsonb default null
)
returns table(id uuid, created_at timestamptz)
language sql security definer set search_path = public as $$
  select * from catchball_submit_v2(
    p_eval_date, p_class_name, p_student1, p_student2,
    p_storage_path, p_drive_file_id, p_drive_link,
    p_file_name, p_size_bytes, p_mime_type, p_duration_sec, p_player_marks,
    (select case when position(E'\n' in trim(s.value)) = 0 then nullif(trim(s.value), '') end
       from catchball_settings s where s.key = 'rounds')
  );
$$;
grant execute on function catchball_submit_v2(date, text, text, text, text, text, text, text, bigint, text, int, jsonb) to anon, authenticated;

create or replace function catchball_can_submit(p_eval_date date, p_class_name text, p_student1 text, p_student2 text)
returns boolean
language sql security definer set search_path = public as $$
  select catchball_can_submit(p_eval_date, p_class_name, p_student1, p_student2,
    (select case when position(E'\n' in trim(s.value)) = 0 then nullif(trim(s.value), '') end
       from catchball_settings s where s.key = 'rounds'));
$$;
grant execute on function catchball_can_submit(date, text, text, text) to anon, authenticated;

-- API 가 새 함수를 바로 알아보게
notify pgrst, 'reload schema';
