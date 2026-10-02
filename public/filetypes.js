// Which files ShareSecure accepts, worked out from their bytes, never their
// name or what the browser claims. Shared by the server (uploads) and the
// browser (end-to-end encrypted files, which only the browser can look inside).

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv'];
export const TYPES_ERROR = 'Only PDF, DOCX, PNG, JPG and text (.txt, .md, .csv) files can be shared.';
export const ENCODING_ERROR = "This text file isn't saved as UTF-8. Save it as UTF-8 (in Excel: CSV UTF-8) and try again.";
export const NOT_UTF8 = 'not-utf8';

const EXT_FOR = {
  'application/pdf': '.pdf', [DOCX]: '.docx', 'image/png': '.png', 'image/jpeg': '.jpg',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
};
export const isAllowedType = type => Object.hasOwn(EXT_FOR, type);

// names that promise a file that's never text, so text under them is a mistake
const BINARY_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'zip']);

// The name people see always ends in the extension of what the file really is,
// so a text share can't be saved as .html, .bat or .hta.
export function nameFor(requested, fallback, type) {
  let name = String(requested || '').trim() || String(fallback || '').trim();
  name = name.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '').trim();
  // drop an extension the uploader gave ("v1.2" isn't one), then add the real one
  name = name.replace(/\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,10}$/i, '').trim().slice(0, 190);
  return (name || 'file') + EXT_FOR[type];
}

// A DOCX is a ZIP with word/document.xml in it. The file list sits at the end
// of a ZIP, so look there first.
function isDocx(bytes) {
  const latin1 = b => new TextDecoder('windows-1252').decode(b);
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024 * 1024));
  if (latin1(tail).includes('word/document.xml')) return true;
  return tail.length < bytes.length && latin1(bytes).includes('word/document.xml');
}

// Text has to really be text: UTF-8, with no control characters except tab,
// newlines and form feed. The name only says which kind of text it is.
function textType(bytes, name, declared) {
  const ext = (/\.([a-z]+)$/i.exec(name || '') || [])[1]?.toLowerCase();
  if (BINARY_EXT.has(ext)) return null;
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
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return isDocx(b) ? DOCX : null;
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
