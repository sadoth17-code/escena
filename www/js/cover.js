export function normalizeCover(value) {
  return typeof value === 'string' && value.length <= 350000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
}

export async function prepareCover(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Elige una imagen JPG, PNG o WebP');
  if (file.size > 12 * 1024 * 1024) throw new Error('La portada debe pesar menos de 12 MB');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('No se pudo leer la imagen')); img.src = url; });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('La imagen está vacía');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#12171d';
    ctx.fillRect(0, 0, 480, 480);
    const size = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - size) / 2, (img.naturalHeight - size) / 2, size, size, 0, 0, 480, 480);
    const data = canvas.toDataURL('image/jpeg', 0.82);
    if (!normalizeCover(data)) throw new Error('No se pudo optimizar la portada');
    return data;
  } finally { URL.revokeObjectURL(url); }
}
