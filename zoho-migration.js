(() => {
  const card = document.getElementById('zoho-migration-card');
  const statusLabel = document.getElementById('zoho-status');
  const body = document.getElementById('zoho-migration-body');
  const shell = document.getElementById('app-shell');
  if (!card || !statusLabel || !body || !shell) return;

  let loadedForSession = false;
  let busy = false;
  const formatCount = value => new Intl.NumberFormat('es-PA').format(Number(value || 0));
  const formatDate = value => value ? new Intl.DateTimeFormat('es-PA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Todavía no se ha sincronizado';
  const statusNames = { connected: 'Conectado', syncing: 'Sincronizando', ready: 'Conciliado', completed: 'Migración completa', error: 'Requiere atención' };
  const escapeText = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

  function setStatus(value, label) {
    statusLabel.className = `zoho-status ${value || ''}`.trim();
    statusLabel.textContent = label || statusNames[value] || 'No conectado';
  }

  function metric(label, source, local) {
    const matches = Number(source || 0) === Number(local || 0);
    return `<div class="zoho-sync-metric"><span>${label}</span><strong>${formatCount(local)}</strong><span>${matches ? 'Coincide con Zoho' : `Zoho: ${formatCount(source)}`}</span></div>`;
  }

  function render(payload) {
    if (!payload.configured) {
      setStatus('', 'Configuración pendiente');
      body.innerHTML = `<div class="zoho-migration-actions"><p>Agrega las credenciales OAuth de Zoho en Railway para habilitar la conexión segura.</p></div>`;
      return;
    }
    if (!payload.connected) {
      setStatus('', 'No conectado');
      body.innerHTML = `<div class="zoho-migration-actions"><button class="primary" id="zoho-connect">Conectar Zoho Invoice</button></div><p class="commercial-note">La conexión será de solo lectura durante toda la migración.</p>`;
      return;
    }
    const connection = payload.connection || {};
    const source = connection.source_summary || {};
    const local = connection.local_summary || {};
    const reconciled = Boolean(payload.lastRun?.reconciled);
    const state = payload.syncInProgress ? 'syncing' : connection.status;
    setStatus(state, payload.syncInProgress ? 'Sincronizando' : statusNames[state]);
    body.innerHTML = `
      <div class="zoho-sync-grid">
        ${metric('Clientes', source.clients, local.clients)}
        ${metric('Facturas', source.invoices, local.invoices)}
        ${metric('Pagos', source.payments, local.payments)}
        ${metric('Mensualidades', source.recurring, local.recurring)}
        ${metric('Notas de crédito', source.credits, local.credits)}
        <div class="zoho-sync-metric"><span>Total importado</span><strong>${money.format(Number(local.totalInvoiced || 0))}</strong><span>Facturación histórica</span></div>
      </div>
      <div class="zoho-reconciliation ${reconciled ? 'is-ready' : ''}"><div><b>${reconciled ? 'Datos conciliados con Zoho' : 'Sincronización todavía por conciliar'}</b><small>${escapeText(connection.organization_name || 'Zoho Invoice')} · ${formatDate(connection.last_sync_at)}</small></div><span>${reconciled ? '✓ Coincide' : 'Pendiente'}</span></div>
      ${connection.last_error ? `<p class="zoho-error">${escapeText(connection.last_error)}</p>` : ''}
      <div class="zoho-migration-actions">
        ${connection.status !== 'completed' ? `<button class="primary" id="zoho-sync" ${busy || payload.syncInProgress ? 'disabled' : ''}>${payload.syncInProgress ? 'Sincronizando…' : 'Sincronizar ahora'}</button>` : ''}
        <button class="secondary" id="zoho-refresh" ${busy ? 'disabled' : ''}>Actualizar estado</button>
      </div>
      ${connection.status !== 'completed' ? '<p class="commercial-note">Zoho seguirá funcionando hasta que hagamos el corte final después de validar la facturación de Eileen.</p>' : '<p class="commercial-note">La copia histórica quedó guardada en Eileen y la sincronización con Zoho está cerrada.</p>'}
    `;
  }

  async function loadStatus(showError = true) {
    if (!authToken) return;
    try {
      render(await api('/api/integrations/zoho/status'));
    } catch (error) {
      setStatus('error', 'No disponible');
      body.innerHTML = `<p class="zoho-error">${escapeText(error.message)}</p><div class="zoho-migration-actions"><button class="secondary" id="zoho-refresh">Intentar nuevamente</button></div>`;
      if (showError) toast(error.message, true);
    }
  }

  card.addEventListener('click', async event => {
    const connect = event.target.closest('#zoho-connect');
    const sync = event.target.closest('#zoho-sync');
    const refresh = event.target.closest('#zoho-refresh');
    if (!connect && !sync && !refresh || busy) return;
    busy = true;
    try {
      if (connect) {
        const result = await api('/api/integrations/zoho/authorize');
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (sync) {
        setStatus('syncing', 'Sincronizando');
        sync.disabled = true; sync.textContent = 'Sincronizando…';
        const result = await api('/api/integrations/zoho/sync', { method: 'POST' });
        await loadData(); renderAll();
        toast(result.reconciled ? 'Zoho quedó conciliado con Eileen' : 'Importación terminada; revisa las diferencias');
      }
      await loadStatus(false);
    } catch (error) {
      toast(error.message, true);
      await loadStatus(false);
    } finally { busy = false; }
  });

  const observeSession = () => {
    if (!shell.hidden && authToken && !loadedForSession) {
      loadedForSession = true;
      loadStatus(false);
    }
    if (shell.hidden) loadedForSession = false;
  };
  new MutationObserver(observeSession).observe(shell, { attributes: true, attributeFilter: ['hidden'] });
  observeSession();

  if (new URLSearchParams(location.search).get('zoho') === 'connected') {
    history.replaceState(null, '', `${location.pathname}#billing`);
    const waitForApp = setInterval(() => {
      if (shell.hidden) return;
      clearInterval(waitForApp); view('billing'); loadStatus(false); toast('Zoho Invoice conectado');
    }, 150);
    setTimeout(() => clearInterval(waitForApp), 15000);
  }
})();
