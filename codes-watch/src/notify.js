const label = (e, gameName) => `${gameName} — nouveau code : ${e.code}${e.rewards ? ` (${e.rewards})` : ''}`;

export function buildMessages(events, games, confidenceOf = () => 'unconfirmed') {
  return events
    .filter((e) => e.type === 'new_code')
    .map((e) => {
      const game = games.find((g) => g.id === e.gameId);
      if (!game || game.notify === false) return null;
      const note = confidenceOf(e) === 'confirmed' ? 'confirmé par plusieurs sources' : 'validité NON vérifiée';
      return { gameName: game.name, code: e.code, title: label(e, game.name), text: `${label(e, game.name)}\nSource : ${e.source} — ${note}\n${e.url || ''}`.trim(), url: e.url };
    })
    .filter(Boolean);
}

async function post(url, body, post_, label_) {
  const res = await post_(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${label_} : HTTP ${res.status}`);
}

/** Envoie sur chaque canal activé. Un échec est journalisé mais ne bloque ni les autres canaux ni la surveillance. */
export async function sendNotifications(messages, cfg, env, fetchImpl = fetch) {
  const errors = [];
  if (!cfg?.enabled || !messages.length) return { sent: 0, errors };
  let sent = 0;
  for (const m of messages) {
    const jobs = [];
    const d = cfg.discord;
    if (d?.enabled && env[d.webhookEnv]) jobs.push(post(env[d.webhookEnv], { content: `🎮 **${m.gameName}** — nouveau code : \`${m.code}\`\n${m.text.split('\n').slice(1).join('\n')}`.slice(0, 1900) }, fetchImpl, 'discord'));
    const t = cfg.telegram;
    if (t?.enabled && env[t.tokenEnv] && env[t.chatIdEnv]) jobs.push(post(`https://api.telegram.org/bot${env[t.tokenEnv]}/sendMessage`, { chat_id: env[t.chatIdEnv], text: m.text, disable_web_page_preview: true }, fetchImpl, 'telegram'));
    const n = cfg.ntfy;
    if (n?.enabled && env[n.topicEnv]) jobs.push(post(n.server || 'https://ntfy.sh', { topic: env[n.topicEnv], title: m.title, message: m.text, tags: ['video_game'], ...(m.url ? { click: m.url } : {}) }, fetchImpl, 'ntfy'));
    for (const r of await Promise.allSettled(jobs)) r.status === 'fulfilled' ? sent++ : errors.push(String(r.reason?.message || r.reason).replace(/bot\d+:[\w-]+/g, 'bot***'));
  }
  return { sent, errors };
}
