// server/scrapers/weatherScraper.js
// Clima do estádio do mandante na data do jogo — via Open-Meteo (gratuito,
// sem necessidade de chave de API).
// Cobertura: mapa fixo de coordenadas dos estádios dos principais clubes
// (os mesmos que já têm peso de relevância no groqService). Para times fora
// desse mapa, a função degrada para null (sem clima) em vez de arriscar um
// palpite de localização errado.
// ─────────────────────────────────────────────────────────────

const ESTADIOS = {
  // Brasileirão
  'flamengo':            { lat: -22.9122, lon: -43.2302, nome: 'Maracanã' },
  'fluminense':           { lat: -22.9122, lon: -43.2302, nome: 'Maracanã' },
  'botafogo':             { lat: -22.9122, lon: -43.2302, nome: 'Maracanã / Nilton Santos' },
  'vasco da gama':        { lat: -22.8916, lon: -43.2306, nome: 'São Januário' },
  'palmeiras':            { lat: -23.5274, lon: -46.6789, nome: 'Allianz Parque' },
  'corinthians':          { lat: -23.5449, lon: -46.4742, nome: 'Neo Química Arena' },
  'sao paulo':            { lat: -23.6003, lon: -46.7573, nome: 'Morumbis' },
  'santos':               { lat: -23.9192, lon: -46.3428, nome: 'Vila Belmiro' },
  'gremio':               { lat: -30.0653, lon: -51.2354, nome: 'Arena do Grêmio' },
  'internacional':        { lat: -30.0659, lon: -51.1372, nome: 'Beira-Rio' },
  'atletico mineiro':     { lat: -19.8645, lon: -43.9695, nome: 'Arena MRV' },
  'cruzeiro':             { lat: -19.8663, lon: -43.9694, nome: 'Mineirão' },
  'bahia':                { lat: -12.9469, lon: -38.4483, nome: 'Arena Fonte Nova' },
  'bragantino':           { lat: -22.9581, lon: -46.5389, nome: 'Nabi Abi Chedid' },
  'vitoria':              { lat: -12.9466, lon: -38.4478, nome: 'Barradão' },
  'mirassol':             { lat: -20.8181, lon: -49.5222, nome: 'Campos Maia' },
  'coritiba':             { lat: -25.4514, lon: -49.2447, nome: 'Couto Pereira' },
  // Europa
  'real madrid':          { lat: 40.4531, lon: -3.6883,  nome: 'Santiago Bernabéu' },
  'barcelona':            { lat: 41.3809, lon: 2.1228,   nome: 'Spotify Camp Nou' },
  'manchester city':      { lat: 53.4831, lon: -2.2004,  nome: 'Etihad Stadium' },
  'manchester united':    { lat: 53.4631, lon: -2.2913,  nome: 'Old Trafford' },
  'liverpool':            { lat: 53.4308, lon: -2.9608,  nome: 'Anfield' },
  'chelsea':              { lat: 51.4816, lon: -0.1909,  nome: 'Stamford Bridge' },
  'arsenal':              { lat: 51.5549, lon: -0.1084,  nome: 'Emirates Stadium' },
  'tottenham hotspur':    { lat: 51.6043, lon: -0.0663,  nome: 'Tottenham Hotspur Stadium' },
  'bayern munich':        { lat: 48.2188, lon: 11.6247,  nome: 'Allianz Arena' },
  'borussia dortmund':    { lat: 51.4926, lon: 7.4517,   nome: 'Signal Iduna Park' },
  // Bundesliga (demais clubes)
  'rb leipzig':           { lat: 51.3458, lon: 12.3483,  nome: 'Red Bull Arena' },
  'bayer leverkusen':     { lat: 51.0382, lon: 7.0022,   nome: 'BayArena' },
  'eintracht frankfurt':  { lat: 50.0684, lon: 8.6455,   nome: 'Deutsche Bank Park' },
  'vfl wolfsburg':        { lat: 52.4325, lon: 10.8039,  nome: 'Volkswagen Arena' },
  'vfb stuttgart':        { lat: 48.7925, lon: 9.2320,   nome: 'MHPArena' },
  'sc freiburg':          { lat: 47.9925, lon: 7.8955,   nome: 'Europa-Park Stadion' },
  'union berlin':         { lat: 52.4576, lon: 13.5669,  nome: 'Stadion An der Alten Försterei' },
  'werder bremen':        { lat: 53.0665, lon: 8.8377,   nome: 'Weserstadion' },
  'mainz 05':             { lat: 49.9843, lon: 8.2246,   nome: 'Mewa Arena' },
  'borussia monchengladbach': { lat: 51.1746, lon: 6.3859, nome: 'Borussia-Park' },
  'tsg hoffenheim':       { lat: 49.2381, lon: 8.8878,   nome: 'PreZero Arena' },
  'fc augsburg':          { lat: 48.3235, lon: 10.8863,  nome: 'WWK Arena' },
  '1. fc heidenheim':     { lat: 48.6839, lon: 10.1462,  nome: 'Voith-Arena' },
  'vfl bochum':           { lat: 51.4903, lon: 7.2364,   nome: 'Vonovia Ruhrstadion' },
  'fc st. pauli':         { lat: 53.5547, lon: 9.9672,   nome: 'Millerntor-Stadion' },
  'holstein kiel':        { lat: 54.3397, lon: 10.1275,  nome: 'Holstein-Stadion' },
  'paris saint-germain':  { lat: 48.8414, lon: 2.2530,   nome: 'Parc des Princes' },
  'juventus':             { lat: 45.1096, lon: 7.6413,   nome: 'Allianz Stadium' },
  'inter milan':          { lat: 45.4781, lon: 9.1240,   nome: 'San Siro' },
  'ac milan':             { lat: 45.4781, lon: 9.1240,   nome: 'San Siro' },
  'atletico de madrid':   { lat: 40.4362, lon: -3.5995,  nome: 'Cívitas Metropolitano' },
  // Libertadores
  'boca juniors':         { lat: -34.6356, lon: -58.3648, nome: 'La Bombonera' },
  'river plate':          { lat: -34.5453, lon: -58.4497, nome: 'Monumental' },
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}

function buscarEstadio(nomeTime) {
  const n = norm(nomeTime)
  if (ESTADIOS[n]) return ESTADIOS[n]
  for (const [key, val] of Object.entries(ESTADIOS)) {
    if (n.includes(key)) return val
  }
  return null
}

// dataJogoISO: 'YYYY-MM-DD' (ou string que comece assim)
// Faixas de altitude usadas pra classificar o efeito sobre o jogo
// (bola voa mais longe / cansaço maior em altitudes elevadas).
function classificarAltitude(m) {
  if (m == null) return null
  if (m >= 2000) return 'muito alta'   // ex.: La Paz, Bogotá, Quito
  if (m >= 1000) return 'alta'         // ex.: Cidade do México, Johannesburgo
  if (m >= 500)  return 'moderada'
  return 'baixa'
}

// dataJogoISO: 'YYYY-MM-DD' (ou string que comece assim)
// horaJogoLocal (opcional): 'HH:MM' — horário real do chute inicial, quando disponível.
// Quando ausente, mantém o fallback de 20h local (horário mais comum Brasil/Europa).
export async function getClimaJogo(nomeTimeMandante, dataJogoISO, horaJogoLocal = null) {
  const estadio = buscarEstadio(nomeTimeMandante)
  if (!estadio) return null // fora do mapa — não arrisca palpite de local

  const dataStr = String(dataJogoISO || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) return null

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${estadio.lat}&longitude=${estadio.lon}` +
      `&hourly=temperature_2m,precipitation_probability,windspeed_10m,weathercode` +
      `&timezone=auto&start_date=${dataStr}&end_date=${dataStr}`

    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()

    const horas = data?.hourly?.time ?? []
    if (!horas.length) return null

    // Se recebermos o horário real do jogo, usa ele. Senão, aproxima pra 20h local.
    const horaAlvo = /^\d{2}:\d{2}/.test(horaJogoLocal || '') ? horaJogoLocal.slice(0, 5) : '20:00'
    let idx = horas.findIndex(h => h.endsWith(`T${horaAlvo}`))
    if (idx === -1) idx = horas.findIndex(h => h.endsWith('T20:00'))
    if (idx === -1) idx = Math.floor(horas.length / 2)

    // Open-Meteo já devolve a elevação (altitude) do ponto consultado —
    // não precisa de outra API pra isso.
    const altitudeM = typeof data?.elevation === 'number' ? Math.round(data.elevation) : null

    return {
      estadio:            estadio.nome,
      temperaturaC:        data.hourly.temperature_2m?.[idx] ?? null,
      probabilidadeChuva:  data.hourly.precipitation_probability?.[idx] ?? null,
      ventoKmh:            data.hourly.windspeed_10m?.[idx] ?? null,
      altitudeM,
      altitudeClasse:      classificarAltitude(altitudeM),
      fonte: 'open-meteo',
      aproximado: !/^\d{2}:\d{2}/.test(horaJogoLocal || ''), // true = usou horário estimado, não o real
    }
  } catch (err) {
    console.warn('[Weather] falhou:', err.message)
    return null
  }
}
