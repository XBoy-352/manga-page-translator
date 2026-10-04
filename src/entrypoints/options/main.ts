import { DEFAULT_SETTINGS } from '../../shared/settings';

const listEl = document.querySelector('#setting-keys');
if (listEl) {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const li = document.createElement('li');
    li.textContent = key;
    listEl.appendChild(li);
  }
}
