import { escapeHtml, formatPaise, formatDate } from './validate.js';

const BRAND_MARK = '<span class="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13.5 2 6 14h4.5L10 22l7.5-12H13l.5-8Z" fill="#fff"/></svg></span>';
const DEFAULT_PUBLIC_NAV = '<a href="/features">Products</a> <a href="/#workflow">Solutions</a> <a href="/docs">Developers</a> <a href="/pricing">Pricing</a>';

function brandHtml() {
  return `<a class="brand" href="/">${BRAND_MARK}<span>YOUPI<em>PG</em></span></a>`;
}

function confirmScript() {
  return `<script>document.addEventListener('submit',function(e){var f=e.target;var m=f.getAttribute&&f.getAttribute('data-confirm');if(m&&!window.confirm(m)){e.preventDefault();}},true);document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('table').forEach(function(table){var headers=[];table.querySelectorAll('thead th').forEach(function(th){headers.push(th.textContent.trim());});if(!headers.length)return;table.querySelectorAll('tbody tr').forEach(function(tr){tr.querySelectorAll('td').forEach(function(td,i){if(!td.getAttribute('data-label')&&headers[i])td.setAttribute('data-label',headers[i]);});});});function syncDrawerLock(){document.body.classList.toggle('no-scroll',!!document.querySelector('.shell-menu[open], .mobile-nav[open]'));}document.querySelectorAll('.shell-menu, .mobile-nav').forEach(function(d){var nav=d.querySelector('nav');if(!nav)return;var summary=d.querySelector('summary');function close(){d.removeAttribute('open');if(summary)summary.setAttribute('aria-expanded','false');syncDrawerLock();}d.addEventListener('toggle',function(){if(summary)summary.setAttribute('aria-expanded',d.open?'true':'false');syncDrawerLock();if(d.open){var c=nav.querySelector('[data-close-menu]');if(c)c.focus();}});nav.querySelectorAll('a').forEach(function(a){a.addEventListener('click',close);});nav.addEventListener('click',function(e){if(e.target===nav||e.target.closest('[data-close-menu]'))close();});document.addEventListener('keydown',function(e){if(e.key==='Escape'&&d.open){close();if(summary)summary.focus();}});});document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-close-menu]');if(!b)return;var d=b.closest('.shell-menu, .mobile-nav');if(d){d.removeAttribute('open');var s=d.querySelector('summary');if(s)s.setAttribute('aria-expanded','false');syncDrawerLock();}});var path=window.location.pathname;var best=null;document.querySelectorAll('.sidebar-nav a,.shell-menu nav a').forEach(function(a){var p;try{p=new URL(a.href).pathname;}catch(e){return;}if(p===path){a.classList.add('active');best='';}else if(best!==''&&path.indexOf(p+'/')===0&&(!best||p.length>best.length))best=p;});if(best)document.querySelectorAll('.sidebar-nav a,.shell-menu nav a').forEach(function(a){try{if(new URL(a.href).pathname===best)a.classList.add('active');}catch(e){}});document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-copy-text]');if(!b)return;var text=b.getAttribute('data-copy-text')||'';function done(){var old=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=old;},1500);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done).catch(function(){done();});}else{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(err){}document.body.removeChild(ta);done();}});});</script>`;
}

function authScript() {
  return `<script>(function(){
    document.querySelectorAll('input[type="password"]').forEach(function(input){
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'pw-toggle'; btn.textContent = 'Show';
      btn.setAttribute('aria-label', 'Show or hide password');
      btn.addEventListener('click', function(){
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Hide' : 'Show';
      });
      input.insertAdjacentElement('afterend', btn);
    });
    var pw = document.querySelector('form[action="/merchant/register"] input[name="password"]');
    if (pw) {
      var hint = document.createElement('p');
      hint.className = 'pw-strength muted small';
      hint.textContent = 'Password strength: use at least 10 characters, with letters, numbers and a symbol for a stronger password.';
      pw.insertAdjacentElement('afterend', hint);
      pw.addEventListener('input', function(){
        var v = pw.value, score = 0;
        if (v.length >= 10) score++;
        if (v.length >= 14) score++;
        if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
        if (/[0-9]/.test(v)) score++;
        if (/[^A-Za-z0-9]/.test(v)) score++;
        var label = score <= 1 ? 'Weak' : score <= 3 ? 'Fair' : 'Strong';
        hint.textContent = 'Password strength: ' + label + ' (' + v.length + ' characters). Server requires at least 10 characters.';
      });
    }
    document.querySelectorAll('form').forEach(function(form){
      form.addEventListener('submit', function(){
        form.querySelectorAll('button[type="submit"], .btn[type="submit"]').forEach(function(b){
          if (!b.disabled) { b.disabled = true; b.setAttribute('data-original-text', b.textContent); b.textContent = 'Please wait…'; }
        });
      });
    });
  })();</script>`;
}

const AUTH_TITLES = ['Merchant login', 'Merchant registration', 'Admin login', 'Forgot password', 'Admin forgot password', 'Reset password', 'Admin reset password', 'Registration received'];

const DISCLAIMER = 'A QR code, redirect, screenshot or “I have paid” click is never proof of payment. Orders stay pending until payment verification by manual reconciliation, a configured provider, or an optional external observer.';

export function ordersTrendChart(days) {
  // days: [{ date: 'YYYY-MM-DD', total: Number, success: Number }] for the
  // last 14 days, already filled with zeros for days without orders.
  // Pure server-rendered SVG: no external chart library, no CDN dependency,
  // so the chart works on shared hosting even when third-party scripts fail.
  const total = days.reduce((a, d) => a + d.total, 0);
  if (!total) return '<p class="muted">No orders in the last 14 days, so there is no trend to chart yet. The chart appears automatically once orders exist.</p>';
  const max = Math.max(1, ...days.map((d) => d.total));
  const W = 560, base = 128, bw = 26, gap = 12;
  const segs = [
    { key: 'success', fill: '#7c3aed' },
    { key: 'pending', fill: '#f59e0b' },
    { key: 'failed', fill: '#ef4444' },
    { key: 'other', fill: '#cbd5e1' },
  ];
  const bars = days.map((d, i) => {
    const x = 8 + i * (bw + gap);
    let y = base;
    const rects = segs.map((sg) => {
      const h = Math.round(((d[sg.key] || 0) / max) * 110);
      const r = h ? `<rect x="${x}" y="${y - h}" width="${bw}" height="${h}" fill="${sg.fill}"/>` : '';
      y -= h;
      return r;
    }).join('');
    const label = i % 3 === 0 ? `<text x="${x + bw / 2}" y="146" text-anchor="middle" font-size="10" fill="#64748b">${escapeHtml(d.date.slice(5))}</text>` : '';
    const floor = `<rect x="${x}" y="${base - 1}" width="${bw}" height="1" fill="#e2e8f0"/>`;
    return `<g><title>${escapeHtml(d.date)}: ${d.total} order${d.total === 1 ? '' : 's'} — ${d.success || 0} successful, ${d.pending || 0} pending, ${d.failed || 0} failed, ${d.other || 0} other</title>${floor}${rects}${label}</g>`;
  }).join('');
  const peak = days.reduce((a, d) => (d.total > a.total ? d : a), days[0]);
  return `<div class="chart-card"><svg viewBox="0 0 ${W} 156" width="100%" role="img" aria-label="Orders per day for the last 14 days, stacked by status">${bars}</svg><p class="chart-legend"><span><i class="sw violet"></i>Successful</span><span><i class="sw amber"></i>Pending</span><span><i class="sw red"></i>Failed</span><span><i class="sw grey"></i>Other</span><span>Peak: ${peak.total} on ${escapeHtml(peak.date)}</span></p><p class="muted small">Source: orders table, last 14 days. Hover a bar for that day's breakdown.</p></div>`;
}

export function layout({ title, body, user, nav, variant, hideTitle }) {
  const hasNav = Boolean(nav);
  const navHtml = nav || DEFAULT_PUBLIC_NAV;
  const isAdmin = /\/admin\//.test(navHtml);
  const isMerchant = /\/merchant\//.test(navHtml);
  const isAuthPage = !user && !hasNav && AUTH_TITLES.includes(title);
  const shell = variant || (isAuthPage ? 'auth' : isAdmin ? 'admin' : isMerchant ? 'merchant' : 'public');
  const safeTitle = escapeHtml(title);
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="YOUPI PG — multi-merchant UPI payment gateway with QR checkout, API, webhooks and manual payment verification."><title>${safeTitle} — YOUPI PG</title><link rel="stylesheet" href="/public/css/style.css?v=6"></head><body>`;
  const userActions = user
    ? `<span class="account-label">${escapeHtml(user.label)}</span> <a class="btn btn-ghost btn-sm" href="${escapeHtml(user.logout)}">Log out</a>`
    : `<a class="btn btn-ghost btn-sm" href="/merchant/login">Login</a> <a class="btn btn-sm" href="/merchant/register">Get started</a>`;

  if (shell === 'merchant' || shell === 'admin') {
    const role = shell === 'admin' ? 'Administrator' : 'Merchant';
    return `${head}<a class="skip-link" href="#main">Skip to content</a><div class="shell"><aside class="sidebar" aria-label="${role} navigation">${brandHtml()}<nav class="sidebar-nav">${navHtml}</nav><div class="sidebar-foot"><p>${role} panel</p><p>${user ? escapeHtml(user.label) : ''}</p>${user ? `<p><a href="${escapeHtml(user.logout)}">Log out</a></p>` : ''}</div></aside><div class="shell-main"><header class="topbar">${brandHtml()}<details class="shell-menu"><summary aria-label="Open navigation menu" aria-expanded="false">Menu</summary><nav aria-label="${role} navigation"><button type="button" class="drawer-close" data-close-menu aria-label="Close menu">✕ Close</button>${navHtml}</nav><button type="button" class="drawer-backdrop" data-close-menu aria-label="Close navigation menu" tabindex="-1"></button></details><span class="topbar-title">${safeTitle}</span><form method="get" action="${isAdmin ? '/admin/orders' : '/merchant/orders'}" class="topbar-search" role="search"><input name="q" type="search" placeholder="Search merchants, orders…" aria-label="Search orders"><button type="submit">Search</button></form><div class="topbar-account">${userActions}</div></header><main id="main" class="wrap shell-wrap"><h1 class="page-title">${safeTitle}</h1>${body}</main><footer class="shell-footer">${DISCLAIMER}</footer></div></div>${confirmScript()}</body></html>`;
  }

  if (shell === 'auth') {
    return `${head}<a class="skip-link" href="#main">Skip to content</a><div class="auth-shell"><aside class="auth-panel" aria-hidden="true">${brandHtml()}<h2>Payments, verified properly.</h2><p>UPI checkout, honest statuses, and APIs your developers will actually enjoy — with no false success, ever.</p><ul><li><strong>UPI QR checkout</strong> with exact amounts and references</li><li><strong>Manual reconciliation</strong> before any order succeeds</li><li><strong>API + signed webhooks</strong> for your own systems</li></ul><div class="auth-mock"><div class="auth-mock-row"><span>Order created</span><span class="badge pending">pending</span></div><div class="auth-mock-row"><span>Verified vs bank record</span><span class="badge success">success</span></div><div class="auth-mock-row"><span>Webhook delivered · signed</span><span class="badge success">success</span></div></div></aside><main id="main" class="auth-main"><div class="auth-card"><h1>${safeTitle}</h1>${body}</div><p class="muted small auth-foot"><a href="/">Back to homepage</a> · <a href="/pricing">Pricing</a> · <a href="/support">Support</a> · <a href="/admin/login">Admin login</a></p></main></div>${confirmScript()}${authScript()}</body></html>`;
  }

  if (shell === 'checkout') {
    return `${head}<a class="skip-link" href="#main">Skip to content</a><header class="site-header"><div class="header-inner">${brandHtml()}<div class="header-actions"><span class="account-label">Secure checkout</span></div></div></header><main id="main" class="wrap checkout-wrap">${hideTitle ? '' : `<h1 class="page-title" style="text-align:center">${safeTitle}</h1>`}${body}<p class="muted small" style="text-align:center">${DISCLAIMER}</p></main>${confirmScript()}</body></html>`;
  }

  // Public shell (landing, docs, auth, install, errors).
  return `${head}<a class="skip-link" href="#main">Skip to content</a><header class="site-header"><div class="header-inner">${brandHtml()}<nav class="nav-links" aria-label="Primary">${navHtml}</nav><div class="header-actions">${userActions}</div><details class="mobile-nav"><summary aria-label="Open menu">&#9776;</summary><div class="mobile-nav-panel"><nav><button type="button" class="drawer-close dark" data-close-menu aria-label="Close menu">✕ Close</button>${navHtml}</nav><div style="display:flex;gap:.6rem;flex-wrap:wrap">${userActions}</div></div><button type="button" class="drawer-backdrop" data-close-menu aria-label="Close menu" tabindex="-1"></button></details></div></header><main id="main" class="wrap">${hideTitle ? '' : `<h1 class="page-title">${safeTitle}</h1>`}${body}</main><footer class="site-footer"><div class="footer-inner"><div class="footer-grid"><div><h4>YOUPI PG</h4><p class="muted small">Multi-merchant UPI payment gateway. One Node.js app, one MySQL database — no Docker, Redis or PostgreSQL required.</p></div><div><h4>Product</h4><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/faq">FAQ</a><a href="/#workflow">How it works</a></div><div><h4>Developers</h4><a href="/docs">Documentation</a><a href="/merchant/docs">Integration guide</a><a href="/merchant/register">Get started</a></div><div><h4>Support &amp; legal</h4><a href="/support">Support</a><a href="/contact">Contact</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refund-policy">Refund policy</a></div><div><h4>Account</h4><a href="/merchant/login">Merchant login</a><a href="/merchant/register">Merchant registration</a><a href="/admin/login">Admin login</a></div></div><div class="footer-bottom"><span>YOUPI PG — multi-merchant UPI gateway.</span><span>${DISCLAIMER}</span></div></div></footer>${confirmScript()}</body></html>`;
}

export function alert(type, text) {
  if (!text) return '';
  return `<div class="alert ${escapeHtml(type)}">${escapeHtml(text)}</div>`;
}

export function field(label, name, type = 'text', value = '', attrs = '') {
  return `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}" ${attrs}></label>`;
}

export function csrfField(token) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

export function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export function ordersTable(orders, { detailBase }) {
  if (!orders.length) return '<div class="empty-state"><p class="empty-title">No orders found</p><p class="muted">Orders you create will appear here with their live status.</p></div>';
  const rows = orders.map((o) => `<tr><td data-label="Reference"><a href="${detailBase}/${escapeHtml(o.gateway_reference)}">${escapeHtml(o.gateway_reference)}</a></td><td data-label="Merchant order">${escapeHtml(o.merchant_order_id)}</td><td data-label="Amount">${formatPaise(o.amount_paise)}</td><td data-label="Status">${statusBadge(o.status)}</td><td data-label="Verified by">${escapeHtml(o.verification_source || 'none')}</td><td data-label="UTR">${escapeHtml(o.verification_utr || '—')}</td><td data-label="Created">${formatDate(o.created_at)}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Merchant order</th><th>Amount</th><th>Status</th><th>Verified by</th><th>UTR</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function paginationLinks(base, page, perPage, hasMore) {
  const prev = page > 1 ? `<a href="${base}&page=${page - 1}&per_page=${perPage}">← Previous</a>` : '';
  const next = hasMore ? `<a href="${base}&page=${page + 1}&per_page=${perPage}">Next →</a>` : '';
  return `<div class="pager">${prev} <span>Page ${page}</span> ${next}</div>`;
}
