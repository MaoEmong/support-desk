/**
 * POST 응답 본문(text/event-stream) 파서. EventSource는 POST를 못 하므로 ReadableStream을 직접 읽는다.
 * 프레임 형식: `event: <name>\ndata: <JSON>\n\n` (여러 data 줄은 \n으로 이어 붙임, `:` 주석 줄 무시)
 */
export interface RawSSEFrame {
  event: string;
  data: string;
}

function parseFrame(block: string): RawSSEFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

export async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawSSEFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let cr = ''; // 청크 끝의 \r은 다음 청크의 \n과 짝일 수 있어 보류
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let text = cr + decoder.decode(value, { stream: true });
      cr = text.endsWith('\r') ? '\r' : '';
      if (cr) text = text.slice(0, -1);
      buf += text.replace(/\r\n?/g, '\n');
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = parseFrame(buf.slice(0, cut));
        buf = buf.slice(cut + 2);
        if (frame) yield frame;
      }
    }
    buf += (cr + decoder.decode()).replace(/\r\n?/g, '\n');
    const last = buf.trim() ? parseFrame(buf) : null;
    if (last) yield last;
  } finally {
    // 중단·조기 종료 시 서버 스트림도 끊는다(서버 cancel → 응답기 abort)
    reader.cancel().catch(() => {});
  }
}
