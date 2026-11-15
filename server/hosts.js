'use strict';
// Which names this server answers to (the request's Host).
//
// A web page can point a domain of its own at this server's address (DNS
// rebinding: 127.0.0.1, or 192.168.x.x on your network) and then read the
// answers as if they were its own site's: this computer's relay id from
// /api/mode, say, which would tie a visitor to every link they've shared. The
// browser always sends the name it looked up, though, and that page's name
// isn't one of this server's. So the server answers only to:
//   - this computer (localhost), and what comes in through the relay
//   - an address typed as numbers (192.168.1.20, [fe80::1]): no name to rebind
//   - a name only your own network has: one word (nas), or .local, .lan, …
//   - BASE_URL's name, and any in ALLOWED_HOSTS (comma-separated; a leading
//     dot also allows every name under it)
// The desktop app's server (loopback only) answers to this computer alone.

const OWN = new Set(['localhost', '127.0.0.1', '[::1]', 'relay.sharesecure']);
// endings nobody can register: they only ever mean a name on your own network
const LOCAL_ENDINGS = ['.localhost', '.local', '.localdomain', '.internal', '.home.arpa', '.home', '.lan', '.corp'];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:.]+(%25[0-9a-z._~-]+)?\]$/;

// "Example.com:3000" → "example.com", "[::1]:3000" → "[::1]"
function nameOf(host) {
  const value = String(host || '').trim().toLowerCase();
  const name = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.replace(/:\d*$/, '');
  return name.replace(/\.$/, '');
}

function namesFrom(baseUrl, allowedHosts) {
  const names = [];
  try { if (baseUrl) names.push(new URL(baseUrl).hostname.toLowerCase()); } catch {}
  for (const name of String(allowedHosts || '').split(',')) {
    const clean = name.trim().toLowerCase().replace(/\.$/, '');
    if (clean) names.push(clean);
  }
  return names;
}

// → a function that says whether a Host header is one of this server's names
function hostChecker({ loopbackOnly = false, baseUrl = '', allowedHosts = '' } = {}) {
  if (loopbackOnly) return host => OWN.has(nameOf(host));
  const extra = namesFrom(baseUrl, allowedHosts);
  return host => {
    const name = nameOf(host);
    if (!name) return false;
    if (OWN.has(name) || IPV4.test(name) || IPV6.test(name)) return true;
    if (!name.includes('.') || LOCAL_ENDINGS.some(ending => name.endsWith(ending))) return true;
    return extra.some(allowed => (allowed.startsWith('.') ? name.endsWith(allowed) || name === allowed.slice(1) : name === allowed));
  };
}

module.exports = { hostChecker, nameOf };
