/** Thin wrapper around fetch that turns API errors into thrown Errors. */
async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  listQuizzes: () => request('GET', '/api/quizzes'),
  createQuiz: (payload) => request('POST', '/api/quizzes', payload),
  getQuiz: (quizId) => request('GET', `/api/quizzes/${quizId}`),
  updateQuiz: (quizId, payload) => request('PATCH', `/api/quizzes/${quizId}`, payload),
  deleteQuiz: (quizId) => request('DELETE', `/api/quizzes/${quizId}`),

  addQuestion: (quizId, payload) => request('POST', `/api/quizzes/${quizId}/questions`, payload),
  aiStatus: () => request('GET', '/api/ai/status'),
  generateQuestions: (quizId, payload) =>
    request('POST', `/api/quizzes/${quizId}/questions/generate`, payload),
  addQuestionsFromText: (quizId, text, dryRun = false) =>
    request('POST', `/api/quizzes/${quizId}/questions/bulk`, { text, dryRun }),
  updateQuestion: (quizId, questionId, payload) =>
    request('PUT', `/api/quizzes/${quizId}/questions/${questionId}`, payload),
  deleteQuestion: (quizId, questionId) =>
    request('DELETE', `/api/quizzes/${quizId}/questions/${questionId}`),
  moveQuestion: (quizId, questionId, direction) =>
    request('POST', `/api/quizzes/${quizId}/questions/${questionId}/move`, { direction }),

  getShare: (quizId) => request('GET', `/api/quizzes/${quizId}/share`),
  getResults: (quizId) => request('GET', `/api/quizzes/${quizId}/results`),
  clearResults: (quizId) => request('DELETE', `/api/quizzes/${quizId}/results`),
  getAttemptReview: (quizId, attemptId) =>
    request('GET', `/api/quizzes/${quizId}/attempts/${attemptId}`),
  deleteAttempt: (quizId, attemptId) =>
    request('DELETE', `/api/quizzes/${quizId}/attempts/${attemptId}`),

  getIntro: (quizId) => request('GET', `/api/quizzes/${quizId}/intro`),
  startAttempt: (quizId, participantName) =>
    request('POST', `/api/quizzes/${quizId}/attempts`, { participantName }),
  saveAnswer: (attemptId, questionId, optionIndex) =>
    request('POST', `/api/attempts/${attemptId}/answers`, { questionId, optionIndex }),
  submitAttempt: (attemptId, answers) =>
    request('POST', `/api/attempts/${attemptId}/submit`, { answers }),
};

/* ---- Shared UI helpers ---- */

export function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return '--';
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatTimeLimit(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes && remainder) return `${minutes} min ${remainder} sec`;
  if (minutes) return `${minutes} min`;
  return `${remainder} sec`;
}

export function formatDateTime(isoString) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Build an element tree without innerHTML, so quiz text can never inject markup. */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('Refusing to set raw HTML.');
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of [children].flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

let toastTimer;
export function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('toast--visible'), 2600);
}

export function showError(node, message) {
  node.textContent = message;
  node.className = 'notice notice--error';
  node.hidden = false;
}

export function hideNotice(node) {
  node.hidden = true;
}
