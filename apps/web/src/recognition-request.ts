export const RECOGNITION_TIMEOUT_MS = 35000;
export const RECOGNITION_TIMEOUT_MESSAGE = '识别超时，原稿已保留。可以手动重试，不会自动重复调用。';

/** Keep the deadline active until the complete response body has been read. */
export async function requestJson<T>(url: string, init: RequestInit = {}, options: {
  timeoutMs?: number;
  request?: typeof fetch;
} = {}): Promise<{ response: Response; data: T }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (reason: Error) => {
    // Reject even when a WebView or response reader fails to honor AbortSignal.
    rejectAbort(reason);
    controller.abort();
  };
  const cancel = () => abort(new DOMException('已取消识别', 'AbortError'));
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(() => abort(new Error(RECOGNITION_TIMEOUT_MESSAGE)), options.timeoutMs ?? RECOGNITION_TIMEOUT_MS);
  try {
    return await Promise.race([
      aborted,
      (async () => {
        if (controller.signal.aborted) throw new DOMException('已取消识别', 'AbortError');
        let response: Response;
        try { response = await (options.request || fetch)(url, { ...init, signal: controller.signal }); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          throw new Error('无法连接识别服务，请检查服务地址、配对令牌和网络。原稿已保留。');
        }
        try { return { response, data: await response.json() as T }; }
        catch (error) {
          if (controller.signal.aborted) throw error;
          throw new Error(`识别服务返回了无效内容（HTTP ${response.status}），请检查服务地址。原稿已保留。`);
        }
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
  }
}
