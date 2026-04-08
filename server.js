require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Store uploaded files in memory (no disk I/O needed)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
  console.error('\n❌ ERROR: GEMINI_API_KEY not set in .env file');
  console.error('   Get a free key at https://aistudio.google.com/apikey\n');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
// Search-grounded model for looking up school info (needs search tool)
const geminiSearch = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
  tools: [{ googleSearch: {} }]
});

async function ask(prompt) {
  const result = await gemini.generateContent(prompt);
  return result.response.text();
}

async function askWithSearch(prompt) {
  const result = await geminiSearch.generateContent(prompt);
  return result.response.text();
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// Search jobs
app.get('/api/search', async (req, res) => {
  try {
    const { q = '', page = 1, industryId = '' } = req.query;
    const params = new URLSearchParams();
    if (q) params.append('Keyword', q);
    if (page > 1) params.append('Page', page);
    if (industryId) params.append('IndustryID', industryId);

    const url = `https://jump.mingpao.com/job/search/Jobs?${params}`;
    const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(response.data);

    const jobs = [];
    // Try multiple selectors for job listings
    $('[AdID], [adid], li[data-adid]').each((i, el) => {
      const adId = $(el).attr('adid') || $(el).attr('AdID') || $(el).attr('data-adid');
      if (!adId) return;

      const titleEl = $(el).find('a').first();
      const title = titleEl.text().trim();
      const href = titleEl.attr('href') || '';

      // Extract company - usually second anchor or a specific class
      const anchors = $(el).find('a');
      let company = '';
      anchors.each((j, a) => {
        const text = $(a).text().trim();
        if (j > 0 && text && text !== title) {
          company = text;
          return false;
        }
      });

      const date = $(el).find('span, .date, [class*="date"]').last().text().trim();
      const fullHref = href.startsWith('http') ? href : `https://jump.mingpao.com${href}`;

      if (adId && title) {
        jobs.push({ adId, title, company, date, href: fullHref });
      }
    });

    // Also try to get total results count
    const totalText = $('[class*="total"], [class*="count"], .result-count').first().text().trim();
    const totalMatch = totalText.match(/\d+/);
    const total = totalMatch ? parseInt(totalMatch[0]) : jobs.length;

    // Get pagination info
    const currentPage = parseInt(page);
    const hasNextPage = $('a[href*="Page=' + (currentPage + 1) + '"], .next:not(.disabled), [class*="next"]:not(.disabled)').length > 0;

    res.json({ jobs, total, currentPage, hasNextPage });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get job detail
app.get('/api/job/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const url = `https://jump.mingpao.com/job/detail/Jobs/2/${id}/`;
    const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(response.data);

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

    // Extract contact email
    let email = '';
    $('a[href^="mailto:"]').each((i, el) => {
      email = $(el).attr('href').replace('mailto:', '').trim();
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

    res.json({ id, title, company, meta, email, sections, bodyText: bodyText.substring(0, 8000), url });
  } catch (err) {
    console.error('Job detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Parse job requirements using Claude
app.post('/api/parse', async (req, res) => {
  try {
    const { jobText, title, company, sections } = req.body;

    // Build structured content from sections if available
    let structuredContent = '';
    if (sections && Object.keys(sections).length > 0) {
      structuredContent = Object.entries(sections)
        .map(([heading, items]) => `${heading}:\n${items.map(i => `- ${i}`).join('\n')}`)
        .join('\n\n');
    }

    const text = await ask(`你是一位求職顧問。以下是一則求職廣告的文字內容。請從中提取所有職位要求和資格條件，並以JSON格式回傳。

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
  "contactEmail": "email@example.com 或 空字串",
  "salaryRange": "薪酬範圍 或 空字串",
  "location": "工作地點 或 空字串",
  "applyUrl": "申請連結 或 空字串"
}

只回傳JSON，不要其他文字。`);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { requirements: [], responsibilities: [] };
    res.json(parsed);
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate cover letter using Claude
app.post('/api/generate-letter', async (req, res) => {
  try {
    const { jobTitle, company, requirements, responsibilities, profile, address, principal } = req.body;

    const profileText = profile ? `
Applicant details:
- Name: ${profile.name || ''}
- Education: ${profile.education || ''}
- Work experience: ${profile.experience || ''}
- Skills: ${profile.skills || ''}
- Other: ${profile.other || ''}
` : '';

    const recipientText = principal
      ? `Recipient: ${principal}`
      : `Recipient: Hiring Manager`;

    const requirementsText = requirements
      .map(r => `- ${r.category}：${r.item}`)
      .join('\n');

    const letter = await ask(`You are a professional cover letter writer. Write a formal English cover letter based on the job requirements and applicant profile below.

Position: ${jobTitle}
Company: ${company}
${address ? `Company address: ${address}` : ''}
${recipientText}

Job Requirements:
${requirementsText}

Responsibilities:
${responsibilities.slice(0, 5).join('\n')}

${profileText}

Write a professional English cover letter that includes:
1. Applicant's name and contact details at the top (use placeholders if not provided)
2. Today's date
3. The company name${address ? ` and address on a single line: "${address}"` : ''}
4. Salutation using only the recipient's surname (e.g. "Dear Mr Tam," not the full name) — if no principal provided, use "Dear Hiring Manager,"
5. Opening paragraph stating the position applied for
6. Body paragraphs addressing how the applicant meets each key requirement
7. Expression of genuine interest in the role and company
8. Closing paragraph with call to action

Requirements:
- Written in formal English
- Professional and confident tone
- 300-400 words
- Address must be written on a single line, not split across multiple lines
- Output the cover letter text only, no extra commentary`);

    res.json({ letter: letter.trim() });
  } catch (err) {
    console.error('Letter error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Parse resume (PDF or DOCX) and extract profile info
app.post('/api/parse-resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

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
      return res.status(400).json({ error: 'Please upload a PDF or Word (.docx) file' });
    }

    if (!text.trim()) return res.status(400).json({ error: 'Could not extract text from the file' });

    const response = await ask(`You are a resume parser. Extract the following information from this resume and return it as a JSON object.

Resume text:
${text.substring(0, 6000)}

Return ONLY a JSON object with these exact fields:
{
  "name": "full name of the applicant",
  "education": "highest qualification and institution, e.g. BSc Computer Science, HKU (2020)",
  "experience": "summary of work experience in 2-3 sentences covering roles, years, and key responsibilities",
  "skills": "comma-separated list of key skills, tools, languages",
  "other": "any other relevant info such as languages spoken, certifications, availability, driving licence"
}

Rules:
- If a field cannot be found, use an empty string
- Keep each field concise but informative
- Return only the JSON, no other text`);

    const match = response.match(/\{[\s\S]*\}/);
    const profile = match ? JSON.parse(match[0]) : {};
    res.json(profile);
  } catch (err) {
    console.error('Resume parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Look up school/company address and principal/hiring manager name
app.post('/api/lookup', async (req, res) => {
  try {
    const { company } = req.body;
    if (!company) return res.json({ address: '', principal: '' });

    const text = await askWithSearch(
      `Search for the Hong Kong organisation named "${company}".
Find and return ONLY a JSON object with these two fields:
{
  "address": "the full Hong Kong address in English",
  "principal": "the name and title of the principal, headmaster, CEO, or director (whoever would receive a job application)"
}
If you cannot find reliable information for a field, use an empty string.
Return only the JSON, no other text.`
    );

    const match = text.match(/\{[\s\S]*\}/);
    const data = match ? JSON.parse(match[0]) : { address: '', principal: '' };
    res.json(data);
  } catch (err) {
    console.error('Lookup error:', err.message);
    // Non-fatal — return empty so the app keeps working
    res.json({ address: '', principal: '' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Job Finder running at http://localhost:${PORT}`));
