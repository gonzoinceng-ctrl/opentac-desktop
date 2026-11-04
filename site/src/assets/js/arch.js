// Switches the primary download button between the Apple Silicon and Intel builds.
// The page works without this file: the button defaults to arm64 and the x64 link is always visible.
(function () {
  'use strict';
  var root = document.querySelector('[data-arch-root]');
  if (!root) return;
  var primary = root.querySelector('[data-arch-primary]');
  var label = root.querySelector('[data-arch-label]');
  var alt = root.querySelector('[data-arch-alt]');
  var note = root.querySelector('[data-arch-note]');
  if (!primary || !alt) return;

  function apply(arch, how) {
    var other = arch === 'arm64' ? 'x64' : 'arm64';
    primary.setAttribute('href', root.getAttribute('data-' + arch + '-href'));
    if (label) label.textContent = root.getAttribute('data-' + arch + '-label');
    alt.setAttribute('href', root.getAttribute('data-' + other + '-href'));
    alt.textContent = root.getAttribute('data-' + other + '-alt');
    if (note) note.textContent = how === 'detected' ? 'Detected: ' + (arch === 'arm64' ? 'Apple Silicon' : 'Intel') + ' Mac.' : '';
  }

  function webglRenderer() {
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return '';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    } catch (e) {
      return '';
    }
  }

  function fromRenderer() {
    var r = webglRenderer();
    if (/Apple M\d/i.test(r)) return 'arm64';
    // Apple Silicon never reports a discrete/Intel GPU vendor; Safari's masked "Apple GPU" is ambiguous.
    if (/Intel|AMD|Radeon|NVIDIA|GeForce/i.test(r)) return 'x64';
    return null;
  }

  // The note span only exists when both builds are published; create a line for it otherwise.
  function say(text) {
    if (!note) {
      var p = document.createElement('p');
      p.className = 'cta-note';
      note = document.createElement('span');
      p.appendChild(note);
      root.appendChild(p);
    }
    note.textContent = text;
  }

  var uad = navigator.userAgentData;
  var platform = (uad && uad.platform) || navigator.platform || '';
  // iPadOS reports "MacIntel" but has a touch screen: it cannot run a Mac app.
  var mac = /Mac/i.test(platform) && !(navigator.maxTouchPoints > 1 && !(uad && uad.platform));
  if (!mac) {
    // Windows, Linux, phones: no macOS download to offer as the primary action.
    primary.hidden = true;
    say('OpenTac is for macOS only.');
    return;
  }

  var done = false;
  function finish(arch) {
    if (done) return;
    done = true;
    if (arch) apply(arch, 'detected');
    else say('Not sure which Mac you have? Apple menu > About This Mac shows the chip.');
  }

  if (uad && typeof uad.getHighEntropyValues === 'function') {
    uad.getHighEntropyValues(['architecture']).then(
      function (v) {
        // x64 Chrome under Rosetta reports "x86" but its GPU is an Apple M chip: the Mac is Apple Silicon.
        var r = fromRenderer();
        finish(v.architecture === 'arm' || (v.architecture === 'x86' && r === 'arm64') ? 'arm64' : v.architecture === 'x86' ? 'x64' : r);
      },
      function () { finish(fromRenderer()); }
    );
  } else {
    finish(fromRenderer());
  }
})();
