const form = document.getElementById('loginForm');
const accountInput = document.getElementById('loginAccountInput');
const passwordInput = document.getElementById('loginPasswordInput');
const submitBtn = document.getElementById('loginSubmitBtn');
const statusEl = document.getElementById('loginStatus');

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.classList.remove('is-error', 'is-success');
  if (type) {
    statusEl.classList.add(type);
  }
}

function nextPath() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/ui';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  setStatus('正在验证管理员凭证…');

  try {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        account: accountInput.value.trim(),
        password: passwordInput.value,
        next: nextPath()
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || 'login_failed');
    }

    setStatus('登录成功，正在进入控制台…', 'is-success');
    window.location.assign(body.redirect_to || nextPath());
  } catch (error) {
    setStatus(error instanceof Error && error.message === 'invalid_credentials' ? '账号或密码不正确。' : '登录失败，请稍后重试。', 'is-error');
    passwordInput.focus();
    passwordInput.select();
  } finally {
    submitBtn.disabled = false;
  }
});
