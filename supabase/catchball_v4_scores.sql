-- ============================================================
-- 캐치볼 평가 v4: 선생님 직접 채점 (학생별·회차별 성공 개수)
--  - 영상을 보면서 학생마다 성공 개수를 체크. 만점 기준은 회차·성별로 설정 (예: 수행평가 1 남 10 / 여 5)
--  - 점수는 학생 한 명당 회차 하나에 하나만 남음 (다시 채점하면 덮어씀)
-- catchball.sql, v2, v3 를 실행한 뒤 SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전함.
-- ============================================================

create table if not exists catchball_scores (
  id uuid primary key default gen_random_uuid(),
  class_name text not null,
  student text not null,
  eval_round text not null,
  gender text,
  count int not null default 0,
  max_count int not null,
  memo text,
  submission_id uuid references catchball_submissions(id) on delete set null,
  teacher_id uuid,
  updated_at timestamptz not null default now(),
  unique (class_name, student, eval_round)
);
alter table catchball_scores enable row level security;

insert into catchball_settings (key, value) values
  ('score_rules', '{"수행평가 1":{"남":10,"여":5},"수행평가 2":{"남":8,"여":5}}')
on conflict (key) do nothing;

-- 설정 바꾸기: 만점 기준(score_rules) 추가
create or replace function catchball_set_setting(p_key text, p_value text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if catchball_current_teacher() is null then
    raise exception '선생님 로그인이 필요해요';
  end if;
  if p_key not in ('roster', 'guide_text', 'max_seconds', 'allow_resubmit', 'signup_code', 'rounds', 'open_round', 'score_rules') then
    raise exception '바꿀 수 없는 설정이에요: %', p_key;
  end if;
  insert into catchball_settings (key, value) values (p_key, left(coalesce(p_value, ''), 20000))
  on conflict (key) do update set value = excluded.value;
end;
$$;
grant execute on function catchball_set_setting(text, text) to anon, authenticated;

-- 점수 저장: p_scores = [{class_name, student, round, gender, count, max, memo}, ...] (한 영상의 두 학생을 한 번에)
create or replace function catchball_save_scores(p_submission_id uuid, p_scores jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_teacher uuid := catchball_current_teacher();
  v_item jsonb;
  v_n int := 0;
  v_max int;
  v_count int;
begin
  if v_teacher is null then
    raise exception '선생님 로그인이 필요해요';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) loop
    if coalesce(trim(v_item->>'student'), '') = '' or coalesce(trim(v_item->>'round'), '') = '' then
      continue;
    end if;
    v_max := greatest(1, least(100, coalesce((v_item->>'max')::int, 1)));
    v_count := greatest(0, least(v_max, coalesce((v_item->>'count')::int, 0)));
    insert into catchball_scores (class_name, student, eval_round, gender, count, max_count, memo, submission_id, teacher_id, updated_at)
    values (left(trim(coalesce(v_item->>'class_name', '')), 30), left(trim(v_item->>'student'), 20), left(trim(v_item->>'round'), 30),
            nullif(left(trim(coalesce(v_item->>'gender', '')), 2), ''), v_count, v_max, nullif(left(coalesce(v_item->>'memo', ''), 200), ''),
            p_submission_id, v_teacher, now())
    on conflict (class_name, student, eval_round) do update
      set gender = excluded.gender, count = excluded.count, max_count = excluded.max_count, memo = excluded.memo,
          submission_id = excluded.submission_id, teacher_id = excluded.teacher_id, updated_at = now();
    v_n := v_n + 1;
  end loop;
  if p_submission_id is not null and v_n > 0 then
    update catchball_submissions set status = '채점완료' where id = p_submission_id;
  end if;
  return v_n;
end;
$$;
grant execute on function catchball_save_scores(uuid, jsonb) to anon, authenticated;

create or replace function catchball_list_scores()
returns setof catchball_scores
language sql security definer set search_path = public as $$
  select * from catchball_scores
  where catchball_current_teacher() is not null
  order by class_name, student, eval_round
  limit 5000;
$$;
grant execute on function catchball_list_scores() to anon, authenticated;

create or replace function catchball_delete_score(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if catchball_current_teacher() is null then
    raise exception '선생님 로그인이 필요해요';
  end if;
  delete from catchball_scores where id = p_id;
end;
$$;
grant execute on function catchball_delete_score(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
