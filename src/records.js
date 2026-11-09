// 채점 기록 저장(이 기기의 브라우저 저장소) + 엑셀 내려받기
import * as XLSX from 'xlsx';

const KEY = 'catchball_records_v1';

export function loadRecords() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveRecords(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function addRecord(record) {
  const list = loadRecords();
  const withId = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString(), ...record };
  list.unshift(withId);
  saveRecords(list);
  return withId;
}

export function deleteRecord(id) {
  const list = loadRecords().filter((r) => r.id !== id);
  saveRecords(list);
  return list;
}

export function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

export function exportRecordsToExcel(records) {
  const rows = records.map((r) => ({
    평가일: r.date,
    반: r.className,
    학생1: r.student1,
    학생2: r.student2,
    성공횟수: r.success,
    실패횟수: r.fail,
    최대연속성공: r.bestStreak,
    영상길이_초: r.duration,
    영상파일: r.videoName,
    비고: r.memo || '',
  }));
  const detail = [];
  for (const r of records) {
    for (const e of r.events || []) {
      detail.push({
        평가일: r.date,
        반: r.className,
        학생1: r.student1,
        학생2: r.student2,
        시각_초: e.t,
        결과: e.type === 'catch' ? '성공' : '실패',
        자동판정: e.auto ? '자동' : '직접 입력',
        신뢰도: e.confidence != null ? Math.round(e.confidence * 100) + '%' : '',
      });
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '평가기록');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), '캐치시점');
  XLSX.writeFile(wb, `캐치볼_평가기록_${todayKST()}.xlsx`);
}
