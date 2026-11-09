import { createClient } from '@supabase/supabase-js';

// 이 도구 전용 수파베이스 프로젝트. 다른 앱과 어떤 것도 공유하지 않음.
// (storageKey 를 따로 두어 같은 브라우저의 다른 수파베이스 앱과 세션이 섞이지 않게 함)
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storageKey: 'sb-catchball-auth', persistSession: true, autoRefreshToken: true },
});

export const VIDEO_BUCKET = 'catchball-videos';
