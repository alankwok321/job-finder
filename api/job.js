const { fetchJumpHtml, getJumpErrorMessage, parseJobHtml } = require('./_jump');

module.exports = async function handler(req, res) {
  try {
    const id = req.query.id || String(req.url || '').match(/\/api\/job\/([^/?]+)/)?.[1];
    if (!id) return res.status(400).json({ error: 'Missing job id' });

    const url = `https://jump.mingpao.com/job/detail/Jobs/2/${id}/`;
    const html = await fetchJumpHtml(url, 'JUMP job detail');
    return res.status(200).json(parseJobHtml(html, id, url));
  } catch (err) {
    console.error('Job detail error:', err.message);
    return res.status(500).json({ error: getJumpErrorMessage(err) });
  }
};
