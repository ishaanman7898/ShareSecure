// Inside the desktop app, hide links to download or self-host ShareSecure.
if (/ShareSecureDesktop\//.test(navigator.userAgent)) document.documentElement.classList.add('is-desktop');

// the zero-knowledge code is only needed to create an account, so it loads then
const loadZK = () => import('/zk-client.js');

const $ = id => document.getElementById(id);
const form = $('auth-form');
const username = $('auth-username');
const password = $('auth-password');
const confirm = $('auth-confirm');
const submit = $('auth-submit');

// Where to go once signed in: back to the file that asked for it, or the app.
// Only viewer links are allowed, so the parameter can't send anyone elsewhere.
function afterSignIn() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return /^\/r\/[A-Za-z0-9]{4,32}$/.test(next) ? next : '/';
}
const errorEl = $('auth-error');

// signin | signup (browser version) | setup | owner-signin (self-hosted)
let mode = 'signin';
let selfHost = false;
let minLength = 6;

const COPY = {
  signin: {
    title: 'Sign in',
    sub: 'Sign in to share files and see what’s been sent to you.',
    submit: 'Sign in',
    switch: 'New to ShareSecure? <a href="?new=1" data-mode="signup">Create an account</a>',
  },
  signup: {
    title: 'Create an account',
    sub: 'Pick a username and password. No email needed.',
    submit: 'Create account',
    note: 'There’s no password reset, so keep your password somewhere safe.',
    switch: 'Already have an account? <a href="/signin" data-mode="signin">Sign in</a>',
  },
  setup: {
    title: 'Set up ShareSecure',
    sub: 'Create the owner account for this ShareSecure. Only this account can upload and manage files. People you share links with don’t need an account.',
    submit: 'Create owner account',
    note: 'There’s no password reset, so keep your password somewhere safe.',
    switch: '',
  },
  'owner-signin': {
    title: 'Sign in',
    sub: 'Sign in with the owner account for this ShareSecure.',
    submit: 'Sign in',
    switch: '',
  },
};

function render() {
  const c = COPY[mode];
  const creating = mode === 'signup' || mode === 'setup';
  document.title = `${c.title} — ShareSecure`;
  $('auth-title').textContent = c.title;
  $('auth-sub').textContent = c.sub;
  submit.textContent = c.submit;
  $('auth-switch').innerHTML = c.switch;
  $('auth-switch').classList.toggle('hidden', !c.switch);
  $('auth-note').textContent = c.note || '';
  $('auth-note').classList.toggle('hidden', !c.note);
  $('confirm-group').classList.toggle('hidden', !creating);
  $('password-hint').textContent = creating ? `at least ${minLength} characters` : '';
  password.autocomplete = creating ? 'new-password' : 'current-password';
  $('auth-back').classList.toggle('hidden', selfHost);
  // the website's terms don't cover a ShareSecure you run yourself
  $('auth-legal').classList.toggle('hidden', selfHost);
  errorEl.textContent = '';
}

function setMode(next) {
  mode = next;
  history.replaceState(null, '', next === 'signup' ? '/signin?new=1' : '/signin');
  render();
  username.focus();
}

$('auth-switch').addEventListener('click', e => {
  const link = e.target.closest('a[data-mode]');
  if (!link) return;
  e.preventDefault();
  setMode(link.dataset.mode);
});

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok && data.success !== false, data };
}

async function signIn(user, pass) {
  const { ok, data } = await post('/api/auth/login', { username: user, access_code: pass });
  if (!ok || !data.token) throw new Error(data.error || 'Wrong username or password.');
  sessionStorage.setItem('user_token', data.token);
  if (data.username) sessionStorage.setItem('user_name', data.username);
  location.replace(afterSignIn());
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorEl.textContent = '';
  const user = username.value.trim();
  const pass = password.value;
  const creating = mode === 'signup' || mode === 'setup';

  if (!user) { errorEl.textContent = 'Enter a username.'; username.focus(); return; }
  if (!pass) { errorEl.textContent = 'Enter your password.'; password.focus(); return; }
  if (creating && pass.length < minLength) {
    errorEl.textContent = `Use at least ${minLength} characters for your password.`;
    password.focus();
    return;
  }
  if (creating && pass !== confirm.value) {
    errorEl.textContent = 'The passwords don’t match.';
    confirm.focus();
    return;
  }

  submit.disabled = true;
  const label = submit.textContent;
  submit.textContent = creating ? 'Creating account…' : 'Signing in…';

  try {
    if (creating) {
      // Browser version: enroll ZK credentials in this browser; only the commitment is sent.
      let zk_commitment = null;
      if (!selfHost) {
        try { zk_commitment = (await (await loadZK()).generateCredentials()).commitment; } catch {}
      }
      const { ok, data } = await post('/api/auth/register', { username: user, access_code: pass, zk_commitment });
      if (!ok) {
        if (!selfHost) { try { localStorage.removeItem('zk_secret'); localStorage.removeItem('zk_commitment'); } catch {} }
        throw new Error(data.error || 'Couldn’t create the account. Try again.');
      }
    }
    await signIn(user, pass);
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong. Try again.';
    submit.disabled = false;
    submit.textContent = label;
  }
});

(async () => {
  if (sessionStorage.getItem('user_token')) { location.replace(afterSignIn()); return; }
  try {
    const res = await fetch('/api/mode', { signal: AbortSignal.timeout(3000) });
    const info = res.ok ? await res.json() : {};
    selfHost = info.selfHostMode === true;
    if (selfHost) {
      minLength = 8;
      mode = info.setupRequired ? 'setup' : 'owner-signin';
    } else {
      mode = new URLSearchParams(location.search).has('new') ? 'signup' : 'signin';
    }
  } catch {
    mode = 'signin';
  }
  render();
  if (sessionStorage.getItem('account_deleted')) {
    sessionStorage.removeItem('account_deleted');
    $('auth-sub').textContent = 'The account and its files were deleted. Set up a new owner account to use ShareSecure again.';
  }
  username.focus();
})();
