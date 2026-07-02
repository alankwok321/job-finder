const { fetchJumpHtml, getJumpErrorMessage, parseSearchHtml } = require('./_jump');

module.exports = async function handler(req, res) {
  try {
    const { q = '', page = 1, industryId = '' } = req.query;
    const params = new URLSearchParams();
    if (q) params.append('Keyword', q);
    if (page > 1) params.append('Page', page);
    if (industryId) params.append('IndustryID', industryId);

    const url = `https://jump.mingpao.com/job/search/Jobs?${params}`;
    const html = await fetchJumpHtml(url, 'JUMP search');
    res.status(200).json(parseSearchHtml(html, page));
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: getJumpErrorMessage(err) });
  }
};
