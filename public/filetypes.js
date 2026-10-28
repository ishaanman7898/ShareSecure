// Which files ShareSecure accepts, worked out from their bytes, never their
// name or what the browser claims. Shared by the browser, the website's API,
// the self-hosted server and the local MCP server.
import { listEntries } from './zip.js';

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const ZIP = 'application/zip';
export const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv'];
export const TYPES_ERROR = 'That kind of file can’t be shared. ShareSecure takes documents (PDF, Word, Excel, PowerPoint, OpenDocument), images, video, audio, ZIP and other archives, and text (.txt, .md, .csv).';
export const ENCODING_ERROR = "This text file isn't saved as UTF-8. Save it as UTF-8 (in Excel: CSV UTF-8) and try again.";
export const NOT_UTF8 = 'not-utf8';

const EXT_FOR = {
  'application/pdf': '.pdf', [DOCX]: '.docx', [XLSX]: '.xlsx', [PPTX]: '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav',
  [ZIP]: '.zip', 'application/x-7z-compressed': '.7z', 'application/gzip': '.gz',
  'application/vnd.rar': '.rar', 'application/x-tar': '.tar',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
};
export const isAllowedType = type => Object.hasOwn(EXT_FOR, type);
export const extFor = type => EXT_FOR[type];

// What the viewer can show. Everything else is offered to save instead, so a
// share of one of those always lets people save it.
const VIEWABLE = new Set([
  'application/pdf', DOCX, 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav',
  ZIP, ...TEXT_TYPES,
]);
export const canView = type => VIEWABLE.has(type);
export const isMedia = type => /^(video|audio)\//.test(type || '');

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const starts = (b, bytes, at = 0) => bytes.every((x, i) => b[at + i] === x);

// ISO media (MP4, MOV, M4A) start with an "ftyp" box naming a brand
function isoType(b) {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return null;
  const brand = ascii(b, 8, 12);
  if (brand === 'qt  ') return { type: 'video/quicktime', ext: 'mov' };
  if (/^M4[AB] /.test(brand)) return { type: 'audio/mp4', ext: 'm4a' };
  // HEIC/AVIF pictures share the box but aren't video
  if (/^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/.test(brand)) return null;
  return { type: 'video/mp4', ext: 'mp4' };
}

// A ZIP is a Word, Excel or PowerPoint file, an OpenDocument, or just a ZIP,
// depending on what's inside.
function zipType(b) {
  const entries = listEntries(b);
  if (!entries) return null;
  const names = new Set(entries.map(e => e.name));
  if (names.has('word/document.xml')) return { type: DOCX, ext: 'docx' };
  if (names.has('xl/workbook.xml')) return { type: XLSX, ext: 'xlsx' };
  if (names.has('ppt/presentation.xml')) return { type: PPTX, ext: 'pptx' };
  // OpenDocument files start with an uncompressed "mimetype" entry
  if (entries[0]?.name === 'mimetype' && entries[0].method === 0) {
    const kind = /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)$/.exec(ascii(b, 38, 38 + Math.min(entries[0].size, 80)));
    if (kind) return { type: `application/vnd.oasis.opendocument.${kind[1]}`, ext: { text: 'odt', spreadsheet: 'ods', presentation: 'odp' }[kind[1]] };
  }
  return { type: ZIP, ext: 'zip' };
}

// The type of a binary file from its first bytes → { type, ext } or undefined
export function magicOf(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (starts(b, [0x25, 0x50, 0x44, 0x46])) return { type: 'application/pdf', ext: 'pdf' };
  if (starts(b, [0x89, 0x50, 0x4E, 0x47])) return { type: 'image/png', ext: 'png' };
  if (starts(b, [0xFF, 0xD8, 0xFF])) return { type: 'image/jpeg', ext: 'jpg' };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { type: 'image/gif', ext: 'gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { type: 'audio/wav', ext: 'wav' };
  if (starts(b, [0x1A, 0x45, 0xDF, 0xA3]) && ascii(b, 0, 64).includes('webm')) return { type: 'video/webm', ext: 'webm' };
  if (ascii(b, 0, 3) === 'ID3') return { type: 'audio/mpeg', ext: 'mp3' };
  const iso = isoType(b);
  if (iso) return iso;
  if (starts(b, [0x50, 0x4B, 0x03, 0x04]) || starts(b, [0x50, 0x4B, 0x05, 0x06])) return zipType(b) || undefined;
  if (starts(b, [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return { type: 'application/x-7z-compressed', ext: '7z' };
  if (starts(b, [0x1F, 0x8B])) return { type: 'application/gzip', ext: 'gz' };
  if (ascii(b, 0, 6) === 'Rar!\x1A\x07') return { type: 'application/vnd.rar', ext: 'rar' };
  if (b.length > 262 && ascii(b, 257, 262) === 'ustar') return { type: 'application/x-tar', ext: 'tar' };
}

// names that promise a file that's never text, so text under them is a mistake
export const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|png|jpe?g|gif|webp|heic|mp4|mov|webm|mp3|m4a|wav|zip|7z|gz|tgz|rar|tar)$/i;

// The name people see always ends in the extension of what the file really is,
// so a text share can't be saved as .html, .bat or .hta, and an archive can't
// pass for a document.
export function nameFor(requested, fallback, type) {
  let name = String(requested || '').trim() || String(fallback || '').trim();
  name = name.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '').trim();
  // drop an extension the uploader gave ("v1.2" isn't one), then add the real one
  name = name.replace(/\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,10}$/i, '').trim();
  return (name.slice(0, 190) || 'file') + EXT_FOR[type];
}

// Text has to really be text: UTF-8, with no control characters except tab,
// newlines and form feed. The name only says which kind of text it is.
function textType(bytes, name, declared) {
  if (BINARY_EXT.test(name || '')) return null;
  const ext = (/\.([a-z]+)$/i.exec(name || '') || [])[1]?.toLowerCase();
  let type = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv' }[ext];
  if (!type && /^text\//i.test(declared || '')) {
    type = /^text\/markdown/i.test(declared) ? 'text/markdown' : /^text\/csv/i.test(declared) ? 'text/csv' : 'text/plain';
  }
  if (!type || !bytes.length) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return NOT_UTF8; }
  if (text.includes('\x00')) return NOT_UTF8;   // UTF-16 is full of zero bytes
  return /[\x01-\x08\x0B\x0E-\x1F\x7F]/.test(text) ? null : type;
}

// The file's type, NOT_UTF8 for text in another encoding, or null if refused.
export function detectType(bytes, name, declared) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const magic = magicOf(b);
  if (magic) return magic.type;
  // a PK header that isn't a readable ZIP is refused, not taken as text
  if (starts(b, [0x50, 0x4B])) return null;
  return textType(b, name, declared);
}

// Does a file's content match the type it says it is? Used on decrypted files,
// whose type the server never got to check.
export function contentMatches(bytes, type) {
  if (TEXT_TYPES.includes(type)) {
    const found = detectType(bytes, '', 'text/plain');
    return found !== null && found !== NOT_UTF8;
  }
  return detectType(bytes, '', '') === type;
}

// What a type is called in the app ("Excel spreadsheet", "ZIP archive")
export function kindName(type) {
  if (type === ZIP) return 'ZIP archive';
  if (type === XLSX) return 'Excel spreadsheet';
  if (type === PPTX) return 'PowerPoint presentation';
  if (type === DOCX) return 'Word document';
  if (/opendocument\.text/.test(type)) return 'OpenDocument text';
  if (/opendocument\.spreadsheet/.test(type)) return 'OpenDocument spreadsheet';
  if (/opendocument\.presentation/.test(type)) return 'OpenDocument presentation';
  if (/x-7z|gzip|rar|x-tar/.test(type)) return 'Archive';
  if (type === 'application/pdf') return 'PDF';
  if (/^image\//.test(type)) return 'Image';
  if (/^video\//.test(type)) return 'Video';
  if (/^audio\//.test(type)) return 'Audio';
  if (TEXT_TYPES.includes(type)) return 'Text';
  return 'File';
}

// What the file picker offers
export const ACCEPT = Object.values(EXT_FOR).filter((e, i, all) => all.indexOf(e) === i).join(',') + ',.jpeg,.markdown,.tgz';
