// Detecta archivos CAD o modelos 3D de terceros para impedir que lleguen al repositorio.
// Revisa la extensión y también el contenido, porque renombrar un .step a .txt no debe bastar.
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync, constants as zlibConstants } from 'node:zlib';

export const BLOCKED_EXTENSIONS = [
  '.step', '.stp', '.p21', '.iges', '.igs', '.sldprt', '.sldasm', '.slddrw', '.x_t', '.x_b',
  '.sat', '.sab', '.3dxml', '.catpart', '.catproduct', '.jt', '.prt', '.asm', '.ipt', '.iam',
  '.3dm', '.stl', '.obj', '.fbx', '.dae', '.glb', '.gltf', '.3mf', '.dxf', '.dwg', '.rslib',
  '.rspag', '.urdf',
];

// Carpetas de catálogo: además de CAD, bloquean datasheets y planos de fabricante.
const CATALOG_DIRS = ['catalog/', 'catalog_components/'];
const CATALOG_BLOCKED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.zip', '.gz', '.7z'];

const HEAD_BYTES = 64 * 1024;

/** Devuelve el motivo por el que un nombre de archivo está bloqueado, o null. */
export function checkPath(path) {
  const lower = path.toLowerCase().replaceAll('\\', '/');
  const stripped = lower.replace(/\.(gz|zip|7z|xz|bz2)$/, '');
  for (const ext of BLOCKED_EXTENSIONS) {
    if (stripped.endsWith(ext)) return `extensión CAD/3D bloqueada (${ext})`;
  }
  if (CATALOG_DIRS.some((d) => lower.startsWith(d))) {
    const isDoc = lower.endsWith('/readme.md') || lower.includes('/examples/');
    for (const ext of CATALOG_BLOCKED_EXTENSIONS) {
      if (lower.endsWith(ext) && !isDoc) return `archivo de fabricante en carpeta de catálogo (${ext})`;
    }
  }
  return null;
}

/** Devuelve el motivo por el que un contenido parece CAD/3D, o null. */
export function checkContent(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      const inner = gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
      const reason = checkContent(inner.subarray(0, HEAD_BYTES));
      return reason ? `${reason} (comprimido con gzip)` : null;
    } catch {
      return null;
    }
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'glTF') {
    return 'contenido GLB (cabecera glTF)';
  }
  const head = buf.subarray(0, HEAD_BYTES).toString('latin1');
  if (head.includes('ISO-10303-21')) return 'contenido STEP (ISO-10303-21)';
  if (head.includes('**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')) {
    return 'contenido Parasolid';
  }
  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.length >= 80 && /^.{72}S\s*0*1\s*$/.test(firstLine.slice(0, 80))) {
    return 'contenido IGES';
  }
  if (/^solid\s[^\n]*\n\s*facet\s+normal/.test(head)) return 'contenido STL ASCII';
  if (/"asset"\s*:\s*\{[^}]*"version"\s*:\s*"2\.0"/.test(head)) return 'contenido glTF JSON';
  return null;
}

/** Revisa un archivo del disco. Devuelve la lista de motivos (vacía si está limpio). */
export function checkFile(path, readPath = path) {
  const reasons = [];
  const byName = checkPath(path);
  if (byName) reasons.push(byName);
  let size = 0;
  try {
    size = statSync(readPath).size;
  } catch {
    return reasons; // archivo borrado en el índice
  }
  if (size > 0) {
    const buf = readFileSync(readPath);
    const byContent = checkContent(buf.subarray(0, Math.max(HEAD_BYTES, 4)));
    if (byContent) reasons.push(byContent);
  }
  return reasons;
}
