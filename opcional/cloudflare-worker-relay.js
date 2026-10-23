// Cloudflare Worker — relay para o SofaScore (Opção B, grátis)
// 1) dash.cloudflare.com → Workers & Pages → Create → Worker → cole este código → Deploy
// 2) Settings → Variables → adicione RELAY_KEY (um segredo qualquer, ex: 32 letras aleatórias)
// 3) No Railway: SOFA_BASE_URL = https://SEU-WORKER.workers.dev/api/v1   e   SOFA_RELAY_KEY = o mesmo segredo
export default {
  async fetch(request, env) {
    if (env.RELAY_KEY && request.headers.get('x-relay-key') !== env.RELAY_KEY) {
      return new Response('forbidden', { status: 403 })
    }
    const url = new URL(request.url)
    const alvo = 'https://api.sofascore.com' + url.pathname + url.search
    const r = await fetch(alvo, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com',
      },
    })
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } })
  },
}
