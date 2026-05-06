// ── Toast notification ──────────────────────────────────────────────
function showToast(msg, type = 'success') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.className = type;
  t.innerHTML = `<i class="fa-solid fa-${type === 'success' ? 'check-circle' : 'circle-xmark'}"></i> ${msg}`;
  t.classList.add('show');
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── API helper ──────────────────────────────────────────────────────
async function apiPost(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function apiGet(url) {
  const res = await fetch(url);
  return res.json();
}

// ── Toggle switch auto-save ─────────────────────────────────────────
document.addEventListener('change', async (e) => {
  const toggle = e.target.closest('[data-api-toggle]');
  if (!toggle) return;
  const apiUrl = toggle.getAttribute('data-api-toggle');
  const key    = toggle.getAttribute('data-key');
  const value  = toggle.checked;
  try {
    const r = await apiPost(apiUrl, { [key]: value });
    if (r.success !== false) showToast('Sauvegardé !');
    else showToast('Erreur lors de la sauvegarde', 'error');
  } catch { showToast('Erreur réseau', 'error'); }
});

// ── Form auto-save on submit ────────────────────────────────────────
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-api-form]');
  if (!form) return;
  e.preventDefault();
  const apiUrl = form.getAttribute('data-api-form');
  const formData = new FormData(form);
  const data = {};
  formData.forEach((v, k) => {
    if (data[k]) {
      if (!Array.isArray(data[k])) data[k] = [data[k]];
      data[k].push(v);
    } else {
      data[k] = v;
    }
  });

  // Gérer les checkboxes non cochées
  form.querySelectorAll('input[type=checkbox]').forEach(cb => {
    if (!cb.checked && !data[cb.name]) data[cb.name] = false;
  });

  const btn = form.querySelector('[type=submit]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sauvegarde...'; }

  try {
    const r = await apiPost(apiUrl, data);
    if (r.success !== false) {
      showToast('Sauvegardé avec succès !');
    } else {
      showToast(r.error || 'Erreur lors de la sauvegarde', 'error');
    }
  } catch { showToast('Erreur réseau', 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Sauvegarder'; }
  }
});

// ── Personality picker ──────────────────────────────────────────────
document.querySelectorAll('.personality-option').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.personality-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    const input = document.getElementById('personality-input');
    if (input) input.value = opt.getAttribute('data-value');
  });
});

// ── Channel blocked toggle ──────────────────────────────────────────
document.querySelectorAll('.channel-item[data-channel-id]').forEach(item => {
  item.addEventListener('click', async () => {
    const channelId = item.getAttribute('data-channel-id');
    const guildId   = item.getAttribute('data-guild-id');
    const blocked   = item.classList.contains('blocked');

    item.classList.toggle('blocked');
    const blockedEl = item.querySelector('.channel-badge');
    if (item.classList.contains('blocked')) {
      if (blockedEl) blockedEl.innerHTML = `<span class="badge badge-red">Bloqué</span>`;
    } else {
      if (blockedEl) blockedEl.innerHTML = '';
    }

    // Recalcule la liste complète
    const allBlocked = [...document.querySelectorAll('.channel-item.blocked')]
      .map(el => el.getAttribute('data-channel-id'));

    try {
      await apiPost(`/api/guild/${guildId}/ai`, { blockedChannels: allBlocked });
      showToast('Mise à jour des salons !');
    } catch { showToast('Erreur', 'error'); }
  });
});

// ── Mobile sidebar toggle ───────────────────────────────────────────
const menuToggle = document.getElementById('menu-toggle');
const sidebar    = document.querySelector('.sidebar');
if (menuToggle && sidebar) {
  menuToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
}
