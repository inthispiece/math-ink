import { boundsOf, drawStroke, type Bounds, type Stroke } from './geometry.ts';

export interface FullPageImage {
  imageBase64: string;
  imageUrl: string;
  bounds: Bounds;
  strokeIds: string[];
  page: string;
  revision: string;
  inkRevision?: string;
  contentEmpty?: boolean;
  annotationEmpty?: boolean;
  clipped?: boolean;
  transform: { offsetX: number; offsetY: number; scaleX: number; scaleY: number };
}
const validBounds = (box: Bounds) => box && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(box[k as keyof Bounds])) && box.width > 0 && box.height > 0;

/** Includes all strokes on the logical page, regardless of pan, zoom or viewport size. */
export function renderInkPage(strokes: Stroke[], options: { page?: string; revision?: string } = {}): FullPageImage {
  const bounds = boundsOf(strokes, 24);
  if (!bounds) throw new Error('当前页没有可转写的原稿，可先添加文字内容块。');
  const scale = Math.min(2, 2048 / Math.max(bounds.width, bounds.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
  canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法导出当前完整页，请保留备份并检查浏览器。');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / bounds.width, scaleY = canvas.height / bounds.height;
  context.scale(scaleX, scaleY);
  for (const stroke of strokes) drawStroke(context, stroke, -bounds.x, -bounds.y);
  const imageUrl = canvas.toDataURL('image/png');
  return { imageBase64: imageUrl.slice(imageUrl.indexOf(',') + 1), imageUrl, bounds, strokeIds: strokes.map(s => s.id), page: options.page || 'default', revision: options.revision || '0', transform: { offsetX: bounds.x, offsetY: bounds.y, scaleX, scaleY } };
}

export function parseButterflyPage(value: unknown): FullPageImage {
  const v = value as Partial<FullPageImage> & { pngBase64?: string };
  if (!v || typeof v.pngBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.pngBase64) || v.pngBase64.length > 2_000_000 || !v.bounds || !validBounds(v.bounds) || typeof v.page !== 'string' || !v.page || typeof v.revision !== 'string' || !v.revision || !Array.isArray(v.strokeIds) || !v.strokeIds.every(id => typeof id === 'string') || !v.transform || ![v.transform.offsetX, v.transform.offsetY, v.transform.scaleX, v.transform.scaleY].every(Number.isFinite) || v.transform.scaleX <= 0 || v.transform.scaleY <= 0) throw new Error('Butterfly 未返回可定位的完整页，请重新打开原稿。');
  return { imageBase64: v.pngBase64, imageUrl: 'data:image/png;base64,' + v.pngBase64, bounds: v.bounds, strokeIds: v.strokeIds, page: v.page, revision: v.revision, ...(typeof v.inkRevision === 'string' ? { inkRevision: v.inkRevision } : {}), transform: v.transform };
}

/** Normalized boxes always refer to the full exported page, never the current screen. */
export function normalizedSourceBounds(page: Pick<FullPageImage, 'bounds'>, box: Bounds): Bounds {
  if (!validBounds(page.bounds) || !validBounds(box) || box.x < 0 || box.y < 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) throw new Error('草稿块的原稿坐标无效。');
  return { x: page.bounds.x + box.x * page.bounds.width, y: page.bounds.y + box.y * page.bounds.height, width: box.width * page.bounds.width, height: box.height * page.bounds.height };
}
