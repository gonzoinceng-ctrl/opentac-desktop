// Progressive enhancement for /contact/: submit with fetch and show the result inline.
// Without this script the form still works as a normal POST to /api/contact (303 to /contact/thanks/).
(function () {
  'use strict';
  var form = document.getElementById('contact-form');
  var status = document.getElementById('contact-status');
  if (!form || !status || !window.fetch || !window.FormData) return;
  var button = form.querySelector('button[type="submit"]');

  function show(kind, text) {
    status.hidden = false;
    status.className = 'form-status ' + kind;
    status.textContent = text;
    status.focus();
  }

  form.addEventListener('submit', function (ev) {
    if (!form.checkValidity()) return; // let the browser show its own messages
    ev.preventDefault();
    var body = new URLSearchParams(new FormData(form));
    if (button) button.disabled = true;
    status.hidden = true;
    fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'same-origin',
    })
      .then(function (res) {
        return res.json().then(
          function (data) { return { res: res, data: data }; },
          function () { return { res: res, data: null }; }
        );
      })
      .then(function (r) {
        if (r.res.ok && r.data && r.data.ok) {
          form.reset();
          form.hidden = true;
          show('ok', 'Thank you. Your message has been received. It is read by hand, and there may not be a reply.');
        } else {
          show('err', (r.data && r.data.error) || 'The message could not be sent. Please try again later.');
          if (button) button.disabled = false;
        }
      })
      .catch(function () {
        show('err', 'The message could not be sent. Check your connection and try again.');
        if (button) button.disabled = false;
      });
  });
})();
