/** Pairing fragments stay in the browser and are removed before further navigation. */
export function pairingFromUrl(href: string): { token: string; gatewayUrl: string; cleanUrl: string } | undefined {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const value = fragment.get('mathink-pair');
  if (value === null) return;
  const token = value.trim();
  if (!['http:', 'https:'].includes(url.protocol) || !token || token.length > 1024 || /[\r\n]/.test(token)) throw new Error('配对链接无效，请从启动窗口复制完整链接');
  fragment.delete('mathink-pair');
  url.hash = fragment.toString();
  return { token, gatewayUrl: url.origin, cleanUrl: url.href };
}

export function canPairLocally(gateway: string, href: string): boolean {
  try {
    const page = new URL(href), url = new URL(gateway);
    return ['http:', 'https:'].includes(page.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname) && url.origin === page.origin && !url.username && !url.password && url.pathname === '/' && !url.search;
  } catch { return false; }
}

export function recognitionFailureMessage(message: string): string {
  const text = message.trim().replace(/[。.!\s]+$/u, '');
  return `${text}。${text.includes('原稿已保留') ? '' : '原稿已保留。'}`;
}
