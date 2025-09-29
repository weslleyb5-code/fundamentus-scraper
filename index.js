/**
 * fundamentus-scraper (Node.js + Playwright)
 *
 * - Executa em GitHub Actions
 * - Extrai a tabela do Fundamentus (tabela que contenha o header "Papel")
 * - Atualiza a Google Sheet (service account)
 *
 * Variáveis de ambiente (definir em GitHub Secrets):
 * - SERVICE_ACCOUNT_JSON  -> o JSON inteiro da service account (conteúdo do arquivo .json)
 * - SHEET_ID              -> id da planilha (entre /d/ e /edit)
 * - SHEET_TAB             -> nome da aba (opcional, default "FIIs_Fundamentus")
 *
 * Rodar local: NODE_ENV=ci node index.js
 */

const { chromium } = require('playwright');
const { google } = require('googleapis');

const FUNDAMENTUS_URL = 'https://www.fundamentus.com.br/fii_resultado.php';
const SERVICE_ACCOUNT_JSON = process.env.SERVICE_ACCOUNT_JSON || '';
const SHEET_ID = process.env.SHEET_ID || '';
const SHEET_TAB = process.env.SHEET_TAB || 'FIIs_Fundamentus';

if (!SERVICE_ACCOUNT_JSON || !SHEET_ID) {
  console.error('ERRO: defina SERVICE_ACCOUNT_JSON e SHEET_ID como secrets/variáveis de ambiente.');
  process.exit(1);
}

async function extractTableFromPage(page) {
  // espera pela rede estabilizar; timeout generoso
  try {
    await page.waitForLoadState('networkidle', { timeout: 20000 });
  } catch(e){ /* ignore timeout */ }

  // tenta esperar por texto "Papel" em algum lugar da página
  try {
    await page.waitForSelector('table', { timeout: 10000 });
  } catch(e){ /* fallback continua */ }

  // pega HTML do primeiro table que contenha 'papel' no texto
  const tableHtml = await page.$$eval('table', (tables) => {
    for (const t of tables) {
      try {
        if (t.innerText && t.innerText.toLowerCase().includes('papel')) {
          return t.outerHTML;
        }
      } catch(e){}
    }
    // fallback: retorna o primeiro table
    if (tables.length > 0) return tables[0].outerHTML;
    return null;
  });

  return tableHtml;
}

function parseTableHtmlToArray(tableHtml) {
  if (!tableHtml) return [];
  const rows = [];
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tableHtml)) !== null) {
    const trHtml = tr[0];
    const cellRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
    const cells = [];
    let cell;
    while ((cell = cellRe.exec(trHtml)) !== null) {
      let inner = cell[2] || '';
      // remove tags internas e normaliza espaços
      inner = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      cells.push(inner);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

async function writeToGoogleSheet(values) {
  const creds = JSON.parse(SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // checa se a aba existe; se não, cria
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetsMeta = meta.data.sheets || [];
  const found = sheetsMeta.find(s => s.properties && s.properties.title === SHEET_TAB);
  if (!found) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TAB } } }]
      }
    });
  }

  // escreve valores (sobrescreve)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: values }
  });
}

(async () => {
  console.log('Iniciando Playwright...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    });
    const page = await context.newPage();

    // Navega e aguarda
    await page.goto(FUNDAMENTUS_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // tenta clicar no botão de filtro se existir (algumas versões exigem clique)
    const buttonTexts = ['Filtrar', 'Gerar', 'Buscar', 'Pesquisar', 'Aplicar filtros'];
    for (const t of buttonTexts) {
      try {
        const btn = await page.$(`button:has-text("${t}")`);
        if (btn) {
          await btn.click().catch(()=>{});
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(()=>{});
          break;
        }
      } catch(e){}
    }

    const tableHtml = await extractTableFromPage(page);
    if (!tableHtml) {
      console.error('Tabela não encontrada — salvando debug.html e screenshot.');
      const html = await page.content();
      console.log('HTML_LENGTH:' + html.length);
      // imprime parte do HTML no log para inspeção
      console.log(html.substring(0, 2000));
      process.exit(2);
    }

    const tableArray = parseTableHtmlToArray(tableHtml);
    if (!tableArray || tableArray.length === 0) {
      console.error('Falha ao parsear tabela.');
      process.exit(3);
    }

    console.log('Linhas extraídas:', tableArray.length);

    // grava no Google Sheets
    await writeToGoogleSheet(tableArray);
    console.log('Dados gravados no Sheet:', SHEET_ID, 'aba:', SHEET_TAB);

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Erro na execução:', err);
    await browser.close().catch(()=>{});
    process.exit(4);
  }
})();
