(() => {
  const card = document.getElementById('recurring-billing-card');
  const body = document.getElementById('recurring-billing-body');
  const shell = document.getElementById('app-shell');
  if (!card || !body || !shell) return;

  let loadedForSession = false;
  let busy = false;
  const escapeText = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const formatDate = value => value ? new Intl.DateTimeFormat('es-PA', { dateStyle: 'long' }).format(new Date(`${String(value).slice(0, 10)}T12:00:00`)) : 'Sin próximo corte';

  function render(payload) {
    const automatic = Boolean(payload.automatic);
    body.innerHTML = `
      <div class="recurring-billing-state ${automatic ? 'active' : 'paused'}">
        <span class="recurring-billing-icon" aria-hidden="true">${automatic ? '✓' : 'Ⅱ'}</span>
        <div><b>${automatic ? 'Mensualidades automáticas activas' : 'Mensualidades pausadas durante la migración'}</b><p>${automatic ? `Eileen prepara cada cobro ${payload.daysAhead} día${Number(payload.daysAhead) === 1 ? '' : 's'} antes del día de corte.` : 'Zoho sigue siendo el sistema de cobro. Eileen no generará duplicados antes del corte final.'}</p></div>
      </div>
      <div class="recurring-billing-metrics">
        <article><span>Clientes mensuales</span><strong>${Number(payload.activeClients || 0)}</strong></article>
        <article><span>Período actual cubierto</span><strong>${Number(payload.currentPeriodInvoices || 0)}</strong></article>
        <article><span>Listos para generar</span><strong>${Number(payload.readyToGenerate || 0)}</strong></article>
        <article><span>Próximo corte</span><strong class="recurring-date">${escapeText(formatDate(payload.nextDueOn))}</strong></article>
      </div>
      <div class="recurring-billing-actions">
        <button class="secondary" id="recurring-refresh" ${busy ? 'disabled' : ''}>Actualizar estado</button>
        ${automatic ? `<button class="primary" id="recurring-generate" ${busy ? 'disabled' : ''}>Generar cobros pendientes</button>` : '<span class="commercial-note">Finaliza la migración de Zoho para activar este proceso.</span>'}
      </div>
    `;
  }

  async function load(showError = true) {
    if (!authToken) return;
    try {
      render(await api('/api/billing/recurring/status'));
    } catch (error) {
      body.innerHTML = `<p class="zoho-error">${escapeText(error.message)}</p><button class="secondary" id="recurring-refresh">Intentar nuevamente</button>`;
      if (showError) toast(error.message, true);
    }
  }

  card.addEventListener('click', async event => {
    const refresh = event.target.closest('#recurring-refresh');
    const generate = event.target.closest('#recurring-generate');
    if ((!refresh && !generate) || busy) return;
    busy = true;
    try {
      if (generate) {
        const result = await api('/api/billing/recurring/generate', { method: 'POST' });
        await loadData(); renderAll();
        toast(result.generated ? `${result.generated} cobro${result.generated === 1 ? '' : 's'} generado${result.generated === 1 ? '' : 's'}` : 'No había cobros nuevos por generar');
      }
      await load(false);
    } catch (error) { toast(error.message, true); await load(false); }
    finally { busy = false; }
  });

  document.addEventListener('recurringbillingrefresh', () => load(false));
  const observeSession = () => {
    if (!shell.hidden && authToken && !loadedForSession) { loadedForSession = true; load(false); }
    if (shell.hidden) loadedForSession = false;
  };
  new MutationObserver(observeSession).observe(shell, { attributes: true, attributeFilter: ['hidden'] });
  observeSession();
})();
