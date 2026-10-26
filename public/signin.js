import { setUpKeys, newKeyFields } from './keys.js';
import { signIn as opaqueSignIn, register as opaqueRegister, postWith } from './opaque.js';
import { mountGradientASCII } from './gradient-ascii.js';

mountGradientASCII(document.getElementById('auth-gradient'), {
  shape: 'rise',
  cellSize: 18,
  density: 0.8,
  speed: 0.7,
  lightMode: !matchMedia('(prefers-color-scheme: dark)').matches,
});

// Inside the desktop app, hide links to download or self-host ShareSecure.
const inDesktop = /ShareSecureDesktop\//.test(navigator.userAgent);
if (inDesktop) document.documentElement.classList.add('is-desktop');
// On this computer's own ShareSecure, the desktop app catches this link and
// restarts with a ShareSecure account instead (see createAccount in main.js).
const DESKTOP_SIGNUP = 'Want a ShareSecure account instead? <a href="https://sharesecure-du8.pages.dev/signin?new=1">Create an account</a>';


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
  if (!/^\/r\/[A-Za-z0-9]{4,32}$/.test(next)) return '/';
  // An end-to-end encrypted link's key waits in this tab's storage, not in the
  // address, because the address of this page is sent to the server.
  const hash = sessionStorage.getItem('return_hash') || '';
  sessionStorage.removeItem('return_hash');
  return next + (/^#[kf]=[A-Za-z0-9_-]{43}$/.test(hash) ? hash : '');
}
const errorEl = $('auth-error');

// The desktop app keeps your sign-in, encrypted by the operating system, and
// signs you in with it at launch (see saved sign-in in desktop/main.js).
const savedSignIn = window.shareSecureDesktop?.signIn;
let autoSignIn = false;

// signin | signup (browser version) | setup | owner-signin (self-hosted)
let mode = 'signin';
let selfHost = false;
let minLength = 10;
// setting up a self-hosted ShareSecure from another device takes the code in its console
let needsSetupCode = false;

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
  document.title = `${c.title} | ShareSecure`;
  $('auth-title').textContent = c.title;
  $('auth-sub').textContent = c.sub;
  submit.textContent = c.submit;
  const switchHtml = c.switch || (selfHost && inDesktop ? DESKTOP_SIGNUP : '');
  $('auth-switch').innerHTML = switchHtml;
  $('auth-switch').classList.toggle('hidden', !switchHtml);
  $('auth-note').textContent = c.note || '';
  $('auth-note').classList.toggle('hidden', !c.note);
  $('confirm-group').classList.toggle('hidden', !creating);
  $('setup-code-group').classList.toggle('hidden', !(mode === 'setup' && needsSetupCode));
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

// The eye beside each password box shows what's typed, and hides it again.
const toggles = [...document.querySelectorAll('.password-toggle')];
function showPassword(btn, show) {
  $(btn.getAttribute('aria-controls')).type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}
for (const btn of toggles) {
  btn.addEventListener('click', () => showPassword(btn, btn.getAttribute('aria-pressed') !== 'true'));
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

// Passwords people pick most often, refused for new accounts. The server
// never sees the password, so this check can only happen here.
const COMMON = new Set(('password password1 password123 passw0rd 1234567890 12345678910 123456789a qwertyuiop ' +
  'qwerty1234 qwerty123456 iloveyou123 1q2w3e4r5t 1qaz2wsx3edc abcdefghij abc1234567 letmein123 welcome123 ' +
  'sharesecure sharesecure1 administrator changeme123 football123 baseball123 superman123 sunshine123 ' +
  'princess123 dragon1234 monkey1234 trustno1234 zaq12wsxcde 0987654321 1111111111 0000000000 aaaaaaaaaa').split(' '));

function weakPassword(pass, user) {
  const lower = pass.toLowerCase();
  if (COMMON.has(lower)) return 'That password is one of the most common ones. Pick another.';
  if (user && lower.includes(user.toLowerCase())) return 'Don’t put your username in your password.';
  if (/^(.)\1+$/.test(pass)) return 'Use more than one character over and over.';
  return null;
}

const send = postWith(fetch);

// On the website, sign-in never sends the password (OPAQUE, see opaque.js).
// It also unlocks this account's end-to-end key, or makes one the first time.
async function signInWebsite(user, pass) {
  const done = await opaqueSignIn(send, user, pass, newKeyFields);
  sessionStorage.setItem('user_token', done.token);
  if (done.username) sessionStorage.setItem('user_name', done.username);
  submit.textContent = 'Unlocking your keys…';
  await setUpKeys({ token: done.token, username: done.username || user, exportKey: done.exportKey, publicKey: done.publicKey, privateKeyBox: done.privateKeyBox });
}

// A ShareSecure you run yourself keeps its one owner password on your own machine.
async function signInSelfHosted(user, pass) {
  const { ok, data } = await post('/api/auth/login', { username: user, access_code: pass });
  if (!ok || !data.token) throw new Error(data.error || 'Wrong username or password.');
  sessionStorage.setItem('user_token', data.token);
  if (data.username) sessionStorage.setItem('user_name', data.username);
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorEl.textContent = '';
  // hidden again before it's sent, so password managers see a password box
  toggles.forEach(btn => showPassword(btn, false));
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
  const weak = creating && weakPassword(pass, user);
  if (weak) { errorEl.textContent = weak; password.focus(); return; }
  if (creating && pass !== confirm.value) {
    errorEl.textContent = 'The passwords don’t match.';
    confirm.focus();
    return;
  }

  submit.disabled = true;
  const label = submit.textContent;
  submit.textContent = creating ? 'Creating account…' : 'Signing in…';

  try {
    if (selfHost) {
      if (creating) {
        const { ok, data } = await post('/api/auth/register', { username: user, access_code: pass, setup_code: $('auth-setup-code').value });
        if (data.code === 'setup_code' && !needsSetupCode) { needsSetupCode = true; render(); $('auth-setup-code').focus(); }
        if (!ok) throw new Error(data.error || 'Couldn’t create the account. Try again.');
      }
      await signInSelfHosted(user, pass);
    } else {
      if (creating) await opaqueRegister(send, user, pass, newKeyFields);
      await signInWebsite(user, pass);
    }
    await savedSignIn?.save(user, pass).catch(() => {});
    location.replace(afterSignIn());
  } catch (err) {
    // a saved password that no longer works is forgotten, so it isn't tried again
    if (autoSignIn) await savedSignIn?.forget().catch(() => {});
    autoSignIn = false;
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
      needsSetupCode = info.setupCodeNeeded === true;
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
  if (savedSignIn && (mode === 'signin' || mode === 'owner-signin')) {
    const saved = await savedSignIn.load().catch(() => null);
    if (saved) {
      username.value = saved.username;
      password.value = saved.password;
      autoSignIn = true;
      form.requestSubmit();
    }
  }
})();
