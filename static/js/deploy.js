// 部署示例页：只读展示 deploy_examples/ 里的示例脚本（来自 /api/deploy-examples）。
// 这些脚本只给用户参考和复制，平台不会执行。
import { $, api, escapeHtml } from './common.js';

let examples = [];

function select(id) {
  const example = examples.find((e) => e.id === id);
  if (!example) return;
  $('#deploy-title').textContent = example.title;
  $('#deploy-summary').textContent = `${example.summary}（文件：deploy_examples/${example.file}）`;
  $('#deploy-code').textContent = example.code;
  $('#deploy-copy').hidden = false;
  document.querySelectorAll('.example-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
}

$('#deploy-list').addEventListener('click', (e) => {
  const item = e.target.closest('.example-item');
  if (item) select(item.dataset.id);
});

$('#deploy-copy').addEventListener('click', async () => {
  const button = $('#deploy-copy');
  try {
    await navigator.clipboard.writeText($('#deploy-code').textContent);
    button.textContent = '已复制';
  } catch {
    button.textContent = '请手动选中复制';
  }
  setTimeout(() => (button.textContent = '复制脚本'), 1500);
});

async function load() {
  examples = await api('/api/deploy-examples');
  $('#deploy-list').innerHTML = examples
    .map(
      (e) => `<button class="example-item" data-id="${e.id}">
        <strong>${escapeHtml(e.title)}</strong>
        <span class="badges">${e.tags.map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join('')}</span>
        <span class="muted">${escapeHtml(e.summary)}</span>
      </button>`,
    )
    .join('');
  select(examples[0]?.id);
}

load();
