import { escapeHtml, formatPaise, formatDate } from './validate.js';

const BRAND_MARK = '<span class="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13.5 2 6 14h4.5L10 22l7.5-12H13l.5-8Z" fill="#fff"/></svg></span>';
const DEFAULT_PUBLIC_NAV = '<a href="/features">Products</a> <a href="/#workflow">Solutions</a> <a href="/docs">Developers</a> <a href="/pricing">Pricing</a>';

function brandHtml() {
  return `<a class="brand" href="/">${BRAND_MARK}<span>YOUPI<em>PG</em></span></a>`;
}

function confirmScript() {
  return `<script>document.addEventListener('submit',function(e){var f=e.target;var m=f.getAttribute&&f.getAttribute('data-confirm');if(m&&!window.confirm(m)){e.preventDefault();}},true);</script>`;
}

const DISCLAIMER = 'A QR code, redirect, screenshot or “I have paid” click is never proof of payment. Orders stay pending until payment verification by manual reconciliation, a configured provider, or an optional external observer.';

export function layout({ title, body, user, nav, variant, hideTitle }) {
  const navHtml = nav || DEFAULT_PUBLIC_NAV;
  const isAdmin = /\/admin\//.test(navHtml);
  const isMerchant = /\/merchant\//.test(navHtml);
  const shell = variant || (isAdmin ? 'admin' : isMerchant ? 'merchant' : 'public');
  const safeTitle = escapeHtml(title);
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="YOUPI PG — multi-merchant UPI payment gateway with QR checkout, API, webhooks and manual payment verification."><title>${safeTitle} — YOUPI PG</title><link rel="stylesheet" href="/public/css/style.css"></head><body>`;
  const userActions = user
    ? `<span class="account-label">${escapeHtml(user.label)}</span> <a class="btn btn-ghost btn-sm" href="${escapeHtml(user.logout)}">Log out</a>`
    : `<a class="btn btn-ghost btn-sm" href="/merchant/login">Login</a> <a class="btn btn-sm" href="/merchant/register">Get started</a>`;

  if (shell === 'merchant' || shell === 'admin') {
    const role = shell === 'admin' ? 'Administrator' : 'Merchant';
    return `${head}<a class="skip-link" href="#main">Skip to content</a><div class="shell"><aside class="sidebar" aria-label="${role} navigation">${brandHtml()}<nav class="sidebar-nav">${navHtml}</nav><div class="sidebar-foot"><p>${role} panel</p><p>${user ? escapeHtml(user.label) : ''}</p>${user ? `<p><a href="${escapeHtml(user.logout)}">Log out</a></p>` : ''}</div></aside><div class="shell-main"><header class="topbar">${brandHtml()}<details class="shell-menu"><summary>Menu</summary><nav>${navHtml}</nav></details><span class="topbar-title">${safeTitle}</span><div class="topbar-account">${userActions}</div></header><main id="main" class="wrap shell-wrap"><h1 class="page-title">${safeTitle}</h1>${body}</main><footer class="shell-footer">${DISCLAIMER}</footer></div></div>${confirmScript()}</body></html>`;
  }

  if (shell === 'checkout') {
    return `${head}<a class="skip-link" href="#main">Skip to content</a><header class="site-header"><div class="header-inner">${brandHtml()}<div class="header-actions"><span class="account-label">Secure checkout</span></div></div></header><main id="main" class="wrap checkout-wrap">${hideTitle ? '' : `<h1 class="page-title" style="text-align:center">${safeTitle}</h1>`}${body}<p class="muted small" style="text-align:center">${DISCLAIMER}</p></main>${confirmScript()}</body></html>`;
  }

  // Public shell (landing, docs, auth, install, errors).
  return `${head}<a class="skip-link" href="#main">Skip to content</a><header class="site-header"><div class="header-inner">${brandHtml()}<nav class="nav-links" aria-label="Primary">${navHtml}</nav><div class="header-actions">${userActions}</div><details class="mobile-nav"><summary aria-label="Open menu">&#9776;</summary><div class="mobile-nav-panel"><nav>${navHtml}</nav><div style="display:flex;gap:.6rem;flex-wrap:wrap">${userActions}</div></div></details></div></header><main id="main" class="wrap">${hideTitle ? '' : `<h1 class="page-title">${safeTitle}</h1>`}${body}</main><footer class="site-footer"><div class="footer-inner"><div class="footer-grid"><div><h4>YOUPI PG</h4><p class="muted small">Multi-merchant UPI payment gateway. One Node.js app, one MySQL database — no Docker, Redis or PostgreSQL required.</p></div><div><h4>Product</h4><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/faq">FAQ</a><a href="/#workflow">How it works</a></div><div><h4>Developers</h4><a href="/docs">Documentation</a><a href="/merchant/docs">Integration guide</a><a href="/merchant/register">Get started</a></div><div><h4>Support &amp; legal</h4><a href="/support">Support</a><a href="/contact">Contact</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refund-policy">Refund policy</a></div><div><h4>Account</h4><a href="/merchant/login">Merchant login</a><a href="/merchant/register">Merchant registration</a><a href="/admin/login">Admin login</a></div></div><div class="footer-bottom"><span>YOUPI PG — multi-merchant UPI gateway.</span><span>${DISCLAIMER}</span></div></div></footer>${confirmScript()}</body></html>`;
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
