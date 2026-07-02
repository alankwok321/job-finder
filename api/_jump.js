const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');

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

function parseSearchHtml(html, page) {
  const $ = cheerio.load(html);
  const jobs = [];

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

    if (adId && title) jobs.push({ adId, title, company, date, href: fullHref });
  });

  const totalText = $('[class*="total"], [class*="count"], .result-count').first().text().trim();
  const totalMatch = totalText.match(/(\d+)/);
  const bodyTotalMatch = $('body').text().match(/Jobs\s+\d+\s*-\s*\d+\s+of\s+(\d+)\s+found/i);
  const total = bodyTotalMatch ? parseInt(bodyTotalMatch[1]) : totalMatch ? parseInt(totalMatch[1]) : jobs.length;
  const currentPage = parseInt(page, 10) || 1;
  const hasNextPage = $('a[href*="Page=' + (currentPage + 1) + '"], .next:not(.disabled), [class*="next"]:not(.disabled)').length > 0;

  return { jobs, total, currentPage, hasNextPage };
}

function parseJobHtml(html, id, url) {
  const $ = cheerio.load(html);

  let title = $('div.color_position h1, .color_position h1').first().text().trim();
  if (!title) title = $('h1.h3:not(.cn_wrap)').first().text().trim();
  if (!title) title = $('h1').filter((i, el) => !$(el).hasClass('cn_wrap')).first().text().trim();

  let company = $('h1.cn_wrap').first().text().trim();
  if (!company) company = $('a[href*="CustNo"]').first().text().trim();
  if (!company) company = $('h3').first().text().trim();

  const meta = {};
  $('dl dt, [class*="label"], [class*="info"] strong, table th').each((i, el) => {
    const key = $(el).text().trim().replace('：', '').replace(':', '').trim();
    const val = $(el).next().text().trim() || $(el).parent().find('dd, td').last().text().trim();
    if (key && val && val !== key) meta[key] = val;
  });

  const PORTAL_EMAILS = /^(jump@mingpao\.com|noreply|sentry|no-reply|example|webmaster|admin@mingpao)/i;
  let email = '';

  $('h5').filter((i, el) => /Enquir|查詢/i.test($(el).text())).each((i, el) => {
    $(el).nextUntil('h5').find('a[href^="mailto:"]').each((j, a) => {
      const candidate = $(a).attr('href').replace('mailto:', '').split('?')[0].trim();
      if (candidate.includes('@') && !PORTAL_EMAILS.test(candidate)) {
        email = candidate;
        return false;
      }
      return undefined;
    });
  });

  if (!email) {
    $('a[href^="mailto:"]').each((i, el) => {
      const candidate = $(el).attr('href').replace('mailto:', '').split('?')[0].trim();
      if (candidate.includes('@') && !PORTAL_EMAILS.test(candidate)) {
        email = candidate;
        return false;
      }
      return undefined;
    });
  }

  if (!email) {
    $('h5').filter((i, el) => /Enquir|查詢/i.test($(el).text())).each((i, el) => {
      const text = $(el).nextUntil('h5').text();
      const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (match && !PORTAL_EMAILS.test(match[0])) {
        email = match[0];
        return false;
      }
      return undefined;
    });
  }

  let enquiries = '';
  $('h5').filter((i, el) => /Enquir|查詢/i.test($(el).text())).each((i, el) => {
    enquiries = $(el).nextUntil('h5').text().replace(/\s+/g, ' ').trim();
    return false;
  });

  $('nav, header, footer, script, style, iframe').remove();
  $('h1.cn_wrap').closest('div, section').find('[class*="similar"], [class*="recommend"], [class*="news"]').remove();

  const sections = {};
  $('h5.title').each((i, el) => {
    const sectionTitle = $(el).text().trim();
    const items = [];
    let next = $(el).next();
    while (next.length && next.prop('tagName') !== 'H5') {
      next.find('li').each((j, li) => items.push($(li).text().trim()));
      next = next.next();
    }
    if (items.length) sections[sectionTitle] = items;
  });

  const jobContentEl = $('h5.title').filter((i, el) => $(el).text().includes('Descriptions') || $(el).text().includes('描述')).closest('div, section, article, .col-xs-12');
  const focusedText = jobContentEl.length
    ? jobContentEl.text().replace(/\s+/g, ' ').trim()
    : '';

  $('[class*="similar"], [class*="news"], [class*="banner"], [class*="course"], [class*="footer"]').remove();
  const bodyText = (focusedText || $('body').text()).replace(/\s+/g, ' ').trim();

  return { id, title, company, meta, email, enquiries, sections, bodyText: bodyText.substring(0, 8000), url };
}

module.exports = {
  fetchJumpHtml,
  getJumpErrorMessage,
  parseSearchHtml,
  parseJobHtml,
};
