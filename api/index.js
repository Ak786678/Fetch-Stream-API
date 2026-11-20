
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const PORT = process.env.PORT || 3000;

const ANIMESALT_BASE = 'https://animesalt.cx';
const TOONSTREAM_BASE = 'https://toonstream.vip';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const PROVIDERS = {
  AnimeSalt: {
    base: ANIMESALT_BASE,
    host: new URL(ANIMESALT_BASE).hostname
  },
  ToonStream: {
    base: TOONSTREAM_BASE,
    host: new URL(TOONSTREAM_BASE).hostname
  }
};

const client = axios.create({
  timeout: 12000,
  maxRedirects: 0,
  responseType: 'text',
  maxContentLength: 3 * 1024 * 1024,
  validateStatus: status => status >= 200 && status < 300
});

async function fetchProviderResponse(url, provider) {
  let currentUrl = providerUrl(url, provider);

  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await client.get(currentUrl, {
      headers: getHeaders(provider.base),
      validateStatus: status =>
        (status >= 200 && status < 300) ||
        [301, 302, 303, 307, 308].includes(status)
    });

    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    const location = response.headers.location;

    if (!location) {
      throw new Error('Provider redirect has no destination');
    }

    // Validate every redirect before making another request.
    // This prevents the API from following redirects to
    // arbitrary external hosts.
    const redirectUrl = new URL(location, currentUrl);

console.log('PROVIDER REDIRECT:', {
  from: new URL(currentUrl).hostname,
  to: redirectUrl.hostname,
  path: redirectUrl.pathname,
  status: response.status
});

currentUrl = providerUrl(
  redirectUrl.toString(),
  provider
);
  }

  throw new Error('Too many provider redirects');
}

function getHeaders(base) {
  return {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'KISSKHTV-FetchStream/2.0',
    Referer: base + '/'
  };
}

function errorMessage(error) {
  if (error.response?.status === 403) {
    return 'Provider returned HTTP 403 Forbidden';
  }
  if (error.response?.status === 429) {
    return 'Provider rate limit exceeded';
  }
  if (error.response?.status) {
    return `Provider returned HTTP ${error.response.status}`;
  }
  if (error.code === 'ECONNABORTED') {
    return 'Provider request timed out';
  }
  return error.message || 'Provider request failed';
}

function safeError(error) {
  return {
    message: errorMessage(error),
    upstream_status: error.response?.status || null
  };
}

function validateQuery(value) {
  if (typeof value !== 'string') return null;
  const query = value.trim();
  return query.length >= 1 && query.length <= 100
    ? query
    : null;
}

function providerUrl(value, provider) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Invalid provider URL');
  }

  let url;

  try {
    url = new URL(value, provider.base);
  } catch (_) {
    throw new Error('Malformed provider URL');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== provider.host ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error('URL must belong to the selected provider');
  }

  return url.toString();
}

async function fetchProviderHtml(url, provider) {
  const response = await fetchProviderResponse(
    url,
    provider
  );

  if (typeof response.data !== 'string') {
    throw new Error('Unexpected provider response');
  }

  return cheerio.load(response.data);
}

function absoluteUrl(value, base) {
  if (!value || typeof value !== 'string') return '';

  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : '';
  } catch (_) {
    return '';
  }
}

function detectType(link, classText = '') {
  if (link.includes('/movies/')) return 'movie';
  if (classText.includes('type-movies')) return 'movie';
  return 'series';
}

function extractSearchResults($, providerName) {
  const provider = PROVIDERS[providerName];
  const results = [];
  const seen = new Set();

  $('ul.post-lst li').each((index, element) => {
    const item = $(element);
    const classText = item.attr('class') || '';

    const title = item.find(
      'h2.entry-title, h3.entry-title, .entry-title'
    ).first().text().trim();

    const rawLink = item.find(
      'a.lnk-blk, a[href]'
    ).first().attr('href');

    const link = absoluteUrl(rawLink, provider.base);

    const image = absoluteUrl(
      item.find('img').first().attr('data-src') ||
      item.find('img').first().attr('src'),
      provider.base
    );

    if (!title || !link || seen.has(link)) return;

    try {
      providerUrl(link, provider);
    } catch (_) {
      return;
    }

    seen.add(link);

    results.push({
      title,
      link,
      image,
      type: detectType(link, classText),
      source: providerName
    });
  });

  return results;
}

async function searchAnimeSalt(query) {
  const provider = PROVIDERS.AnimeSalt;
  const url = `${provider.base}/?s=${encodeURIComponent(query)}`;
  const $ = await fetchProviderHtml(url, provider);
  return extractSearchResults($, 'AnimeSalt');
}

async function searchToonStream(query) {
  const provider = PROVIDERS.ToonStream;
  const url = `${provider.base}/s?q=${encodeURIComponent(query)}`;
  const $ = await fetchProviderHtml(url, provider);
  return extractSearchResults($, 'ToonStream');
}

async function searchProvider(name, query) {
  return name === 'AnimeSalt'
    ? searchAnimeSalt(query)
    : searchToonStream(query);
}

async function runSearch(names, query) {
  const settled = await Promise.allSettled(
    names.map(name => searchProvider(name, query))
  );

  const results = [];
  const providers = {};

  settled.forEach((response, index) => {
    const name = names[index];

    if (response.status === 'fulfilled') {
      results.push(...response.value);

      providers[name] = {
        success: true,
        count: response.value.length
      };
    } else {
      console.error(`${name} search failed`, {
        message: errorMessage(response.reason),
        status: response.reason.response?.status || null
      });

      providers[name] = {
        success: false,
        ...safeError(response.reason)
      };
    }
  });

  return {
    success: settled.some(item => item.status === 'fulfilled'),
    results,
    providers
  };
}

function respondSearch(res, query, result, source = null) {
  const allFailed = !result.success;

  return res.status(allFailed ? 502 : 200).json({
    success: !allFailed,
    ...(source ? { source } : { query }),
    total: result.results.length,
    results: result.results,
    providers: result.providers
  });
}

function extractEpisodes($, providerName) {
  const provider = PROVIDERS[providerName];
  const episodes = [];
  const seasons = [];

  $('.season-btn').each((index, element) => {
    const button = $(element);
    const seasonNum = button.attr('data-season');

    if (!seasonNum) return;

    seasons.push({
      name: button.text().trim(),
      seasonNum,
      ...(providerName === 'AnimeSalt'
        ? { postId: button.attr('data-post') || '' }
        : { ajaxUrl: button.attr('data-url') || '' })
    });
  });

  $('#episode_by_temp li').each((index, element) => {
    const item = $(element);

    const rawLink = item.find('a.lnk-blk').attr('href');
    const link = absoluteUrl(rawLink, provider.base);

    if (!link) return;

    try {
      providerUrl(link, provider);
    } catch (_) {
      return;
    }

    episodes.push({
      epNum: item.find('.num-epi').text().trim() ||
        String(index + 1),
      title: item.find(
        'h2.entry-title, h5.entry-title1, .entry-title'
      ).first().text().trim(),
      link,
      image: absoluteUrl(
        item.find('img').first().attr('data-src') ||
        item.find('img').first().attr('src'),
        provider.base
      ) || null
    });
  });

  return { seasons, episodes };
}

function extractMetadata($, base) {
  return {
    title: $('h1.entry-title, h1').first().text().trim() || null,
    poster_image: absoluteUrl(
      $('.post-thumbnail img').first().attr('data-src') ||
      $('.post-thumbnail img').first().attr('src'),
      base
    ) || null,
    thumbnail_image: absoluteUrl(
      $('.bghd img').first().attr('data-src') ||
      $('.bghd img').first().attr('src'),
      base
    ) || null
  };
}

function extractAnimeSaltStreams($) {
  const streams = [];
  const downloads = [];

  $('#aa-options iframe').each((index, element) => {
    const raw = $(element).attr('src') ||
      $(element).attr('data-src');

    const link = absoluteUrl(raw, ANIMESALT_BASE);

    if (!link) return;

    // Do not decode or resolve embedded player tokens.
    // Return the provider's original embed URL.
    streams.push({
      server: `Server ${index + 1}`,
      language: 'Default',
      link,
      type: 'embed'
    });
  });

  $('#mdl-download .download-links table tbody tr')
    .each((index, element) => {
      const item = $(element);
      const link = absoluteUrl(
        item.find('a').first().attr('href'),
        ANIMESALT_BASE
      );

      if (!link) return;

      downloads.push({
        server: item.find('td').first().text().trim() ||
          'Download',
        language: item.find('td:nth-child(2)').text().trim() ||
          'Default',
        quality: item.find('td:nth-child(3)').text().trim() ||
          'Unknown',
        link
      });
    });

  return { streams, downloads };
}

function extractToonStreamStreams($) {
  const streams = [];
  const downloads = [];
  const serverMap = {};

  $('.video-options .aa-tbs-video li')
    .each((index, element) => {
      const item = $(element);
      const option = item.find('a.btn').attr('href');

      if (option && option.startsWith('#')) {
        serverMap[option.slice(1)] =
          item.find('.server').text().trim() ||
          `Server ${index + 1}`;
      }
    });

  $('.video-player .video').each((index, element) => {
    const item = $(element);
    const id = item.attr('id');

    const link = absoluteUrl(
      item.find('iframe').first().attr('src') ||
      item.find('iframe').first().attr('data-src'),
      TOONSTREAM_BASE
    );

    if (!link) return;

    streams.push({
      server: serverMap[id] || `Server ${index + 1}`,
      link,
      type: 'embed',
      is_bypassed: false
    });
  });

  $('.cyber-modal .links-list .link-row')
    .each((index, element) => {
      const item = $(element);
      const link = absoluteUrl(
        item.find('a.download-btn').attr('href'),
        TOONSTREAM_BASE
      );

      if (!link) return;

      downloads.push({
        server: item.find('.server-name').text().trim() ||
          `Mirror ${index + 1}`,
        link
      });
    });

  return { streams, downloads };
}

function handleProviderError(res, error, operation) {
  console.error(`${operation} failed`, {
    message: errorMessage(error),
    upstream_status: error.response?.status || null
  });

  return res.status(502).json({
    success: false,
    error: `${operation} failed`,
    ...safeError(error)
  });
}

// =======================================
// ROUTES
// =======================================

app.get('/', (req, res) => {
  res.json({
    status: 'Active',
    message: 'FetchStream API is running.',
    version: '2.0.0',
    sources: ['AnimeSalt', 'ToonStream']
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    version: '2.0.0'
  });
});

// Combined search
app.get('/search', async (req, res) => {
  const query = validateQuery(req.query.q);

  if (!query) {
    return res.status(400).json({
      success: false,
      error: 'Valid q parameter is required (1-100 characters)'
    });
  }

  const result = await runSearch(
    ['AnimeSalt', 'ToonStream'],
    query
  );

  return respondSearch(res, query, result);
});

// AnimeSalt search
app.get('/animesalt/search', async (req, res) => {
  const query = validateQuery(req.query.q);

  if (!query) {
    return res.status(400).json({
      success: false,
      error: 'Valid q parameter is required'
    });
  }

  const result = await runSearch(['AnimeSalt'], query);
  return respondSearch(res, query, result, 'AnimeSalt');
});

// ToonStream search
app.get('/toonstream/search', async (req, res) => {
  const query = validateQuery(req.query.q);

  if (!query) {
    return res.status(400).json({
      success: false,
      error: 'Valid q parameter is required'
    });
  }

  const result = await runSearch(['ToonStream'], query);
  return respondSearch(res, query, result, 'ToonStream');
});

// AnimeSalt episodes
app.get('/animesalt/episodes', async (req, res) => {
  try {
    const url = providerUrl(
      req.query.url,
      PROVIDERS.AnimeSalt
    );

    const $ = await fetchProviderHtml(
      url,
      PROVIDERS.AnimeSalt
    );

    return res.json({
      success: true,
      ...extractEpisodes($, 'AnimeSalt')
    });
  } catch (error) {
    if (error.message?.includes('URL')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    return handleProviderError(
      res,
      error,
      'AnimeSalt episodes'
    );
  }
});

// ToonStream episodes
app.get('/toonstream/episodes', async (req, res) => {
  try {
    const url = providerUrl(
      req.query.url,
      PROVIDERS.ToonStream
    );

    const $ = await fetchProviderHtml(
      url,
      PROVIDERS.ToonStream
    );

    return res.json({
      success: true,
      ...extractEpisodes($, 'ToonStream')
    });
  } catch (error) {
    if (error.message?.includes('URL')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    return handleProviderError(
      res,
      error,
      'ToonStream episodes'
    );
  }
});

// AnimeSalt streams
app.get('/animesalt/streams', async (req, res) => {
  try {
    const url = providerUrl(
      req.query.url,
      PROVIDERS.AnimeSalt
    );

    const $ = await fetchProviderHtml(
      url,
      PROVIDERS.AnimeSalt
    );

    return res.json({
      success: true,
      ...extractMetadata($, ANIMESALT_BASE),
      ...extractAnimeSaltStreams($)
    });
  } catch (error) {
    if (error.message?.includes('URL')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    return handleProviderError(
      res,
      error,
      'AnimeSalt streams'
    );
  }
});

// ToonStream streams
app.get('/toonstream/streams', async (req, res) => {
  try {
    const url = providerUrl(
      req.query.url,
      PROVIDERS.ToonStream
    );

    const $ = await fetchProviderHtml(
      url,
      PROVIDERS.ToonStream
    );

    return res.json({
      success: true,
      ...extractMetadata($, TOONSTREAM_BASE),
      ...extractToonStreamStreams($)
    });
  } catch (error) {
    if (error.message?.includes('URL')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    return handleProviderError(
      res,
      error,
      'ToonStream streams'
    );
  }
});

// TMDB episode thumbnail
app.get('/tmdb/episode-thumbnail', async (req, res) => {
  const title = validateQuery(req.query.title);
  const season = Number(req.query.season);
  const episode = Number(req.query.episode);

  if (
    !title ||
    !Number.isInteger(season) ||
    !Number.isInteger(episode) ||
    season < 0 ||
    episode < 1
  ) {
    return res.status(400).json({
      success: false,
      error: 'Valid title, season and episode are required'
    });
  }

  if (!TMDB_API_KEY) {
    return res.status(503).json({
      success: false,
      error: 'TMDB_API_KEY environment variable is not configured'
    });
  }

  try {
    const search = await axios.get(
      'https://api.themoviedb.org/3/search/tv',
      {
        params: {
          api_key: TMDB_API_KEY,
          query: title
        },
        timeout: 12000
      }
    );

    const show = search.data?.results?.[0];

    if (!show) {
      return res.status(404).json({
        success: false,
        error: 'TV show not found'
      });
    }

    const response = await axios.get(
      `https://api.themoviedb.org/3/tv/${show.id}/season/${season}/episode/${episode}`,
      {
        params: { api_key: TMDB_API_KEY },
        timeout: 12000
      }
    );

    const data = response.data;

    if (!data?.still_path) {
      return res.status(404).json({
        success: false,
        error: 'Episode thumbnail not available'
      });
    }

    return res.json({
      found: true,
      tv_id: show.id,
      show_title: show.name,
      episode_name: data.name || `Episode ${episode}`,
      overview: data.overview || '',
      air_date: data.air_date || null,
      thumbnails: {
        w500: `https://image.tmdb.org/t/p/w500${data.still_path}`,
        w780: `https://image.tmdb.org/t/p/w780${data.still_path}`,
        original: `https://image.tmdb.org/t/p/original${data.still_path}`
      }
    });
  } catch (error) {
    return handleProviderError(res, error, 'TMDB lookup');
  }
});

// Handle unknown endpoints
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start locally; Vercel uses exported app.
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`FetchStream API listening on port ${PORT}`);
  });
}

module.exports = app;
