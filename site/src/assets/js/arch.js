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

  var uad = navigator.userAgentData;
  var mac = /Mac/i.test((uad && uad.platform) || navigator.platform || '');
  if (!mac) return;

  var done = false;
  function finish(arch) {
    if (done) return;
    done = true;
    if (arch) apply(arch, 'detected');
  }

  if (uad && typeof uad.getHighEntropyValues === 'function') {
    uad.getHighEntropyValues(['architecture']).then(
      function (v) {
        finish(v.architecture === 'arm' ? 'arm64' : v.architecture === 'x86' ? 'x64' : fromRenderer());
      },
      function () { finish(fromRenderer()); }
    );
  } else {
    finish(fromRenderer());
  }
})();
