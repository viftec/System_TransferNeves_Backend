// Script para rodar cron job em desenvolvimento local
// Cloudflare Workers cron triggers não funcionam em wrangler dev --local

const CRON_URL = 'http://localhost:8787/scheduled';
const INTERVAL_MS = 60000; // 1 minuto

console.log('🔄 Cron job para desenvolvimento local iniciado');
console.log(`📡 Chamando ${CRON_URL} a cada ${INTERVAL_MS / 1000} segundos`);

async function runCron() {
  try {
    const response = await fetch(CRON_URL);
    const data = await response.json();
    
    if (data.success) {
      console.log(`✅ ${data.message}`);
    } else {
      console.error('❌ Erro no cron job:', data);
    }
  } catch (error) {
    console.error('❌ Erro ao chamar cron job:', error.message);
  }
}

// Executa imediatamente
runCron();

// Executa a cada intervalo
setInterval(runCron, INTERVAL_MS);
