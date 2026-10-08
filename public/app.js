(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

  const state = { link: '', info: null, tab: 'video', quality: 'sd' };

  // ---------- formatting ----------

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = String(Math.round(seconds % 60)).padStart(2, '0');
    return `${m}:${s}`;
  }

  function formatDate(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
  }

  // ---------- DOM helpers (text only, never innerHTML) ----------

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  let toastTimer;
  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
  }

  function showError(message) {
    const node = $('#error');
    node.textContent = message;
    node.hidden = false;
  }

  function clearError() {
    $('#error').hidden = true;
  }

  function downloadUrl(params) {
    return '/api/download?' + new URLSearchParams({ url: state.link, ...params }).toString();
  }

  // ---------- fetching ----------

  async function loadInfo(link) {
    const response = await fetch('/api/info?url=' + encodeURIComponent(link), { headers: { accept: 'application/json' } });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* non-JSON error page */
    }
    if (!response.ok) {
      throw new Error((body && body.error) || 'Something went wrong. Please try again.');
    }
    return body;
  }

  async function onSubmit(event) {
    event.preventDefault();
    clearError();

    const link = $('#url').value.trim();
    if (!/tiktok\.com/i.test(link)) {
      showError('Please paste a valid TikTok link.');
      return;
    }

    const button = $('#submit');
    button.disabled = true;
    button.classList.add('is-loading');
    $('#submitLabel').textContent = 'Loading';
    $('#result').hidden = true;

    try {
      state.link = link;
      state.info = await loadInfo(link);
      state.tab = state.info.kind === 'photo' ? 'photos' : 'video';
      state.quality = 'sd';
      renderResult();
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
      button.classList.remove('is-loading');
      $('#submitLabel').textContent = 'Get';
    }
  }

  // ---------- rendering ----------

  function renderResult() {
    const info = state.info;
    const isPhoto = info.kind === 'photo';

    setImage($('#cover'), info.cover);
    setImage($('#avatar'), info.author.avatar);
    $('#coverBadge').textContent = isPhoto ? `${info.photos.count} photos` : formatDuration(info.duration) || 'Video';
    $('#nickname').textContent = info.author.nickname || 'Unknown creator';
    $('#username').textContent = info.author.username ? '@' + info.author.username : '';
    $('#caption').textContent = info.title || 'No description';

    const stats = [
      ['Views', info.stats.views],
      ['Likes', info.stats.likes],
      ['Comments', info.stats.comments],
      ['Shares', info.stats.shares],
    ];
    $('#stats').replaceChildren(...stats.map(([label, value]) => el('li', {}, el('b', { text: compact.format(value) }), el('span', { text: label }))));

    renderMeta(info);
    renderPanel();

    const section = $('#result');
    section.hidden = false;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setImage(img, src) {
    if (src) {
      img.src = src;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }

  function renderMeta(info) {
    const isPhoto = info.kind === 'photo';
    const rows = [
      ['Type', isPhoto ? 'Photo slideshow' : 'Video'],
      ['Posted', formatDate(info.createdAt)],
      [isPhoto ? 'Photos' : 'Duration', isPhoto ? String(info.photos.count) : formatDuration(info.duration) || '–'],
      ['Region', info.region || '–'],
    ];
    if (!isPhoto) {
      rows.push(['Standard size', formatBytes(info.video.sizes.sd) || '–']);
      rows.push(['HD size', info.video.hasHd ? formatBytes(info.video.sizes.hd) || 'Available' : 'Not available']);
    }
    rows.push(['Saves', compact.format(info.stats.saves)]);
    rows.push(['Downloads', compact.format(info.stats.downloads)]);
    rows.push(['Sound', info.music.title || '–']);
    rows.push(['Content ID', info.id || '–']);

    $('#meta').replaceChildren(...rows.map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: value }))));
  }

  function tabsFor(info) {
    return info.kind === 'photo'
      ? [['photos', 'Photos'], ['audio', 'MP3']]
      : [['video', 'MP4'], ['audio', 'MP3']];
  }

  function renderPanel() {
    const info = state.info;
    const tabsNode = $('#tabs');

    tabsNode.replaceChildren(
      ...tabsFor(info).map(([id, label]) =>
        el('button', {
          type: 'button',
          class: 'tab',
          role: 'tab',
          'aria-selected': String(state.tab === id),
          text: label,
          onclick: () => {
            state.tab = id;
            state.quality = 'sd';
            renderPanel();
          },
        })
      )
    );

    const body = $('#panelBody');
    if (state.tab === 'video') body.replaceChildren(...videoPanel(info));
    else if (state.tab === 'photos') body.replaceChildren(...photosPanel(info));
    else body.replaceChildren(...audioPanel(info));
  }

  function qualityOptions(options) {
    return el(
      'div',
      { class: 'options', role: 'radiogroup', 'aria-label': 'Quality' },
      options.map((option) =>
        el(
          'label',
          { class: 'option' },
          el('input', {
            type: 'radio',
            name: 'quality',
            value: option.id,
            checked: state.quality === option.id,
            onchange: () => {
              state.quality = option.id;
              renderPanel();
            },
          }),
          el('span', { class: 'option-name', text: option.name }),
          el('span', { class: 'option-note', text: option.note })
        )
      )
    );
  }

  function downloadButton(label, href) {
    return el('a', {
      class: 'btn btn-primary btn-block',
      href,
      download: '',
      text: label,
      onclick: () => toast('Your download is starting…'),
    });
  }

  function videoPanel(info) {
    const sizes = info.video.sizes;
    const options = [{ id: 'sd', name: 'Standard', note: ['MP4', formatBytes(sizes.sd)].filter(Boolean).join(' · ') }];
    if (info.video.hasHd) options.push({ id: 'hd', name: 'HD', note: ['MP4 · higher quality', formatBytes(sizes.hd)].filter(Boolean).join(' · ') });
    if (info.video.hasWatermarked) options.push({ id: 'wm', name: 'With watermark', note: ['MP4 · original', formatBytes(sizes.wm)].filter(Boolean).join(' · ') });
    if (!options.some((o) => o.id === state.quality)) state.quality = 'sd';

    const chosen = options.find((o) => o.id === state.quality);
    return [
      qualityOptions(options),
      !info.video.hasHd ? el('p', { class: 'note', text: 'HD is not available for this video.' }) : null,
      downloadButton(`Download MP4 · ${chosen.name}`, downloadUrl({ type: 'video', quality: state.quality })),
    ];
  }

  function photosPanel(info) {
    const options = [
      { id: 'sd', name: 'Standard', note: 'JPG · 720 px wide' },
      { id: 'hd', name: 'HD', note: 'Original resolution' },
    ];
    const chosen = options.find((o) => o.id === state.quality);

    const grid = el(
      'div',
      { class: 'photo-grid' },
      info.photos.items.map((item) =>
        el(
          'div',
          { class: 'photo' },
          el('img', { src: item.thumb, alt: `Photo ${item.index + 1}`, loading: 'lazy', referrerpolicy: 'no-referrer' }),
          el('a', {
            href: downloadUrl({ type: 'photo', index: item.index, quality: state.quality }),
            download: '',
            text: 'Save',
            onclick: () => toast('Your download is starting…'),
          })
        )
      )
    );

    return [
      grid,
      qualityOptions(options),
      downloadButton(`Download all ${info.photos.count} photos (ZIP) · ${chosen.name}`, downloadUrl({ type: 'photos-zip', quality: state.quality })),
    ];
  }

  function audioPanel(info) {
    const music = info.music;
    if (!music.available) {
      return [el('p', { class: 'note', text: 'No sound is available for this post.' })];
    }
    const meta = [music.author, formatDuration(music.duration)].filter(Boolean).join(' · ');
    return [
      el(
        'div',
        { class: 'track' },
        music.cover ? el('img', { src: music.cover, alt: '', referrerpolicy: 'no-referrer' }) : null,
        el('div', {}, el('strong', { text: music.title || 'Original sound' }), meta ? el('span', { text: meta }) : null)
      ),
      downloadButton('Download MP3', downloadUrl({ type: 'audio' })),
    ];
  }

  // ---------- init ----------

  $('#form').addEventListener('submit', onSubmit);

  $('#paste').addEventListener('click', async () => {
    try {
      $('#url').value = await navigator.clipboard.readText();
      $('#url').focus();
    } catch {
      toast('Clipboard access was blocked. Please paste the link manually.');
    }
  });

  $('#year').textContent = new Date().getFullYear();

  // Allow deep links like /?url=https://vt.tiktok.com/...
  const preset = new URLSearchParams(location.search).get('url');
  if (preset) {
    $('#url').value = preset;
    $('#form').requestSubmit();
  }
})();
