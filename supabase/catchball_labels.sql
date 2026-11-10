-- 캐치볼: 공 위치 표시(학습 자료) — 기존 catchball.sql 을 이미 실행한 프로젝트에서 이 파일만 추가로 실행
--
-- catchball_labels : 제출 영상의 특정 시각(t초)에 공이 어디 있는지 (0~1 좌표). present=false 는 "이 장면엔 공이 안 보임"
-- 선생님만 쓰고 읽을 수 있음. 코랩 학습 스크립트가 catchball_export_labels 로 전부 내려받음.

create table if not exists catchball_labels (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references catchball_submissions(id) on delete cascade,
  t numeric(8,3) not null,
  present boolean not null default true,
  x real,
  y real,
  r real,
  teacher_id uuid references catchball_teachers(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (submission_id, t)
);
alter table catchball_labels enable row level security;

-- 한 영상의 표시들을 한꺼번에 저장 (같은 시각은 덮어씀). p_labels: [{t, present, x, y, r}]
create or replace function catchball_save_labels(p_submission_id uuid, p_labels jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_teacher uuid := catchball_current_teacher();
  v_n int := 0;
  rec jsonb;
begin
  if v_teacher is null then raise exception '선생님 로그인이 필요해요'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_labels, '[]'::jsonb)) loop
    insert into catchball_labels (submission_id, t, present, x, y, r, teacher_id)
    values (p_submission_id, round((rec->>'t')::numeric, 3), coalesce((rec->>'present')::boolean, true),
            (rec->>'x')::real, (rec->>'y')::real, (rec->>'r')::real, v_teacher)
    on conflict (submission_id, t) do update
      set present = excluded.present, x = excluded.x, y = excluded.y, r = excluded.r, teacher_id = excluded.teacher_id, created_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
grant execute on function catchball_save_labels(uuid, jsonb) to anon, authenticated;

create or replace function catchball_list_labels(p_submission_id uuid)
returns setof catchball_labels
language sql security definer set search_path = public as $$
  select * from catchball_labels
  where submission_id = p_submission_id and catchball_current_teacher() is not null
  order by t;
$$;
grant execute on function catchball_list_labels(uuid) to anon, authenticated;

-- 영상별 표시 개수 (목록에 "표시 12장면" 으로 보여주기용)
create or replace function catchball_label_counts()
returns table(submission_id uuid, n int, n_present int)
language sql security definer set search_path = public as $$
  select l.submission_id, count(*)::int, count(*) filter (where l.present)::int
  from catchball_labels l
  where catchball_current_teacher() is not null
  group by l.submission_id;
$$;
grant execute on function catchball_label_counts() to anon, authenticated;

-- 학습용 전체 내보내기 (영상 경로 + 표시). 코랩이 선생님 로그인 뒤 호출
create or replace function catchball_export_labels()
returns table(submission_id uuid, storage_path text, file_name text, t numeric, present boolean, x real, y real, r real)
language sql security definer set search_path = public as $$
  select s.id, s.storage_path, s.file_name, l.t, l.present, l.x, l.y, l.r
  from catchball_labels l join catchball_submissions s on s.id = l.submission_id
  where catchball_current_teacher() is not null
  order by s.created_at, l.t;
$$;
grant execute on function catchball_export_labels() to anon, authenticated;

create or replace function catchball_delete_labels(p_submission_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if catchball_current_teacher() is null then raise exception '선생님 로그인이 필요해요'; end if;
  delete from catchball_labels where submission_id = p_submission_id;
end;
$$;
grant execute on function catchball_delete_labels(uuid) to anon, authenticated;
