import { escapeHtml, formatPaise, formatDate } from './validate.js';

export function layout({ title, body, user, nav }) {
  const userHtml = user
    ? `<span class="muted">${escapeHtml(user.label)}</span> <a href="${escapeHtml(user.logout)}">Log out</a>`
    : `<a href="/merchant/login">Merchant login</a> <a href="/merchant/register">Register</a> <a href="/admin/login">Admin</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} — YOUPI PG</title><link rel="stylesheet" href="/public/css/style.css"></head><body><header class="top"><a class="brand" href="/">YOUPI PG</a><nav>${nav || ''}</nav><div class="user">${userHtml}</div></header><main class="wrap"><h1>${escapeHtml(title)}</h1>${body}</main><footer class="wrap muted">YOUPI PG — multi-merchant UPI gateway. A QR code, redirect, screenshot or “I have paid” click is never proof of payment. Orders stay pending until verified by manual reconciliation, a configured provider, or an optional external observer.</footer></body></html>`;
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
  if (!orders.length) return '<p class="muted">No orders found.</p>';
  const rows = orders.map((o) => `<tr><td><a href="${detailBase}/${escapeHtml(o.gateway_reference)}">${escapeHtml(o.gateway_reference)}</a></td><td>${escapeHtml(o.merchant_order_id)}</td><td>${formatPaise(o.amount_paise)}</td><td>${statusBadge(o.status)}</td><td>${escapeHtml(o.verification_source || 'none')}</td><td>${escapeHtml(o.verification_utr || '—')}</td><td>${formatDate(o.created_at)}</td></tr>`).join('');
  return `<table><thead><tr><th>Reference</th><th>Merchant order</th><th>Amount</th><th>Status</th><th>Verified by</th><th>UTR</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function paginationLinks(base, page, perPage, hasMore) {
  const prev = page > 1 ? `<a href="${base}&page=${page - 1}&per_page=${perPage}">← Previous</a>` : '';
  const next = hasMore ? `<a href="${base}&page=${page + 1}&per_page=${perPage}">Next →</a>` : '';
  return `<div class="pager">${prev} <span>Page ${page}</span> ${next}</div>`;
}
