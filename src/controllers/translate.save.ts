import fs from 'fs/promises';
import path from 'path';

const STATS_FILE_PATH = path.join(__dirname, '../../', 'stats.json');

// Interface para o formato salvo no arquivo
interface StoredStats {
  totalRequests: number;
  successfulTranslations: number;
  failedTranslations: number;
  totalResponseTime: number;
  sourceLanguages: Record<string, number>;
  targetLanguages: Record<string, number>;
  lastUpdated: string;
}

// Função para iniciar o arquivo se não existir
const initializeStats = async () => {
  try {
    await fs.access(STATS_FILE_PATH);
  } catch {
    const initialStats: StoredStats = {
      totalRequests: 0,
      successfulTranslations: 0,
      failedTranslations: 0,
      totalResponseTime: 0,
      sourceLanguages: {},
      targetLanguages: {},
      lastUpdated: new Date().toISOString(),
    };
    await fs.writeFile(STATS_FILE_PATH, JSON.stringify(initialStats, null, 2));
  }
};

// Chama a inicialização ao arrancar o servidor
initializeStats();

// Função para ler as estatísticas
const getStatsData = async (): Promise<StoredStats> => {
  try {
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    await initializeStats();
    return await getStatsData();
  }
};

// Função para atualizar as estatísticas (Sucesso)
const recordSuccess = async (responseTime: number, source: string, target: string) => {
  const stats = await getStatsData();
  
  stats.totalRequests++;
  stats.successfulTranslations++;
  stats.totalResponseTime += responseTime;
  stats.lastUpdated = new Date().toISOString();

  // Atualiza contagem de idiomas
  stats.sourceLanguages[source] = (stats.sourceLanguages[source] || 0) + 1;
  stats.targetLanguages[target] = (stats.targetLanguages[target] || 0) + 1;

  await fs.writeFile(STATS_FILE_PATH, JSON.stringify(stats, null, 2));
};

// Função para atualizar as estatísticas (Falha)
const recordFailure = async () => {
  const stats = await getStatsData();
  stats.totalRequests++;
  stats.failedTranslations++;
  stats.lastUpdated = new Date().toISOString();
  await fs.writeFile(STATS_FILE_PATH, JSON.stringify(stats, null, 2));
};

export { getStatsData, recordSuccess, recordFailure };
