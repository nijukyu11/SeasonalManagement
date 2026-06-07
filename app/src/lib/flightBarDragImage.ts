interface SolidFlightBarDragImageEvent {
  currentTarget: HTMLElement;
  clientX: number;
  clientY: number;
  dataTransfer: DataTransfer;
}

interface SolidFlightBarDragImageOptions {
  label: string;
  backgroundColor: string;
  textColor: string;
  width?: number;
  height?: number;
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const resolvedRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + resolvedRadius, y);
  ctx.lineTo(x + width - resolvedRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + resolvedRadius);
  ctx.lineTo(x + width, y + height - resolvedRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - resolvedRadius, y + height);
  ctx.lineTo(x + resolvedRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - resolvedRadius);
  ctx.lineTo(x, y + resolvedRadius);
  ctx.quadraticCurveTo(x, y, x + resolvedRadius, y);
  ctx.closePath();
}

export function setSolidFlightBarDragImage(
  event: SolidFlightBarDragImageEvent,
  { label, backgroundColor, textColor, width, height }: SolidFlightBarDragImageOptions
): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const rect = event.currentTarget.getBoundingClientRect();
  const dragWidth = Math.max(30, Math.round(width ?? rect.width));
  const dragHeight = Math.max(24, Math.round(height ?? rect.height));
  const offsetX = Math.max(0, Math.min(dragWidth, Math.round(event.clientX - rect.left) || Math.round(dragWidth / 2)));
  const offsetY = Math.max(0, Math.min(dragHeight, Math.round(event.clientY - rect.top) || Math.round(dragHeight / 2)));
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(dragWidth * scale);
  canvas.height = Math.ceil(dragHeight * scale);
  canvas.style.position = 'fixed';
  canvas.style.left = '-10000px';
  canvas.style.top = '-10000px';
  canvas.style.width = `${dragWidth}px`;
  canvas.style.height = `${dragHeight}px`;
  canvas.style.opacity = '1';
  canvas.style.pointerEvents = 'none';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  document.body.appendChild(canvas);
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, dragWidth, dragHeight);

  const radius = 4;
  ctx.fillStyle = backgroundColor;
  drawRoundedRect(ctx, 0.5, 0.5, dragWidth - 1, dragHeight - 1, radius);
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.font = '700 11px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, dragWidth / 2, dragHeight / 2, Math.max(12, dragWidth - 12));

  event.dataTransfer.setDragImage(canvas, offsetX, offsetY);
  window.setTimeout(() => {
    canvas.remove();
  }, 0);
}
