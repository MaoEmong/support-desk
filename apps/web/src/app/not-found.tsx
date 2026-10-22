import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-16 text-center" data-testid="view-404">
      <p className="text-sm font-semibold text-muted-foreground">404</p>
      <h1 className="mt-1 text-xl font-bold">페이지를 찾을 수 없습니다</h1>
      <p className="mt-2 text-sm text-muted-foreground">주소를 다시 확인해 주세요.</p>
      <Link href="/" className="mt-6 inline-block text-info underline">
        처음으로
      </Link>
    </main>
  );
}
