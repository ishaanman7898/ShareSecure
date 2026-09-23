(function () {
  const REPO = 'https://github.com/ishaanman7898/ShareSecure';
  const RAW = 'https://raw.githubusercontent.com/ishaanman7898/ShareSecure/main/public';

  // Serve the scripts from this site when it's a real https deployment;
  // fall back to GitHub for localhost / tunnel instances.
  const host = location.hostname;
  const base = location.protocol === 'https:' && !host.endsWith('loca.lt') ? location.origin : RAW;

  const PLATFORMS = {
    unix: {
      cmd: `curl -fsSL ${base}/install.sh | bash`,
      hint: 'Paste into Terminal. Works on macOS, Ubuntu, Debian, Fedora and Arch.',
      steps: [
        'Installs Node.js if you don’t have version 18 or newer.',
        'Downloads ShareSecure into <code>~/sharesecure</code>.',
        'Creates an encryption key that only your install knows.',
        'Starts the server at <code>http://localhost:3000</code> and prints a public link other devices can use.',
      ],
      facts: [
        ['Start it again', '<code>cd ~/sharesecure &amp;&amp; npm start</code>'],
        ['Update', 'Run the install command again. Your files and settings are kept.'],
        ['Your files', 'Stored in <code>~/sharesecure/data</code>. Back up this folder.'],
        ['Uninstall', 'Stop the server and delete <code>~/sharesecure</code>.'],
      ],
    },
    windows: {
      cmd: `irm ${base}/install.ps1 | iex`,
      hint: 'Paste into PowerShell. Node.js is installed with winget if it’s missing.',
      steps: [
        'Installs Node.js if you don’t have version 18 or newer.',
        'Downloads ShareSecure into <code>%USERPROFILE%\\sharesecure</code>.',
        'Creates an encryption key that only your install knows.',
        'Adds a ShareSecure shortcut to your desktop, starts the server and opens it in your browser.',
      ],
      facts: [
        ['Start it again', 'Double-click the ShareSecure shortcut on your desktop.'],
        ['Update', 'Run the install command again. Your files and settings are kept.'],
        ['Your files', 'Stored in <code>%USERPROFILE%\\sharesecure\\data</code>. Back up this folder.'],
        ['Uninstall', 'Close the server window and delete the <code>sharesecure</code> folder and shortcut.'],
      ],
    },
    docker: {
      cmd: `docker run -d --name sharesecure --restart unless-stopped -p 3000:3000 -v sharesecure-data:/app/data $(docker build -q ${REPO}.git)`,
      hint: 'Builds the image straight from GitHub, so there’s nothing to clone. Works in any shell with Docker installed.',
      steps: [
        'Builds the ShareSecure image from the latest source on GitHub.',
        'Starts a container on port 3000 that restarts with Docker.',
        'Keeps your files, database and encryption key in the <code>sharesecure-data</code> volume.',
        'Open <code>http://localhost:3000</code>. Run <code>docker logs sharesecure</code> to see the public link.',
      ],
      facts: [
        ['Stop or start', '<code>docker stop sharesecure</code> and <code>docker start sharesecure</code>'],
        ['Update', 'Run <code>docker rm -f sharesecure</code>, then the install command again. The volume is kept.'],
        ['Your files', 'In the <code>sharesecure-data</code> volume.'],
        ['Uninstall', '<code>docker rm -f sharesecure &amp;&amp; docker volume rm sharesecure-data</code>'],
      ],
    },
  };

  const tabs = Array.from(document.querySelectorAll('.sh-tab'));
  const cmdEl = document.getElementById('sh-cmd');
  const hintEl = document.getElementById('sh-hint');
  const stepsEl = document.getElementById('sh-steps');
  const factsEl = document.getElementById('sh-facts');
  const copyBtn = document.getElementById('sh-copy');

  function select(os, focus) {
    const p = PLATFORMS[os];
    tabs.forEach(t => {
      const on = t.dataset.os === os;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    document.getElementById('sh-panel').setAttribute('aria-labelledby', 'tab-' + os);
    cmdEl.textContent = p.cmd;
    hintEl.textContent = p.hint;
    stepsEl.innerHTML = p.steps.map(s => `<li><span>${s}</span></li>`).join('');
    factsEl.innerHTML = p.facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    copyBtn.textContent = 'Copy';
  }

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t.dataset.os));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      select(next.dataset.os, true);
    });
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(cmdEl.textContent).then(() => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
    }).catch(() => {
      const r = document.createRange();
      r.selectNodeContents(cmdEl);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
  });

  const ua = navigator.userAgent;
  select(/Windows/i.test(ua) ? 'windows' : 'unix');
})();
