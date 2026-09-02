import { showError } from './api.js';

const form = document.querySelector('#join-form');
const input = document.querySelector('#join-code');
const errorNode = document.querySelector('#join-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorNode.hidden = true;

  const code = input.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    showError(errorNode, 'Join codes are six letters and numbers.');
    return;
  }

  // Check the quiz exists before navigating, so a typo does not land on an error page.
  try {
    const response = await fetch(`/api/quizzes/${code}/intro`);
    if (!response.ok) {
      showError(errorNode, 'No quiz found with that code. Check it and try again.');
      return;
    }
    window.location.href = `/take/${code}`;
  } catch {
    showError(errorNode, 'Could not reach the server. Check your connection.');
  }
});
