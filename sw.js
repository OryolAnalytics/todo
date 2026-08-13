/* Service Worker für "To do" – zeigt Erinnerungen an.

   Der Server schickt bewusst eine leere Weck-Nachricht ohne Inhalt.
   Erst hier wird die aktuelle Liste geholt und daraus die Meldung gebaut.
   Vorteil: Die Aufgabentexte laufen nie über fremde Push-Server. */

const CFG_CACHE = 'todo-cfg-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* Die App reicht Zugangsdaten und Sync-Code herüber. */
self.addEventListener('message', e => {
  if (e.data && e.data.typ === 'cfg') {
    e.waitUntil(caches.open(CFG_CACHE).then(c =>
      c.put('cfg', new Response(JSON.stringify(e.data.cfg)))));
  }
});

async function cfgLesen() {
  try {
    const c = await caches.open(CFG_CACHE);
    const r = await c.match('cfg');
    return r ? await r.json() : null;
  } catch (e) { return null; }
}

function basis(cfg) { return String(cfg.url || '').replace(/\/+$/, ''); }

async function rpc(cfg, fn, body) {
  const r = await fetch(basis(cfg) + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function iso(d) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}

/* Aufgaben, deren Erinnerungszeitpunkt gerade erreicht ist.
   Fenster nach hinten: 45 Minuten, damit auch verspätet zugestellte
   Weck-Nachrichten noch etwas anzeigen. */
function faellige(dok) {
  const jetzt = new Date();
  const heute = iso(jetzt);
  return (dok.aufgaben || []).filter(a => {
    if (a.geloescht || a.erledigt || !a.faellig || !a.zeit) return false;
    if (a.faellig > heute) return false;
    const [h, m] = String(a.zeit).split(':').map(Number);
    const ziel = new Date(a.faellig + 'T00:00:00');
    ziel.setHours(h || 0, m || 0, 0, 0);
    const diff = jetzt - ziel;
    return diff >= -60000 && diff <= 45 * 60000;
  });
}

async function melden() {
  const cfg = await cfgLesen();
  if (!cfg || !cfg.url || !cfg.key || !cfg.code) {
    return self.registration.showNotification('To do', {
      body: 'Es steht etwas an. Zum Nachsehen antippen.',
      icon: './icon-192.png', badge: './icon-192.png', tag: 'todo-sammel'
    });
  }

  let dok;
  try { dok = await rpc(cfg, 'sync_pull', { p_code: cfg.code }); }
  catch (e) {
    return self.registration.showNotification('To do', {
      body: 'Es steht etwas an. Zum Nachsehen antippen.',
      icon: './icon-192.png', badge: './icon-192.png', tag: 'todo-sammel'
    });
  }

  const liste = faellige(dok || {});
  if (!liste.length) {
    /* Chrome verlangt zu jeder Weck-Nachricht eine sichtbare Meldung. */
    return self.registration.showNotification('To do', {
      body: 'Nichts mehr offen – erledigt.',
      icon: './icon-192.png', badge: './icon-192.png',
      tag: 'todo-leer', silent: true
    });
  }

  const bereich = id => (dok.bereiche || []).find(b => b.id === id && !b.geloescht);

  if (liste.length === 1) {
    const a = liste[0], b = bereich(a.bereichId);
    return self.registration.showNotification(a.text, {
      body: (b ? b.name + ' · ' : '') + 'fällig um ' + a.zeit,
      icon: './icon-192.png', badge: './icon-192.png',
      tag: 'todo-' + a.id, renotify: true, requireInteraction: true,
      data: { id: a.id },
      actions: [{ action: 'fertig', title: 'Erledigt' }, { action: 'oeffnen', title: 'Öffnen' }]
    });
  }

  return self.registration.showNotification(liste.length + ' Aufgaben fällig', {
    body: liste.slice(0, 4).map(a => '• ' + a.text).join('\n'),
    icon: './icon-192.png', badge: './icon-192.png',
    tag: 'todo-sammel', renotify: true, requireInteraction: true
  });
}

self.addEventListener('push', e => e.waitUntil(melden()));

/* Abhaken direkt aus der Benachrichtigung */
async function abhaken(id) {
  const cfg = await cfgLesen();
  if (!cfg || !cfg.code) return;
  const dok = await rpc(cfg, 'sync_pull', { p_code: cfg.code });
  if (!dok || !dok.aufgaben) return;
  const a = dok.aufgaben.find(x => x.id === id);
  if (!a || a.erledigt) return;
  a.erledigt = true;
  a.erledigtAm = Date.now();
  a.ts = Date.now();
  /* Serien rücken beim nächsten Öffnen der App automatisch weiter. */
  await rpc(cfg, 'sync_push', { p_code: cfg.code, p_doc: dok });
}

self.addEventListener('notificationclick', e => {
  const id = e.notification.data && e.notification.data.id;
  e.notification.close();
  if (e.action === 'fertig' && id) { e.waitUntil(abhaken(id)); return; }
  e.waitUntil((async () => {
    const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of fenster) {
      if (f.url.includes(self.registration.scope)) return f.focus();
    }
    return self.clients.openWindow('./');
  })());
});
