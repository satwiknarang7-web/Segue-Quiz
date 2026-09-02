import { el, showError, toast } from './api.js';

const steps = {
  account: document.querySelector('#account-step'),
  enrol: document.querySelector('#enrol-step'),
  recovery: document.querySelector('#recovery-step'),
};

const accountError = document.querySelector('#account-error');
const enrolError = document.querySelector('#enrol-error');

let recoveryCodes = [];

function showStep(name) {
  for (const [key, node] of Object.entries(steps)) node.hidden = key !== name;

  const order = ['account', 'enrol', 'recovery'];
  const current = order.indexOf(name);
  document.querySelectorAll('.progress-steps__item').forEach((item, index) => {
    item.dataset.state = index < current ? 'done' : index === current ? 'current' : 'todo';
  });
}

async function post(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function showEnrolment({ secret, qrUrl }) {
  document.querySelector('#totp-qr').src = `${qrUrl}?v=${Date.now()}`;
  document.querySelector('#totp-secret').textContent = secret;
  showStep('enrol');
  document.querySelector('#enrol-code').focus();
}

/* ---- Step 1: the account ------------------------------------------------ */

document.querySelector('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  accountError.hidden = true;

  const button = document.querySelector('#account-submit');
  button.disabled = true;

  try {
    const result = await post('/api/auth/signup', {
      name: document.querySelector('#name').value,
      email: document.querySelector('#email').value,
      password: document.querySelector('#password').value,
      signupCode: document.querySelector('#signup-code').value,
    });

    if (result.adoptedQuizzes > 0) {
      toast(`${result.adoptedQuizzes} existing quiz(zes) moved into your account`);
    }
    showEnrolment(result.enrolment);
  } catch (error) {
    showError(accountError, error.message);
    button.disabled = false;
  }
});

/* ---- Step 2: prove the authenticator works ------------------------------ */

document.querySelector('#enrol-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  enrolError.hidden = true;

  const button = document.querySelector('#enrol-submit');
  const input = document.querySelector('#enrol-code');
  button.disabled = true;

  try {
    const result = await post('/api/auth/2fa/activate', { code: input.value });
    recoveryCodes = result.recoveryCodes;

    const list = document.querySelector('#recovery-codes');
    list.replaceChildren(...recoveryCodes.map((code) => el('li', { text: code })));
    showStep('recovery');
  } catch (error) {
    showError(enrolError, error.message);
    button.disabled = false;
    input.select();
  }
});

/* ---- Step 3: recovery codes --------------------------------------------- */

document.querySelector('#copy-codes').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(recoveryCodes.join('\n'));
    toast('Recovery codes copied');
  } catch {
    window.prompt('Copy these codes:', recoveryCodes.join(' '));
  }
});

document.querySelector('#download-codes').addEventListener('click', () => {
  const blob = new Blob(
    [`SegueQuiz recovery codes\nEach code can be used once.\n\n${recoveryCodes.join('\n')}\n`],
    { type: 'text/plain' },
  );
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: 'seguequiz-recovery-codes.txt' });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

document.querySelector('#codes-saved').addEventListener('change', (event) => {
  document.querySelector('#finish').disabled = !event.target.checked;
});

document.querySelector('#finish').addEventListener('click', () => {
  window.location.href = '/dashboard';
});

/* ---- Boot --------------------------------------------------------------- */

async function boot() {
  // Only ask for the maker code when the server actually requires one.
  try {
    const policy = await fetch('/api/auth/signup-policy').then((response) => response.json());
    if (policy.codeRequired) {
      const field = document.querySelector('#maker-code-field');
      field.hidden = false;
      document.querySelector('#signup-code').required = true;
    }
  } catch {
    // If the check fails, leave the field visible-on-demand rather than blocking sign-up.
  }

  // Someone who created an account but never finished 2FA lands here to resume.
  if (new URLSearchParams(window.location.search).has('resume')) {
    try {
      const setup = await fetch('/api/auth/2fa/setup');
      if (setup.ok) {
        showEnrolment(await setup.json());
        return;
      }
    } catch {
      /* fall through to the normal sign-up form */
    }
  }

  showStep('account');
}

boot();
