# ⚽ Football Scout IA

Sistema de análise de futebol com **1 clique**, powered by **Groq + Web Search**.

## Como funciona

1. Você clica em **"Buscar Oportunidades do Dia"**
2. A Groq navega na internet e busca todos os jogos do dia
3. Para cada jogo, pesquisa os últimos 5 resultados de cada time
4. Calcula um **Score de Assertividade** (0–100)
5. Exibe apenas os jogos com score acima do seu filtro

---

## Instalação passo a passo

### 1. Pré-requisito: Node.js
Acesse https://nodejs.org e instale a versão LTS (18+)

### 2. Clone ou copie a pasta do projeto
```bash
cd football-scout
```

### 3. Instale as dependências
```bash
npm install
```

### 4. Configure sua chave da Groq
Copie o `.env.example` para `.env` na raiz do projeto e preencha (as chaves ficam só no servidor):
```
GROQ_KEY=sua_chave_aqui
```

Para obter a chave gratuita:
- Acesse https://console.groq.com
- Crie uma conta
- Vá em **API Keys** → **Create API Key**
- Cole a chave no `.env`

### 5. Rode o sistema
```bash
npm run dev
```

Acesse no navegador: **http://localhost:5173**

---

## Estrutura do projeto

```
football-scout/
├── src/
│   ├── components/
│   │   ├── GameCard.jsx      # Card de cada jogo com análise
│   │   ├── LoadingScreen.jsx # Tela animada durante análise
│   │   └── ScoreRing.jsx     # Anel circular do score
│   ├── services/
│   │   └── groqService.js    # Motor: prompts + chamadas à API Groq
│   ├── styles/
│   │   └── global.css        # Estilos globais
│   ├── App.jsx               # Componente principal
│   └── main.jsx              # Entrada React
├── .env.example              # Modelo do arquivo de chave
├── .env                      # Sua chave (não commitar!)
├── index.html
├── package.json
└── vite.config.js
```

---

## Filtros disponíveis

| Filtro | Descrição |
|--------|-----------|
| Campeonatos | Escolha quais ligas analisar |
| Score mínimo | Só mostra jogos acima deste valor |

## Score de Assertividade

| Score | Qualidade |
|-------|-----------|
| 75–100 | 🟢 Alta confiança |
| 60–74 | 🟡 Boa oportunidade |
| <60 | 🔴 Marginal |

---

## ⚠️ Aviso

Este sistema é para fins **informativos e educacionais**. Apostas esportivas envolvem risco. Use com responsabilidade.
