// The desktop app's download button (the download page and Host it yourself):
// it offers the file for this computer, and the rest sit beside it.
(function () {
  const primary = document.getElementById('dl-primary');
  if (!primary) return;
  const DL = 'https://github.com/ishaanman7898/ShareSecure/releases/latest/download';
  const BUILDS = [
    // one installer for both Intel/AMD and ARM (Snapdragon) PCs
    { id: 'win', label: 'Windows', file: 'ShareSecure-Setup.exe' },
    { id: 'mac-arm', label: 'Mac (Apple silicon)', file: 'ShareSecure-mac-arm64.dmg' },
    { id: 'mac-intel', label: 'Mac (Intel)', file: 'ShareSecure-mac-x64.dmg' },
    { id: 'linux', label: 'Linux (AppImage)', file: 'ShareSecure-linux.AppImage' },
  ];
  const ua = navigator.userAgent;
  // browsers report Intel on Apple silicon Macs too, so Apple silicon is the safer guess
  const mine = /Windows/i.test(ua) ? 'win' : /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua) ? 'mac-arm' : /Linux/i.test(ua) && !/Android/i.test(ua) ? 'linux' : null;
  const own = BUILDS.find(b => b.id === mine);
  if (own) {
    primary.href = `${DL}/${own.file}`;
    (primary.querySelector('span') || primary).textContent = `Download for ${own.label}`;
  } else {
    (primary.querySelector('span') || primary).textContent = 'See all downloads';
  }
  document.getElementById('dl-other').innerHTML = BUILDS
    .filter(b => b.id !== mine)
    .map(b => `<a href="${DL}/${b.file}">${b.label}</a>`)
    .join('');
})();
