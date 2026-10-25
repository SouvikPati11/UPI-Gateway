/* YOUPI PG Checkout SDK
 * Usage (from the merchant's own server-side code, never with a secret key
 * in the browser):
 *   1. Your server creates an order via POST /api/v1/orders with a SECRET
 *      API key and receives { order: { checkout_url } }.
 *   2. Pass that checkout_url to YoupiCheckout.open(checkoutUrl) below.
 * Secret keys must never appear in HTML or JavaScript. Public keys may be
 * used only to identify a merchant; they cannot create orders.
 */
(function () {
  function openCheckout(checkoutUrl) {
    if (!checkoutUrl || typeof checkoutUrl !== 'string') throw new Error('checkoutUrl is required');
    window.location.href = checkoutUrl;
  }
  function bindButtons() {
    document.querySelectorAll('[data-youpi-checkout-url]').forEach(function (el) {
      el.addEventListener('click', function () { openCheckout(el.getAttribute('data-youpi-checkout-url')); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindButtons);
  else bindButtons();
  window.YoupiCheckout = { open: openCheckout, openCheckout: openCheckout };
  // Backwards-compatible name used in the original YOUPI docs.
  window.Youpi = window.Youpi || {};
  window.Youpi.pay = function (options) {
    if (options && options.checkoutUrl) return openCheckout(options.checkoutUrl);
    throw new Error('Youpi.pay requires a checkoutUrl created by your server with a secret API key.');
  };
})();
