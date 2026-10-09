export interface Point { x: number; y: number; pressure: number }
export interface Stroke { id: string; color: string; width: number; points: Point[] }
export interface Bounds { x: number; y: number; width: number; height: number }

export function containsPoint(p: Pick<Point, 'x' | 'y'>, polygon: Pick<Point, 'x' | 'y'>[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function selectedStrokes(strokes: Stroke[], polygon: Pick<Point, 'x' | 'y'>[]): Stroke[] {
  if (polygon.length < 3) return [];
  const intersects = (a: Pick<Point, 'x' | 'y'>, b: Pick<Point, 'x' | 'y'>, c: Pick<Point, 'x' | 'y'>, d: Pick<Point, 'x' | 'y'>) => {
    const cross = (p: Pick<Point, 'x' | 'y'>, q: Pick<Point, 'x' | 'y'>, r: Pick<Point, 'x' | 'y'>) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const onSegment = (p: Pick<Point, 'x' | 'y'>, q: Pick<Point, 'x' | 'y'>, r: Pick<Point, 'x' | 'y'>) => q.x >= Math.min(p.x, r.x) && q.x <= Math.max(p.x, r.x) && q.y >= Math.min(p.y, r.y) && q.y <= Math.max(p.y, r.y);
    const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
    return (ac * ad < 0 && ca * cb < 0) || (ac === 0 && onSegment(a, c, b)) || (ad === 0 && onSegment(a, d, b)) || (ca === 0 && onSegment(c, a, d)) || (cb === 0 && onSegment(c, b, d));
  };
  return strokes.filter(stroke => stroke.points.some(p => containsPoint(p, polygon)) || stroke.points.some((p, index) => index > 0 && polygon.some((a, i) => intersects(stroke.points[index - 1], p, a, polygon[(i + 1) % polygon.length]))));
}

export function boundsOf(strokes: Stroke[], padding = 16): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, radius = padding;
  for (const stroke of strokes) {
    radius = Math.max(radius, stroke.width / 2 + padding);
    for (const p of stroke.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  }
  if (minX === Infinity) return null;
  return { x: minX - radius, y: minY - radius, width: Math.max(1, maxX - minX + 2 * radius), height: Math.max(1, maxY - minY + 2 * radius) };
}

export function distanceToSegment(p: Pick<Point, 'x' | 'y'>, a: Pick<Point, 'x' | 'y'>, b: Pick<Point, 'x' | 'y'>): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function hitStroke(stroke: Stroke, p: Pick<Point, 'x' | 'y'>, radius: number): boolean {
  if (stroke.points.length === 1) return Math.hypot(p.x - stroke.points[0].x, p.y - stroke.points[0].y) <= radius + stroke.width;
  return stroke.points.some((point, index) => index > 0 && distanceToSegment(p, stroke.points[index - 1], point) <= radius + stroke.width / 2);
}

export function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, offsetX = 0, offsetY = 0): void {
  if (!stroke.points.length) return;
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (stroke.points.length === 1) {
    const p = stroke.points[0];
    context.beginPath(); context.arc(p.x + offsetX, p.y + offsetY, stroke.width / 2, 0, 2 * Math.PI); context.fill();
    return;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1], b = stroke.points[i];
    context.lineWidth = stroke.width * (0.35 + 0.9 * ((a.pressure + b.pressure) / 2));
    context.beginPath(); context.moveTo(a.x + offsetX, a.y + offsetY); context.lineTo(b.x + offsetX, b.y + offsetY); context.stroke();
  }
}

export function cropSelection(strokes: Stroke[]): { imageBase64: string; imageUrl: string; bounds: Bounds } {
  const bounds = boundsOf(strokes);
  if (!bounds) throw new Error('请先圈选有笔迹的区域');
  const canvas = document.createElement('canvas');
  const scale = Math.min(2, 2048 / Math.max(bounds.width, bounds.height));
  canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
  canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前设备无法生成识别图片');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  strokes.forEach(s => drawStroke(context, s, -bounds.x, -bounds.y));
  const imageUrl = canvas.toDataURL('image/png');
  return { imageBase64: imageUrl.slice(imageUrl.indexOf(',') + 1), imageUrl, bounds };
}
