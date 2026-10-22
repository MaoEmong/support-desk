import { getApp } from '../../../server/runtime';

// 모든 /api/* 요청을 서버 앱 하나로 위임(가드·정책·오류 규약 단일 경로).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = (req: Request) => getApp().handle(req);

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
