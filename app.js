const rawDataEl = document.getElementById('members-data');
const MEMBERS_DATA = rawDataEl ? JSON.parse(rawDataEl.textContent) : [];

const appLayoutEl = document.getElementById('app-layout');
const sidebarBackdropEl = document.getElementById('sidebar-backdrop');
const sidebarToggleInnerEl = document.getElementById('sidebar-toggle-inner');
const memberListEl = document.getElementById('member-list');
const chatHeaderEl = document.getElementById('chat-header');
const chatEl = document.getElementById('chat');
const timelineRailEl = document.getElementById('timeline-rail');

const chatInputEl = document.getElementById('chat-input');
const stickerToggleBtnEl = document.getElementById('sticker-toggle-btn');
const sendMsgBtnEl = document.getElementById('send-msg-btn');
const stickerPickerPanelEl = document.getElementById('sticker-picker-panel');
const stickerGridEl = document.getElementById('sticker-grid');
const stickerPickerStatusEl = document.getElementById('sticker-picker-status');
const stickerClearBtnEl = document.getElementById('sticker-clear-btn');
const selectedStickerBarEl = document.getElementById('selected-sticker-bar');
const selectedStickerImgEl = document.getElementById('selected-sticker-img');
const selectedStickerRemoveEl = document.getElementById('selected-sticker-remove');

const MEDIA_EXT_RE = /\.(mp4|m4a|m4v|m4s)(?:[?#]|$)/i;

const MOBILE_BREAKPOINT = 768;
function isMobileViewport() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

let isSidebarCollapsed = isMobileViewport();
let activeMemberId = MEMBERS_DATA.length > 0 ? MEMBERS_DATA[0].artistMemberId : null;
let currentRenderedItems = [];
let currentSegmentStarts = [];
let lastDayState = null;
let lastTimestampMsState = null;

let remainingCount = null;
let textMaxLength = 200;
let stickersCache = null;
let selectedSticker = null;
let isSending = false;

function getLatestMessageIdForMember(member) {
  if (!member) return '';
  if (member.lastMessageId) return String(member.lastMessageId);
  if (member.lastMessage && member.lastMessage.id) return String(member.lastMessage.id);
  const records = Array.isArray(member.records) ? member.records : [];
  for (let i = records.length - 1; i >= 0; i--) {
    const mid = records[i]?.message?.id;
    if (mid !== undefined && mid !== null && String(mid).trim() !== '') {
      return String(mid);
    }
  }
  return '';
}

function updateComposerPlaceholder() {
  if (!chatInputEl) return;
  const countText = remainingCount === null || remainingCount === undefined ? '...' : String(remainingCount);
  chatInputEl.placeholder = nfc(`可發送 ${countText} 次訊息`);
  if (typeof textMaxLength === 'number' && textMaxLength > 0 && !selectedSticker) {
    chatInputEl.maxLength = textMaxLength;
  }
}

async function fetchRemainingCount(memberId) {
  if (!memberId) return;
  try {
    const resp = await fetch(`/api/reply-count/${encodeURIComponent(String(memberId))}`, {
      cache: 'no-store',
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (typeof data.remainingCount === 'number') {
      remainingCount = data.remainingCount;
    } else if (data.remainingCount === null || data.remainingCount === undefined) {
      remainingCount = 0;
    }
    if (typeof data.textMaxLength === 'number' && data.textMaxLength > 0) {
      textMaxLength = data.textMaxLength;
    }
    updateComposerPlaceholder();
  } catch (err) {
    console.debug('Fetch reply count failed:', err);
  }
}

function ensureRemainingCountIfNeeded(memberId) {
  if (remainingCount === null) {
    fetchRemainingCount(memberId);
  } else {
    updateComposerPlaceholder();
  }
}

function resolveStickerUtf8Content(rawCodepoint) {
  if (!rawCodepoint) return '';
  const str = String(rawCodepoint).trim();

  const hexMatch =
    str.match(/^(?:\\u|u\+|0x)?\{?([0-9a-fA-F]{4,6})\}?$/);
  if (hexMatch) {
    const cp = parseInt(hexMatch[1], 16);
    if (!Number.isNaN(cp) && cp >= 0 && cp <= 0x10ffff) {
      return nfc(String.fromCodePoint(cp));
    }
  }

  return nfc(str);
}

function setSelectedSticker(sticker) {
  if (!sticker) {
    selectedSticker = null;
    if (chatInputEl) {
      chatInputEl.disabled = false;
    }
    if (selectedStickerBarEl) {
      selectedStickerBarEl.style.display = 'none';
    }
    updateComposerPlaceholder();
    return;
  }

  const utf8Char = resolveStickerUtf8Content(sticker.codepointHex);
  selectedSticker = {
    id: sticker.id,
    codepointHex: sticker.codepointHex,
    utf8Content: utf8Char,
    imageUrl: sticker.imageUrl || '',
  };

  if (chatInputEl) {
    chatInputEl.value = '';
    chatInputEl.disabled = true;
    chatInputEl.placeholder = nfc(
      `已選擇貼圖，按傳送發送（可發送 ${remainingCount ?? '...'} 次訊息）`
    );
  }
  if (selectedStickerBarEl && selectedStickerImgEl) {
    selectedStickerImgEl.src = selectedSticker.imageUrl || '';
    selectedStickerImgEl.alt = utf8Char || 'sticker';
    selectedStickerBarEl.style.display = 'flex';
  }
}

function renderStickerGrid() {
  if (!stickerGridEl) return;
  stickerGridEl.replaceChildren();

  const list = Array.isArray(stickersCache) ? stickersCache : [];
  if (list.length === 0) {
    if (stickerPickerStatusEl) {
      stickerPickerStatusEl.textContent = nfc('沒有可用的貼圖');
    }
    return;
  }

  if (stickerPickerStatusEl) {
    stickerPickerStatusEl.textContent = nfc(`貼圖（共 ${list.length} 個，點選後按 ↑ 發送）`);
  }

  for (const st of list) {
    if (!st || !st.codepointHex) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker-grid-item';
    if (selectedSticker && selectedSticker.codepointHex === st.codepointHex) {
      btn.classList.add('selected');
    }
    btn.title = nfc(st.codepointHex);

    const img = document.createElement('img');
    img.src = st.imageUrl || '';
    img.alt = nfc(st.codepointHex);
    img.loading = 'lazy';
    btn.appendChild(img);

    btn.onclick = () => {
      setSelectedSticker({
        id: st.id,
        codepointHex: String(st.codepointHex),
        imageUrl: st.imageUrl || '',
      });
      renderStickerGrid();
      if (stickerPickerPanelEl) {
        stickerPickerPanelEl.classList.remove('open');
      }
    };

    stickerGridEl.appendChild(btn);
  }
}

async function loadAndToggleStickers() {
  if (!stickerPickerPanelEl) return;
  const willOpen = !stickerPickerPanelEl.classList.contains('open');
  if (!willOpen) {
    stickerPickerPanelEl.classList.remove('open');
    return;
  }

  stickerPickerPanelEl.classList.add('open');
  if (stickersCache !== null) {
    renderStickerGrid();
    return;
  }

  if (stickerPickerStatusEl) {
    stickerPickerStatusEl.textContent = nfc('載入貼圖中...');
  }

  try {
    const resp = await fetch('/api/stickers', { cache: 'no-store' });
    if (!resp.ok) {
      if (stickerPickerStatusEl) {
        stickerPickerStatusEl.textContent = nfc('貼圖載入失敗');
      }
      return;
    }
    const data = await resp.json();
    stickersCache = Array.isArray(data) ? data : (Array.isArray(data.stickers) ? data.stickers : []);
    renderStickerGrid();
  } catch (err) {
    console.debug('Load stickers failed:', err);
    if (stickerPickerStatusEl) {
      stickerPickerStatusEl.textContent = nfc('貼圖載入發生錯誤');
    }
  }
}

async function sendMessagePayload() {
  if (isSending || !activeMemberId) return;

  let payloadContent = '';
  if (selectedSticker) {
    payloadContent = resolveStickerUtf8Content(
      selectedSticker.utf8Content || selectedSticker.codepointHex
    );
  } else {
    const rawText = chatInputEl ? chatInputEl.value : '';
    const trimmed = rawText.trim();
    if (!trimmed) return;
    payloadContent = nfc(trimmed);
  }

  const curMember = MEMBERS_DATA.find(
    (m) => String(m.artistMemberId) === String(activeMemberId)
  );
  const targetMessageId = getLatestMessageIdForMember(curMember);

  isSending = true;
  if (sendMsgBtnEl) sendMsgBtnEl.disabled = true;

  try {
    const resp = await fetch(`/api/messages/${encodeURIComponent(String(activeMemberId))}/replies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: payloadContent,
        messageId: targetMessageId,
      }),
    });

    if (resp.status === 201 || resp.status === 206 || resp.ok) {
      if (chatInputEl) chatInputEl.value = '';
      setSelectedSticker(null);
      renderStickerGrid();

      if (resp.status === 206) {
        await fetchRemainingCount(activeMemberId);
      } else if (typeof remainingCount === 'number' && remainingCount > 0) {
        remainingCount -= 1;
        updateComposerPlaceholder();
      }

      await silentPollOnce();
    } else {
      const errText = await resp.text().catch(() => '');
      console.warn('Send failed:', resp.status, errText);
    }
  } catch (err) {
    console.debug('Send message error:', err);
  } finally {
    isSending = false;
    if (sendMsgBtnEl) sendMsgBtnEl.disabled = false;
  }
}

if (stickerToggleBtnEl) {
  stickerToggleBtnEl.onclick = loadAndToggleStickers;
}

if (stickerClearBtnEl) {
  stickerClearBtnEl.onclick = () => {
    setSelectedSticker(null);
    renderStickerGrid();
  };
}

if (selectedStickerRemoveEl) {
  selectedStickerRemoveEl.onclick = () => {
    setSelectedSticker(null);
    renderStickerGrid();
  };
}

if (sendMsgBtnEl) {
  sendMsgBtnEl.onclick = sendMessagePayload;
}

if (chatInputEl) {
  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessagePayload();
    }
  });
}

function applySidebarState() {
  if (!appLayoutEl) return;
  appLayoutEl.classList.toggle('sidebar-collapsed', isSidebarCollapsed);
}

function toggleSidebar(forceState) {
  if (typeof forceState === 'boolean') {
    isSidebarCollapsed = forceState;
  } else {
    isSidebarCollapsed = !isSidebarCollapsed;
  }
  applySidebarState();
}

if (sidebarToggleInnerEl) {
  sidebarToggleInnerEl.onclick = () => toggleSidebar(true);
}

if (sidebarBackdropEl) {
  sidebarBackdropEl.onclick = () => toggleSidebar(true);
}

let wasMobile = isMobileViewport();
window.addEventListener('resize', () => {
  const nowMobile = isMobileViewport();
  if (nowMobile !== wasMobile) {
    wasMobile = nowMobile;
    isSidebarCollapsed = nowMobile;
    applySidebarState();
  }
});

function nfc(val) {
  if (typeof val === 'string') return val.normalize('NFC');
  if (Array.isArray(val)) return val.map(nfc);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k.normalize('NFC')] = nfc(v);
    }
    return out;
  }
  return val;
}

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && Object.keys(v).length === 0) return true;
  return false;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return (
    d.getFullYear() +
    '년 ' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '월 ' +
    String(d.getDate()).padStart(2, '0') +
    '일'
  );
}

function fmtTimelineLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function fmtExportTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}:${ss}`;
}

function isOther(msg) {
  return msg.senderType === 'artistMember';
}

function formatMemberLabel(member) {
  const orig = nfc(member.originalName || '');
  const disp = nfc(member.artistMemberName || '');
  if (orig && disp) return nfc(`${orig} (${disp})`);
  return nfc(orig || disp || String(member.artistMemberId));
}

function renderSticker(st, bubble) {
  bubble.classList.add('sticker');
  const stickerUrl = typeof st === 'string' ? st : st?.imageUrl;
  if (!stickerUrl) {
    bubble.textContent = nfc(typeof st === 'object' ? JSON.stringify(st) : String(st));
    return;
  }
  const img = document.createElement('img');
  img.className = 'sticker-img';
  img.src = stickerUrl;
  img.alt = nfc(st?.codepointHex || st?.id || 'sticker');
  img.loading = 'lazy';
  img.onerror = () => {
    const a = document.createElement('a');
    a.href = stickerUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = stickerUrl;
    a.style.color = '#5eaaff';
    bubble.replaceChildren(a);
  };
  bubble.appendChild(img);
}

function pickMediaUrl(item) {
  if (typeof item === 'string') {
    return item.trim();
  }
  if (!item || typeof item !== 'object') {
    return '';
  }

  const candidates = [
    item.thumbnailUrl,
    item.originalUrl,
    item.url,
  ]
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);

  const preferred = candidates.find((u) => MEDIA_EXT_RE.test(u));
  return preferred || candidates[0] || '';
}

function renderMedia(md, bubble) {
  bubble.classList.add('media');
  const items = Array.isArray(md) ? md : [md];
  const list = document.createElement('div');
  list.className = 'media-list';

  for (const item of items) {
    if (isEmpty(item)) continue;
    const targetUrl = pickMediaUrl(item);

    if (!targetUrl) {
      const pre = document.createElement('div');
      pre.className = 'bubble';
      pre.textContent = nfc(typeof item === 'object' ? JSON.stringify(item) : String(item));
      list.appendChild(pre);
      continue;
    }

    const aspectRatio =
      typeof item === 'object' && item.aspectRatio && Number(item.aspectRatio) > 0
        ? String(item.aspectRatio)
        : '';

    if (MEDIA_EXT_RE.test(targetUrl)) {
      const box = document.createElement('div');
      box.className = 'media-box';

      const video = document.createElement('video');
      video.className = 'media-video';
      video.src = targetUrl;
      if (typeof item === 'object' && item.thumbnailUrl) {
        video.poster = item.thumbnailUrl;
      }
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      if (aspectRatio) {
        video.style.aspectRatio = aspectRatio;
      }
      video.onerror = () => {
        const a = document.createElement('a');
        a.className = 'fallback-link';
        a.href = targetUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = targetUrl;
        box.replaceChildren(a);
      };

      box.appendChild(video);
      list.appendChild(box);
      continue;
    }

    const a = document.createElement('a');
    a.className = 'media-link';
    a.href = targetUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const img = document.createElement('img');
    img.className = 'media-img';
    img.src = targetUrl;
    img.alt = 'media';
    img.loading = 'lazy';
    if (aspectRatio) {
      img.style.aspectRatio = aspectRatio;
    }
    img.onerror = () => {
      a.className = 'fallback-link';
      a.style.color = '#5eaaff';
      a.textContent = targetUrl;
    };

    a.appendChild(img);
    list.appendChild(a);
  }

  if (list.childNodes.length > 0) {
    bubble.appendChild(list);
  }
}

function getCurrentSegmentStartRenderedIndex() {
  if (currentRenderedItems.length === 0) return 0;

  const headerHeight = chatHeaderEl ? chatHeaderEl.getBoundingClientRect().height : 60;
  const referenceY = headerHeight + 16;

  let currentRenderedIdx = 0;
  for (let i = 0; i < currentRenderedItems.length; i++) {
    const el = currentRenderedItems[i].element;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top <= referenceY) {
      currentRenderedIdx = i;
    } else {
      break;
    }
  }

  let activeSegStartIdx = 0;
  for (const seg of currentSegmentStarts) {
    if (seg.renderedIndex <= currentRenderedIdx) {
      activeSegStartIdx = seg.renderedIndex;
    } else {
      break;
    }
  }

  return activeSegStartIdx;
}

function exportPlainText(member) {
  if (!member) return;
  const startRenderedIdx = getCurrentSegmentStartRenderedIndex();
  const blocks = [];

  for (let i = startRenderedIdx; i < currentRenderedItems.length; i++) {
    const msg = currentRenderedItems[i].msg;
    if (!msg || typeof msg !== 'object') continue;
    if (msg.messageType === 'text' && typeof msg.content === 'string' && msg.content.trim() !== '') {
      const ts = fmtExportTimestamp(msg.createdAt);
      const text = nfc(msg.content);
      blocks.push(ts ? `${ts}\n${text}` : text);
    }
  }

  const startItem = currentRenderedItems[startRenderedIdx];
  const startIso = startItem?.msg?.createdAt;
  const startTag = startIso ? fmtTimelineLabel(startIso).replace(/[: ]/g, '-') : 'start';

  const textBlob = new Blob([blocks.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(textBlob);
  const a = document.createElement('a');
  const safeName = nfc(
    `${member.originalName || ''}_${member.artistMemberName || member.artistMemberId}`.replace(
      /[\\/:*?"<>|]/g,
      '_'
    )
  );
  a.href = url;
  a.download = `${safeName}_from_${startTag}_text.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderSidebar() {
  memberListEl.replaceChildren();
  for (const member of MEMBERS_DATA) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'member-item' + (member.artistMemberId === activeMemberId ? ' active' : '');
    btn.onclick = () => {
      activeMemberId = member.artistMemberId;
      renderSidebar();
      renderChatForMember(member);
      ensureRemainingCountIfNeeded(activeMemberId);
      if (isMobileViewport()) {
        toggleSidebar(true);
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    };

    if (member.profileImageUrl) {
      const thumb = document.createElement('img');
      thumb.className = 'member-thumb';
      thumb.src = member.profileImageUrl;
      thumb.alt = formatMemberLabel(member);
      thumb.loading = 'lazy';
      btn.appendChild(thumb);
    }

    const label = document.createElement('span');
    label.className = 'member-label';
    label.textContent = formatMemberLabel(member);
    btn.appendChild(label);

    memberListEl.appendChild(btn);
  }
}

function renderChatForMember(member) {
  chatHeaderEl.replaceChildren();
  chatEl.replaceChildren();
  timelineRailEl.replaceChildren();
  timelineRailEl.classList.add('empty');
  currentRenderedItems = [];
  currentSegmentStarts = [];
  currentRenderedKeys = new Set();
  lastDayState = null;
  lastTimestampMsState = null;

  if (!member) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = nfc('沒有可用的頻道資料');
    chatEl.appendChild(empty);
    return;
  }

  const label = formatMemberLabel(member);
  document.title = nfc(`${label} · COSMO TALK WEB`);

  const headerLeft = document.createElement('div');
  headerLeft.className = 'header-left';

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'icon-btn';
  menuBtn.textContent = '☰';
  menuBtn.setAttribute('aria-label', nfc('切換側邊欄'));
  menuBtn.onclick = () => toggleSidebar();
  headerLeft.appendChild(menuBtn);

  if (member.profileImageUrl) {
    const hImg = document.createElement('img');
    hImg.className = 'header-avatar';
    hImg.src = member.profileImageUrl;
    hImg.alt = label;
    headerLeft.appendChild(hImg);
  }

  const hTitle = document.createElement('div');
  hTitle.className = 'header-title';
  hTitle.textContent = label;
  headerLeft.appendChild(hTitle);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'export-btn';
  exportBtn.textContent = nfc('匯出純文本');
  exportBtn.onclick = () => exportPlainText(member);

  chatHeaderEl.appendChild(headerLeft);
  chatHeaderEl.appendChild(exportBtn);

  const records = Array.isArray(member.records) ? member.records : [];
  let renderedCount = 0;

  records.forEach((rec, idx) => {
    const msg = rec.message || {};
    const createdAt = msg.createdAt;

    const hasContent = !isEmpty(msg.content);
    const hasSticker = !isEmpty(msg.stickerMetadata);
    const hasMedia = !isEmpty(msg.mediaMetadata);
    const isReply = !isEmpty(msg.replyContent);

    if (!hasContent && !hasSticker && !hasMedia && !isReply) {
      return;
    }

    const currentRenderedIdx = renderedCount;
    renderedCount += 1;

    const day = fmtDay(createdAt);
    if (day && day !== lastDayState) {
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = nfc(day);
      chatEl.appendChild(d);
      lastDayState = day;
    }

    const other = isOther(msg);
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper';
    const msgAnchorId = `msg-${member.artistMemberId}-${renderedCount}`;
    wrapper.id = msgAnchorId;
    if (!other) {
      wrapper.style.flexDirection = 'row-reverse';
    }

    if (other) {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      if (member.profileImageUrl) {
        avatar.style.backgroundImage = `url('${member.profileImageUrl}')`;
      }
      wrapper.appendChild(avatar);
    }

    const contentBox = document.createElement('div');
    contentBox.className = 'msg-content';
    if (!other) {
      contentBox.style.alignItems = 'flex-end';
    }

    if (other) {
      const nameContainer = document.createElement('div');
      nameContainer.className = 'sender-name';
      nameContainer.textContent = nfc(member.artistMemberName || member.originalName || '');
      contentBox.appendChild(nameContainer);
    }

    const bubbleRow = document.createElement('div');
    bubbleRow.className = 'bubble-row';
    if (!other) {
      bubbleRow.style.flexDirection = 'row-reverse';
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (isReply ? 'reply-bubble' : '');

    if (isReply) {
      const rc = msg.replyContent;
      const quoteBox = document.createElement('div');
      quoteBox.className = 'quote-box';

      const qHeader = document.createElement('div');
      qHeader.className = 'quote-header';
      qHeader.textContent = nfc(`${member.artistMemberName || ''} 回覆了`);

      const qText = document.createElement('div');
      qText.className = 'quote-text';
      qText.textContent = nfc(typeof rc === 'object' ? JSON.stringify(rc) : rc);

      quoteBox.appendChild(qHeader);
      quoteBox.appendChild(qText);
      bubble.appendChild(quoteBox);
    } else if (hasContent) {
      bubble.appendChild(document.createTextNode(nfc(String(msg.content))));
    } else if (hasSticker) {
      renderSticker(msg.stickerMetadata, bubble);
    } else if (hasMedia) {
      renderMedia(msg.mediaMetadata, bubble);
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'time';
    timeEl.textContent = fmtTime(createdAt);

    if (!other) {
      bubbleRow.appendChild(timeEl);
      bubbleRow.appendChild(bubble);
    } else {
      bubbleRow.appendChild(bubble);
      bubbleRow.appendChild(timeEl);
    }

    contentBox.appendChild(bubbleRow);
    wrapper.appendChild(contentBox);
    chatEl.appendChild(wrapper);

    currentRenderedKeys.add(getRecordKey(rec, idx));
    currentRenderedItems.push({
      element: wrapper,
      msg: msg,
    });

    const parsedMs = createdAt ? Date.parse(createdAt) : NaN;
    if (!Number.isNaN(parsedMs)) {
      if (lastTimestampMsState === null) {
        currentSegmentStarts.push({
          id: msgAnchorId,
          iso: createdAt,
          renderedIndex: currentRenderedIdx,
        });
      } else {
        const diffMinutes = Math.abs(parsedMs - lastTimestampMsState) / 60000;
        if (diffMinutes > 31) {
          currentSegmentStarts.push({
            id: msgAnchorId,
            iso: createdAt,
            renderedIndex: currentRenderedIdx,
          });
        }
      }
      lastTimestampMsState = parsedMs;
    }
  });

  if (currentSegmentStarts.length > 0) {
    timelineRailEl.classList.remove('empty');
    for (const seg of currentSegmentStarts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'timeline-btn';
      btn.textContent = nfc(fmtTimelineLabel(seg.iso));
      btn.title = nfc(new Date(seg.iso).toLocaleString());
      btn.onclick = () => {
        const targetEl = document.getElementById(seg.id);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
      timelineRailEl.appendChild(btn);
    }
  }

  if (renderedCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = nfc('此頻道目前沒有可顯示的訊息');
    chatEl.appendChild(empty);
  }
}

applySidebarState();
renderSidebar();
const currentMember =
  MEMBERS_DATA.find((m) => m.artistMemberId === activeMemberId) || MEMBERS_DATA[0] || null;
renderChatForMember(currentMember);
ensureRemainingCountIfNeeded(activeMemberId);

const POLL_INTERVAL_MS = 15000;
const NEAR_BOTTOM_THRESHOLD_PX = 120;

let isPolling = false;

function getRecordKey(rec, fallbackIdx = 0) {
  const msg = rec?.message || {};
  if (msg.syncId) return nfc(String(msg.syncId));
  if (msg.id) return nfc(`${msg.sourceType || 'msg'}:${msg.id}`);
  if (rec?.cursor) return nfc(`cursor:${rec.cursor}:${fallbackIdx}`);
  return nfc(`idx:${fallbackIdx}:${msg.createdAt || ''}`);
}

function getComposerReserveHeight() {
  let h = 96;
  const composerEl = document.getElementById('chat-composer-wrapper');
  if (composerEl) {
    h = Math.max(h, composerEl.getBoundingClientRect().height + 24);
  }
  return h;
}

function isNearBottom() {
  const doc = document.documentElement;
  const reserve = getComposerReserveHeight();
  const scrollBottom = window.scrollY + window.innerHeight;
  return doc.scrollHeight - scrollBottom <= NEAR_BOTTOM_THRESHOLD_PX + reserve;
}

function scrollToLatestAboveComposer(behavior = 'smooth') {
  const lastItem = currentRenderedItems[currentRenderedItems.length - 1];
  if (!lastItem?.element) return;

  const reserve = getComposerReserveHeight();
  const rect = lastItem.element.getBoundingClientRect();
  const visibleBottom = window.innerHeight - reserve;

  if (rect.bottom > visibleBottom || rect.top < 72) {
    const delta = rect.bottom - visibleBottom + 12;
    window.scrollBy({
      top: delta,
      behavior,
    });
  }
}

function appendTimelineButton(seg) {
  timelineRailEl.classList.remove('empty');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'timeline-btn';
  btn.textContent = nfc(fmtTimelineLabel(seg.iso));
  btn.title = nfc(new Date(seg.iso).toLocaleString());
  btn.onclick = () => {
    const targetEl = document.getElementById(seg.id);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  timelineRailEl.appendChild(btn);
}

function appendSingleRecord(member, rec, key) {
  const msg = rec.message || {};
  const createdAt = msg.createdAt;

  const hasContent = !isEmpty(msg.content);
  const hasSticker = !isEmpty(msg.stickerMetadata);
  const hasMedia = !isEmpty(msg.mediaMetadata);
  const isReply = !isEmpty(msg.replyContent);

  if (!hasContent && !hasSticker && !hasMedia && !isReply) {
    return;
  }

  const currentRenderedIdx = currentRenderedItems.length;
  const seqNum = currentRenderedIdx + 1;

  const day = fmtDay(createdAt);
  if (day && day !== lastDayState) {
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = nfc(day);
    chatEl.appendChild(d);
    lastDayState = day;
  }

  const other = isOther(msg);
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper';
  const msgAnchorId = `msg-${member.artistMemberId}-${seqNum}`;
  wrapper.id = msgAnchorId;
  if (!other) {
    wrapper.style.flexDirection = 'row-reverse';
  }

  if (other) {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (member.profileImageUrl) {
      avatar.style.backgroundImage = `url('${member.profileImageUrl}')`;
    }
    wrapper.appendChild(avatar);
  }

  const contentBox = document.createElement('div');
  contentBox.className = 'msg-content';
  if (!other) {
    contentBox.style.alignItems = 'flex-end';
  }

  if (other) {
    const nameContainer = document.createElement('div');
    nameContainer.className = 'sender-name';
    nameContainer.textContent = nfc(member.artistMemberName || member.originalName || '');
    contentBox.appendChild(nameContainer);
  }

  const bubbleRow = document.createElement('div');
  bubbleRow.className = 'bubble-row';
  if (!other) {
    bubbleRow.style.flexDirection = 'row-reverse';
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (isReply ? 'reply-bubble' : '');

  if (isReply) {
    const rc = msg.replyContent;
    const quoteBox = document.createElement('div');
    quoteBox.className = 'quote-box';

    const qHeader = document.createElement('div');
    qHeader.className = 'quote-header';
    qHeader.textContent = nfc(`${member.artistMemberName || ''} 回覆了`);

    const qText = document.createElement('div');
    qText.className = 'quote-text';
    qText.textContent = nfc(typeof rc === 'object' ? JSON.stringify(rc) : rc);

    quoteBox.appendChild(qHeader);
    quoteBox.appendChild(qText);
    bubble.appendChild(quoteBox);
  } else if (hasContent) {
    bubble.appendChild(document.createTextNode(nfc(String(msg.content))));
  } else if (hasSticker) {
    renderSticker(msg.stickerMetadata, bubble);
  } else if (hasMedia) {
    renderMedia(msg.mediaMetadata, bubble);
  }

  const timeEl = document.createElement('div');
  timeEl.className = 'time';
  timeEl.textContent = fmtTime(createdAt);

  if (!other) {
    bubbleRow.appendChild(timeEl);
    bubbleRow.appendChild(bubble);
  } else {
    bubbleRow.appendChild(bubble);
    bubbleRow.appendChild(timeEl);
  }

  contentBox.appendChild(bubbleRow);
  wrapper.appendChild(contentBox);
  chatEl.appendChild(wrapper);

  currentRenderedKeys.add(key);
  currentRenderedItems.push({
    element: wrapper,
    msg: msg,
  });

  const parsedMs = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isNaN(parsedMs)) {
    const shouldCreateSeg =
      lastTimestampMsState === null ||
      Math.abs(parsedMs - lastTimestampMsState) / 60000 > 31;

    if (shouldCreateSeg) {
      const seg = {
        id: msgAnchorId,
        iso: createdAt,
        renderedIndex: currentRenderedIdx,
      };
      currentSegmentStarts.push(seg);
      appendTimelineButton(seg);
    }
    lastTimestampMsState = parsedMs;
  }
}

async function silentPollOnce() {
  if (isPolling || document.hidden || activeMemberId === null) return;
  isPolling = true;

  try {
    const query = activeMemberId !== null
      ? `?artistMemberId=${encodeURIComponent(String(activeMemberId))}`
      : '';
    const resp = await fetch(`/api/messages${query}`, {
      cache: 'no-store',
    });

    if (resp.status === 401) {
      const errData = await resp.json().catch(() => ({}));
      if (errData.loginUrl) {
        window.location.href = errData.loginUrl;
      }
      return;
    }

    if (!resp.ok) return;
    const payload = await resp.json();
    if (!payload.ok || !Array.isArray(payload.members)) return;

    for (const updatedMember of payload.members) {
      const idx = MEMBERS_DATA.findIndex(
        (m) => String(m.artistMemberId) === String(updatedMember.artistMemberId)
      );
      if (idx >= 0) {
        MEMBERS_DATA[idx] = nfc(updatedMember);
      }
    }

    const currentMember = MEMBERS_DATA.find(
      (m) => String(m.artistMemberId) === String(activeMemberId)
    );
    if (!currentMember) return;

    const records = Array.isArray(currentMember.records) ? currentMember.records : [];
    const newRecords = [];
    records.forEach((rec, idx) => {
      const key = getRecordKey(rec, idx);
      if (!currentRenderedKeys.has(key)) {
        newRecords.push({ rec, key });
      }
    });

    if (newRecords.length === 0) return;

    const stickToBottom = isNearBottom();
    const emptyEl = chatEl.querySelector('.empty-state');
    if (emptyEl) emptyEl.remove();

    for (const { rec, key } of newRecords) {
      appendSingleRecord(currentMember, rec, key);
    }

    if (stickToBottom) {
      requestAnimationFrame(() => {
        scrollToLatestAboveComposer('smooth');
        const lastEl = currentRenderedItems[currentRenderedItems.length - 1]?.element;
        if (lastEl) {
          lastEl.querySelectorAll('img, video').forEach((mediaEl) => {
            mediaEl.addEventListener(
              'load',
              () => scrollToLatestAboveComposer('instant'),
              { once: true }
            );
            mediaEl.addEventListener(
              'loadedmetadata',
              () => scrollToLatestAboveComposer('instant'),
              { once: true }
            );
          });
        }
      });
    }
  } catch (err) {
    console.debug('Silent poll skipped:', err);
  } finally {
    isPolling = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    silentPollOnce();
  }
});

setInterval(silentPollOnce, POLL_INTERVAL_MS);