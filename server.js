const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Store uploaded files in memory (no disk I/O needed)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
  console.error('\n❌ 錯誤：尚未在 .env 或 .env.local 設定 GEMINI_API_KEY');
  console.error('   可到 https://aistudio.google.com/apikey 取得金鑰\n');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Model fallback chain. Override via GEMINI_MODELS in .env.local if a key has different access.
const DEFAULT_MODEL_CHAIN = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];
const MODEL_CHAIN = (process.env.GEMINI_MODELS || DEFAULT_MODEL_CHAIN.join(','))
  .split(',').map(m => m.trim()).filter(Boolean);

console.log('Model fallback chain:', MODEL_CHAIN.join(' → '));

function hasGeminiApiKey() {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here');
}

function getModel(modelName, tools) {
  return genAI.getGenerativeModel({ model: modelName, ...(tools ? { tools } : {}) });
}

function getModelOrder(preferredModel) {
  if (!preferredModel || !MODEL_CHAIN.includes(preferredModel)) return MODEL_CHAIN;
  return [preferredModel, ...MODEL_CHAIN.filter(modelName => modelName !== preferredModel)];
}

// Try each model in order until one succeeds
async function ask(prompt, tools, preferredModel) {
  let lastErr;
  const modelOrder = getModelOrder(preferredModel);
  for (const modelName of modelOrder) {
    try {
      const model = getModel(modelName, tools);
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      if (modelOrder.indexOf(modelName) > 0) {
        console.log(`⚡ Fell back to ${modelName}`);
      }
      return { text, model: modelName };
    } catch (err) {
      const reason = err.message?.match(/\[(\d{3}[^\]]*)\]/)?.[1] || err.message?.slice(0, 60);
      console.warn(`⚠️  ${modelName} failed (${reason}) — trying next model…`);
      lastErr = err;
    }
  }
  throw lastErr;
}

async function askWithSearch(prompt, preferredModel) {
  return ask(prompt, [{ googleSearch: {} }], preferredModel);
}

function getPublicAiError(err) {
  const message = err?.message || String(err);
  if (/API_KEY_INVALID|API key not valid|invalid api key/i.test(message)) {
    return 'Gemini API 金鑰無效，請更新 .env.local 或 .env 內的 GEMINI_API_KEY。';
  }
  if (/API_KEY|apiKey|auth|permission|unauthorized/i.test(message)) {
    return 'Gemini API 金鑰未設定或未獲授權，請更新 .env.local 或 .env 內的 GEMINI_API_KEY。';
  }
  return message;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8',
  'Connection': 'close',
};

const JUMP_TIMEOUT_MS = parseInt(process.env.JUMP_TIMEOUT_MS || '25000', 10);
const JUMP_RETRY_COUNT = parseInt(process.env.JUMP_RETRY_COUNT || '4', 10);
const JUMP_PROXY_URL = (process.env.JUMP_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();

let proxyAgentModules;

async function getProxyAgentModules() {
  if (!proxyAgentModules) {
    const [{ HttpsProxyAgent }, { SocksProxyAgent }] = await Promise.all([
      import('https-proxy-agent'),
      import('socks-proxy-agent'),
    ]);
    proxyAgentModules = { HttpsProxyAgent, SocksProxyAgent };
  }
  return proxyAgentModules;
}

async function createJumpAgent(targetUrl) {
  if (!JUMP_PROXY_URL) {
    return targetUrl.startsWith('https:')
      ? new https.Agent({ keepAlive: false })
      : new http.Agent({ keepAlive: false });
  }

  if (/^socks[45]h?:\/\//i.test(JUMP_PROXY_URL)) {
    const { SocksProxyAgent } = await getProxyAgentModules();
    return new SocksProxyAgent(JUMP_PROXY_URL, { keepAlive: false });
  }

  if (/^https?:\/\//i.test(JUMP_PROXY_URL)) {
    const { HttpsProxyAgent } = await getProxyAgentModules();
    return new HttpsProxyAgent(JUMP_PROXY_URL, { keepAlive: false });
  }

  console.warn(`Ignoring unsupported JUMP_PROXY_URL: ${JUMP_PROXY_URL}`);
  return targetUrl.startsWith('https:')
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false });
}

const jumpClient = axios.create({
  headers: HEADERS,
  timeout: JUMP_TIMEOUT_MS,
  responseType: 'text',
  maxRedirects: 3,
  proxy: false,
});

if (JUMP_PROXY_URL) {
  console.log(`JUMP proxy enabled: ${JUMP_PROXY_URL.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@')}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientJumpError(err) {
  const message = err?.message || '';
  return [
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
  ].includes(err?.code)
    || /socket hang up|network socket disconnected|secure TLS connection|TLS|SSL|connection reset|connection closed|timeout/i.test(message);
}

function getJumpErrorMessage(err) {
  const message = err?.message || String(err);
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(message)) {
    return `JUMP 在 ${Math.round(JUMP_TIMEOUT_MS / 1000)} 秒內沒有回應，請稍後再試。`;
  }
  if (isTransientJumpError(err)) {
    return 'JUMP 目前連線不穩或暫時拒絕連線，請稍後再按搜尋重試。';
  }
  return message;
}

async function fetchJumpHtml(url, label = 'JUMP page') {
  let lastErr;
  for (let attempt = 1; attempt <= JUMP_RETRY_COUNT; attempt++) {
    try {
      const agent = await createJumpAgent(url);
      const response = await jumpClient.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
      });
      return response.data;
    } catch (err) {
      lastErr = err;
      if (!isTransientJumpError(err) || attempt === JUMP_RETRY_COUNT) break;
      const delay = 400 * attempt;
      console.warn(`${label} fetch failed (${err.message}); retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw new Error(getJumpErrorMessage(lastErr));
}

// Current model info
app.get('/api/model', (req, res) => {
  res.json({
    primary: MODEL_CHAIN[0],
    chain: MODEL_CHAIN,
    configured: hasGeminiApiKey(),
    status: hasGeminiApiKey() ? 'ready' : 'missing-key',
  });
});

// Search jobs
app.get('/api/search', async (req, res) => {
  try {
    const { q = '', page = 1, industryId = '' } = req.query;
    const params = new URLSearchParams();
    if (q) params.append('Keyword', q);
    if (page > 1) params.append('Page', page);
    if (industryId) params.append('IndustryID', industryId);

    const url = `https://jump.mingpao.com/job/search/Jobs?${params}`;
    const html = await fetchJumpHtml(url, 'JUMP search');
    const $ = cheerio.load(html);

    const jobs = [];
    // Try multiple selectors for job listings
    $('[AdID], [adid], li[data-adid]').each((i, el) => {
      const adId = $(el).attr('adid') || $(el).attr('AdID') || $(el).attr('data-adid');
      if (!adId) return;

      const titleEl = $(el).find('.color_position a, .thum50percent a').first();
      const title = titleEl.text().trim();
      const href = titleEl.attr('href') || '';

      const company = $(el).find('.thum37percent a').first().text().trim()
        || $(el).find('a').filter((j, a) => $(a).text().trim() !== title).first().text().trim();

      const date = $(el).find('.thum13percent').first().text().trim()
        || $(el).find('span, .date, [class*="date"]').last().text().trim();
      const fullHref = href.startsWith('http') ? href : `https://jump.mingpao.com${href}`;

      if (adId && title) {
        jobs.push({ adId, title, company, date, href: fullHref });
      }
    });

    // Also try to get total results count
    const totalText = $('[class*="total"], [class*="count"], .result-count').first().text().trim();
    const totalMatch = totalText.match(/(\d+)/);
    const bodyTotalMatch = $('body').text().match(/Jobs\s+\d+\s*-\s*\d+\s+of\s+(\d+)\s+found/i);
    const total = bodyTotalMatch ? parseInt(bodyTotalMatch[1]) : totalMatch ? parseInt(totalMatch[1]) : jobs.length;

    // Get pagination info
    const currentPage = parseInt(page);
    const hasNextPage = $('a[href*="Page=' + (currentPage + 1) + '"], .next:not(.disabled), [class*="next"]:not(.disabled)').length > 0;

    res.json({ jobs, total, currentPage, hasNextPage });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: getJumpErrorMessage(err) });
  }
});

// Get job detail
app.get('/api/job/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const url = `https://jump.mingpao.com/job/detail/Jobs/2/${id}/`;
    const html = await fetchJumpHtml(url, 'JUMP job detail');
    const $ = cheerio.load(html);

    // Title is in <h1 class='h3'> inside .color_position div
    // Company is in <h1 class="h3 cn_wrap"> or linked via CustNo
    let title = $('div.color_position h1, .color_position h1').first().text().trim();
    if (!title) title = $('h1.h3:not(.cn_wrap)').first().text().trim();
    if (!title) title = $('h1').filter((i, el) => !$(el).hasClass('cn_wrap')).first().text().trim();

    let company = $('h1.cn_wrap').first().text().trim();
    if (!company) company = $('a[href*="CustNo"]').first().text().trim();
    if (!company) company = $('h3').first().text().trim();

    // Extract metadata (salary, location, employment type, etc.)
    const meta = {};
    $('dl dt, [class*="label"], [class*="info"] strong, table th').each((i, el) => {
      const key = $(el).text().trim().replace('：', '').replace(':', '').trim();
      const val = $(el).next().text().trim() || $(el).parent().find('dd, td').last().text().trim();
      if (key && val && val !== key) meta[key] = val;
    });

    // Emails that belong to the portal itself, not the employer
    const PORTAL_EMAILS = /^(jump@mingpao\.com|noreply|sentry|no-reply|example|webmaster|admin@mingpao)/i;

    // Extract contact email — try multiple strategies in order of reliability
    let email = '';

    // 1. mailto: links inside the Enquiries section (most specific)
    $('h5').filter((i, el) => /Enquir|查詢/i.test($(el).text())).each((i, el) => {
      $(el).nextUntil('h5').find('a[href^="mailto:"]').each((j, a) => {
        const candidate = $(a).attr('href').replace('mailto:', '').split('?')[0].trim();
        if (candidate.includes('@') && !PORTAL_EMAILS.test(candidate)) {
          email = candidate; return false;
        }
      });
    });

    // 2. Any mailto: link on the page (excluding portal emails)
    if (!email) {
      $('a[href^="mailto:"]').each((i, el) => {
        const candidate = $(el).attr('href').replace('mailto:', '').split('?')[0].trim();
        if (candidate.includes('@') && !PORTAL_EMAILS.test(candidate)) {
          email = candidate; return false;
        }
      });
    }

    // 3. Plain-text email inside the Enquiries section
    if (!email) {
      $('h5').filter((i, el) => /Enquir|查詢/i.test($(el).text())).each((i, el) => {
        const text = $(el).nextUntil('h5').text();
        const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (match && !PORTAL_EMAILS.test(match[0])) { email = match[0]; return false; }
      });
    }

    // Extract the full enquiries section text (may include postal address, WhatsApp, etc.)
    let enquiries = '';
    $('h5').filter((i, el) => /Enquir|查詢/i.test($(el).text())).each((i, el) => {
      enquiries = $(el).nextUntil('h5').text().replace(/\s+/g, ' ').trim();
      return false;
    });

    // Extract the main job content block (around Descriptions h5)
    // Remove noise elements first
    $('nav, header, footer, script, style, iframe').remove();
    $('h1.cn_wrap').closest('div, section').find('[class*="similar"], [class*="recommend"], [class*="news"]').remove();

    // Try to extract structured sections (h5 with class "title" + following ul)
    const sections = {};
    $('h5.title').each((i, el) => {
      const sectionTitle = $(el).text().trim();
      if (['Login', 'Password', 'Similar', 'Enquiries', '最新'].some(s => sectionTitle.includes(s))) return;
      const items = [];
      // Get content after h5 - could be ul or br-separated li
      let next = $(el).next();
      while (next.length && next.prop('tagName') !== 'H5') {
        next.find('li').each((j, li) => items.push($(li).text().trim()));
        next = next.next();
      }
      if (items.length) sections[sectionTitle] = items;
    });

    // Get focused job body text - extract just the main job ad div
    const jobContentEl = $('h5.title').filter((i, el) => $(el).text().includes('Descriptions') || $(el).text().includes('描述')).closest('div, section, article, .col-xs-12');
    const focusedText = jobContentEl.length
      ? jobContentEl.text().replace(/\s+/g, ' ').trim()
      : '';

    $('[class*="similar"], [class*="news"], [class*="banner"], [class*="course"], [class*="footer"]').remove();
    const bodyText = (focusedText || $('body').text()).replace(/\s+/g, ' ').trim();

    // Try to get structured HTML content
    const contentHtml = $('[class*="content"], [class*="detail"], [class*="desc"], main, article').first().html() || $('body').html();

    res.json({ id, title, company, meta, email, enquiries, sections, bodyText: bodyText.substring(0, 8000), url });
  } catch (err) {
    console.error('Job detail error:', err.message);
    res.status(500).json({ error: getJumpErrorMessage(err) });
  }
});

// Parse job requirements using Claude
app.post('/api/parse', async (req, res) => {
  try {
    const { jobText, title, company, sections, model } = req.body;

    // Build structured content from sections if available
    let structuredContent = '';
    if (sections && Object.keys(sections).length > 0) {
      structuredContent = Object.entries(sections)
        .map(([heading, items]) => `${heading}:\n${items.map(i => `- ${i}`).join('\n')}`)
        .join('\n\n');
    }

    const { text, model: modelUsed } = await ask(`你是一位求職顧問。以下是一則求職廣告的文字內容。請從中提取所有職位要求和資格條件，並以JSON格式回傳。

職位：${title}
公司：${company}

${structuredContent ? `職位結構化內容：\n${structuredContent}\n\n廣告完整文字（備用）：` : '廣告內容：'}
${jobText.substring(0, 4000)}

請以JSON格式回傳，格式如下：
{
  "requirements": [
    {"category": "學歷", "item": "大學學位或以上"},
    {"category": "經驗", "item": "3年以上相關工作經驗"},
    {"category": "技能", "item": "熟悉Microsoft Office"}
  ],
  "responsibilities": ["職責1", "職責2"],
  "contactEmail": "the email address to send the application to — check Enquiries / 查詢 / Contact sections carefully. Return empty string only if truly none found.",
  "schoolAddress": "the full postal address of the school or organisation as stated in the ad (check Enquiries / 查詢 section). Return empty string if not found.",
  "salaryRange": "薪酬範圍 或 空字串",
  "location": "工作地點 或 空字串",
  "applyUrl": "申請連結 或 空字串"
}

只回傳JSON，不要其他文字。`, undefined, model);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { requirements: [], responsibilities: [] };
    res.json({ ...parsed, modelUsed });
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: getPublicAiError(err) });
  }
});

function extractJson(text, fallback) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  return JSON.parse(match[0]);
}

function cleanLetterLine(value, fallback = '') {
  return String(value || fallback)
    .replace(/^[#*\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanParagraph(value) {
  return String(value || '')
    .replace(/^[#*\-\s]+/, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeParagraphs(paragraphs, fallbackText) {
  const items = Array.isArray(paragraphs) ? paragraphs.map(cleanParagraph).filter(Boolean) : [];
  if (items.length >= 3) return items.slice(0, 3);
  if (fallbackText) return [cleanParagraph(fallbackText)].filter(Boolean);
  return [];
}

function getEnglishSalutation(recipient) {
  const line = cleanLetterLine(recipient, 'Hiring Manager');
  if (/sir\/madam/i.test(line)) return 'Dear Sir/Madam:';
  if (/hiring manager/i.test(line)) return 'Dear Hiring Manager:';
  const nameOnly = line.split(',')[0].trim();
  return `Dear ${nameOnly || 'Hiring Manager'}:`;
}

function getChineseRecipient(recipient) {
  return cleanLetterLine(recipient, '招聘負責人')
    .replace(/[：:﹕]$/, '')
    .replace(/道鑒$/, '')
    .trim();
}

function getChineseComplimentaryClose(organization) {
  return /校|學|書院|幼稚園|教育|college|school|kindergarten/i.test(organization)
    ? '教安'
    : '鈞安';
}

function formatCoverLetter({ data, profile, company, address, principal, jobTitle, today, isEnglish }) {
  const name = cleanLetterLine(profile?.name, isEnglish ? '[Your Name]' : '[姓名]');
  const phone = cleanLetterLine(profile?.phone, isEnglish ? '[Phone]' : '[電話]');
  const email = cleanLetterLine(profile?.email, isEnglish ? '[Email]' : '[電郵]');
  const recipient = cleanLetterLine(data.recipient, isEnglish ? (principal || 'Hiring Manager') : (principal || '招聘負責人'));
  const organization = cleanLetterLine(data.organization, company || (isEnglish ? '[Organization]' : '[機構名稱]'));
  const postalAddress = cleanLetterLine(data.address, address || '');
  const subjectTitle = cleanLetterLine(data.subjectTitle, jobTitle || (isEnglish ? '[Position]' : '[職位]'));
  const enclosure = cleanLetterLine(data.enclosure, isEnglish ? 'Resume, Certificates' : '履歷、學歷證明');
  const paragraphs = normalizeParagraphs(data.paragraphs, data.body);

  const recipientBlock = [recipient, organization, postalAddress].filter(Boolean);
  const chineseRecipient = getChineseRecipient(recipient);
  const chineseRecipientBlock = [postalAddress, organization, chineseRecipient].filter(Boolean);
  const chineseClose = getChineseComplimentaryClose(organization);
  const body = paragraphs.join('\n\n');

  if (isEnglish) {
    return [
      name,
      `Tel: ${phone}`,
      `Email: ${email}`,
      '',
      today,
      '',
      ...recipientBlock,
      '',
      getEnglishSalutation(recipient),
      '',
      `Application for the Post of ${subjectTitle}`,
      '',
      body,
      '',
      'Sincerely,',
      name,
      '',
      `Enclosure: ${enclosure}`,
    ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return [
    ...chineseRecipientBlock,
    '',
    `${chineseRecipient}道鑒：`,
    '',
    `應徵${subjectTitle}`,
    '',
    body,
    '',
    '恭祝',
    chineseClose,
    '',
    '申請人',
    `${name} 謹啟`,
    today,
    `電話：${phone}`,
    `電郵：${email}`,
    '',
    `附件：${enclosure}`,
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Generate cover letter
app.post('/api/generate-letter', async (req, res) => {
  try {
    const { jobTitle, company, requirements, responsibilities, profile, address, principal, language = 'zh', model } = req.body;
    const isEnglish = language === 'en';

    const profileText = profile ? `
${isEnglish ? 'Applicant details' : '申請人資料'}：
- ${isEnglish ? 'Name' : '姓名'}：${profile.name || ''}
- ${isEnglish ? 'Phone' : '電話'}：${profile.phone || ''}
- ${isEnglish ? 'Email' : '電郵'}：${profile.email || ''}
- ${isEnglish ? 'Education' : '學歷'}：${profile.education || ''}
- ${isEnglish ? 'Work experience' : '工作經驗'}：${profile.experience || ''}
- ${isEnglish ? 'Skills' : '技能'}：${profile.skills || ''}
- ${isEnglish ? 'Other' : '其他資料'}：${profile.other || ''}
	` : '';

    const requirementsText = (Array.isArray(requirements) ? requirements : [])
      .map(r => `- ${r.category}：${r.item}`)
      .join('\n');

    const today = isEnglish
      ? new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date().toLocaleDateString('zh-HK', { year: 'numeric', month: 'long', day: 'numeric' });

    const prompt = isEnglish
      ? `You are a professional cover letter writer. Return ONLY one valid JSON object. Do not add Markdown, code fences, explanations, or a full letter.

Job requirements:
${requirementsText}

${profileText}

Raw job data:
- Job title: ${jobTitle}
- Organization: ${company}
- Recipient: ${principal || 'Hiring Manager'}
- Address: ${address || ''}

Return this JSON shape exactly:
{
  "recipient": "recipient name and title for the inside address only, e.g. Ms. Lee, Principal, or Hiring Manager. Do not include Dear.",
  "organization": "organization name in natural English",
  "address": "postal address in natural English, or empty string",
  "subjectTitle": "job title only, in natural English",
  "paragraphs": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "enclosure": "comma-separated enclosure list"
}

Rules:
- Write in English only.
- paragraphs must contain exactly 3 focused paragraphs, 200-280 words total.
- Paragraph 1: state interest in the post as seen on JUMP.
- Paragraph 2: match the applicant profile only to the job requirements. Do not narrate the full resume.
- Paragraph 3: express enthusiasm and invite an interview.
- Translate Chinese job title, company, address, subjects, and qualifications into natural English.
- Enclosure should list only documents requested by the job post or normally needed, such as Resume, Certificates, and Reference Letters.`
      : `你是一位專業求職信撰寫顧問。請只回傳一個有效 JSON object，不要輸出 Markdown、code fence、解釋或完整信件。

原始職位資料如下。這些資料可能含有英文，請在輸出時全部本地化為自然、正確的繁體中文：
- 原始職位名稱：${jobTitle}
- 原始機構／學校名稱：${company}
- 原始收件人／負責人：${principal || '招聘負責人'}
- 原始地址：${address || ''}

請嚴格回傳以下 JSON 形狀：
{
  "recipient": "繁體中文收信人姓名及職銜，例如「李校長」。不要加入「道鑒」、「敬啟者」或標點；不知道姓名時用「招聘負責人」",
  "organization": "繁體中文機構／學校名稱；如官方名稱只有英文，保留正式英文名稱並加上合適中文類別，例如「學校」",
  "address": "繁體中文香港地址；如沒有可靠地址則用空字串",
  "subjectTitle": "繁體中文職位名稱，不要包含「應徵」或「一職」",
  "paragraphs": ["第一段", "第二段", "第三段"],
  "enclosure": "附件清單，例如「履歷、學歷證明、工作證明」"
}

職位要求：
${requirementsText}

${profileText}

撰寫規則：
- 全文必須使用繁體中文。
- 所有可翻譯內容都必須轉成繁體中文，包括職位名稱、機構／學校名稱、地址、收件人職銜、職位要求、學歷、工作經驗、技能和附件。
- 不要在中文求職信中保留英文地址、英文職位資料或英文履歷描述；但姓名、電郵、網址、電話、證書／學位正式英文名稱，以及沒有正式中文譯名的專有名稱可以保留。
- 香港地址請使用自然中文格式，例如「香港九龍觀塘……」或「香港新界沙田……」，不要輸出 "Hong Kong", "Kowloon", "New Territories", "Road", "Street", "Floor" 這類英文地址詞。
- paragraphs 必須剛好有 3 段，總長約 350 至 500 個中文字。
- 第一段：說明從 JUMP 得悉職位並有意應徵。
- 第二段：根據職位要求逐點比對申請人資料，只提及與要求直接相關的經驗、學歷或技能；不要重複整份履歷。
- 第三段：表達期望面試及感謝考慮。
- 附件只列出招聘廣告明確要求或通常需要的文件，例如「履歷、學歷證明、工作證明」。不要加入廣告沒有提及且不合理的附件。
- 輸出前自行檢查一次：若收件人、地址、職位、機構資料或內文仍含可翻譯的英文，請先改成繁體中文再輸出。
- 語氣正式、誠懇、自信，適合香港學校或機構招聘場合。`;

    const { text, model: modelUsed } = await ask(prompt, undefined, model);
    const structured = extractJson(text, {});
    const letterText = formatCoverLetter({
      data: structured,
      profile,
      company,
      address,
      principal,
      jobTitle,
      today,
      isEnglish,
    });

    res.json({ letter: letterText, modelUsed });
  } catch (err) {
    console.error('Letter error:', err.message);
    res.status(500).json({ error: getPublicAiError(err) });
  }
});

// Parse resume (PDF or DOCX) and extract profile info
app.post('/api/parse-resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '尚未上載檔案' });

    const { mimetype, buffer, originalname } = req.file;
    let text = '';

    if (mimetype === 'application/pdf' || originalname.endsWith('.pdf')) {
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      originalname.endsWith('.docx')
    ) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      return res.status(400).json({ error: '請上載 PDF 或 Word (.docx) 檔案' });
    }

    if (!text.trim()) return res.status(400).json({ error: '無法從檔案讀取文字' });

    const { text: response, model: modelUsed } = await ask(`You are an expert resume parser. Extract ALL information from this resume completely and accurately.

Resume text:
${text.substring(0, 15000)}

Return ONLY a valid JSON object with these exact fields. Extract every detail — do not summarise or skip anything:
{
  "name": "full name exactly as written",
  "phone": "all phone numbers found, comma-separated if multiple",
  "email": "all email addresses found, comma-separated if multiple",
  "education": "ALL qualifications listed — include every degree, diploma, certificate, institution, major, year, and grade/GPA. List each on a new line.",
  "experience": "FULL work history — for each role include: job title, company name, dates (from–to), location if shown, and ALL responsibilities/achievements listed. Separate each role with a blank line. Do not omit any role or bullet point.",
  "skills": "ALL skills, tools, technologies, software, programming languages, frameworks, and competencies mentioned anywhere in the resume, comma-separated",
  "other": "everything else not captured above: languages spoken with proficiency, professional memberships, licences, certifications, awards, publications, volunteer work, hobbies, references, availability, and any other sections"
}

Rules:
- Extract verbatim where possible — do not paraphrase or shorten
- If a field genuinely has no data, use an empty string
- Return only the JSON object, no markdown fences or other text`, undefined, req.body.model);

    const match = response.match(/\{[\s\S]*\}/);
    const profile = match ? JSON.parse(match[0]) : {};

    res.json({ ...profile, modelUsed });
  } catch (err) {
    console.error('Resume parse error:', err.message);
    res.status(500).json({ error: getPublicAiError(err) });
  }
});

// Look up school/company address and principal/hiring manager name
app.post('/api/lookup', async (req, res) => {
  try {
    const { company, language = 'zh', model } = req.body;
    const isEnglish = language === 'en';
    if (!company) return res.json({ address: '', principal: '' });

    const lookupInstruction = isEnglish
      ? `Search official and reliable pages for the Hong Kong school or organisation named "${company}".`
      : `Search official and reliable Traditional Chinese pages for the Hong Kong school or organisation named "${company}". Prefer the organisation's official Chinese website, official contact page, PDF notices, school profile, or EDB school profile. Use Chinese source wording for address and titles when available; do not merely translate an English result if a Chinese source can be found.`;

    const { text, model: modelUsed } = await askWithSearch(
      `${lookupInstruction}
Find and return ONLY a JSON object with these fields:
{
  "address": "${isEnglish ? 'the full Hong Kong postal address in English (street number, street, district)' : 'the full Hong Kong postal address in Traditional Chinese using natural Hong Kong address wording'}",
  "principal": "${isEnglish ? 'the name and title of the principal, headmaster, CEO, or director (whoever would receive a job application) — e.g. Mr. Chan Tai Man, Principal' : 'the principal, headmaster, CEO, or director name and title in Traditional Chinese if available — e.g. 陳大文校長. If only an English name is available, keep the name but translate the title.'}",
  "banding": "for schools: the DSS/Band 1/Band 2/Band 3 banding — e.g. Band 1, DSS, Direct Subsidy Scheme. Empty string if not a school or unknown.",
  "district": "${isEnglish ? 'the Hong Kong district the school/org is in — e.g. Kwun Tong, Sha Tin. Empty string if unknown.' : 'the Hong Kong district in Traditional Chinese — e.g. 觀塘、沙田. Empty string if unknown.'}",
  "school_type": "${isEnglish ? 'for schools: the type — e.g. Primary School, Secondary School, International School, Kindergarten. Empty string if not a school.' : 'for schools: the type in Traditional Chinese — e.g. 小學、中學、國際學校、幼稚園. Empty string if not a school.'}",
  "founded": "year founded if known, else empty string",
  "website": "official website URL if known, else empty string"
}
If you cannot find reliable information for a field, use an empty string.
${isEnglish ? 'Use English for address, principal title, district, and school_type.' : 'Use Traditional Chinese for address, principal title, district, and school_type. If only English sources exist, infer conservative Chinese address wording only when obvious; otherwise leave uncertain fields empty.'}
Return only the JSON, no other text.`,
      model
    );

    const match = text.match(/\{[\s\S]*\}/);
    const data = match ? JSON.parse(match[0]) : { address: '', principal: '' };
    res.json({ ...data, modelUsed });
  } catch (err) {
    console.error('Lookup error:', err.message);
    // Non-fatal — return empty so the app keeps working
    res.json({ address: '', principal: '' });
  }
});

// Local dev: start the server. Vercel imports this file as a module and uses
// the exported `app` directly — it does not call listen().
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Job Finder running at http://localhost:${PORT}`));
}

module.exports = app;
