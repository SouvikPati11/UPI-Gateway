// Pure UPI URI builder, ported from the original packages/common UPI logic.
// It deliberately takes amount in integer paise and never uses floating point
// for the money conversion: 49900 paise -> "499.00", 5 paise -> "0.05".

const UPI_ID_RE = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z][a-zA-Z0-9.-]*$/;

export function formatPaiseAsRupees(amountPaise) {
  if (typeof amountPaise !== 'number' && typeof amountPaise !== 'bigint') {
    throw new Error('amountPaise must be an integer number of paise.');
  }
  const paise = BigInt(amountPaise);
  if (paise <= 0n) throw new Error('amountPaise must be greater than 0.');
  const rupees = paise / 100n;
  const remainder = (paise % 100n).toString().padStart(2, '0');
  return `${rupees.toString()}.${remainder}`;
}

export function buildUpiUri({ upiId, payeeName, amountPaise, transactionRef }) {
  if (!upiId || !UPI_ID_RE.test(String(upiId).trim())) {
    throw new Error('upiId must be a valid UPI ID (handle@bank).');
  }
  if (!payeeName || !String(payeeName).trim()) {
    throw new Error('payeeName is required.');
  }
  if (!transactionRef || !String(transactionRef).trim()) {
    throw new Error('transactionRef (gateway order reference) is required.');
  }
  const amount = formatPaiseAsRupees(amountPaise);
  const params = new URLSearchParams({
    pa: String(upiId).trim(),
    pn: String(payeeName).trim(),
    am: amount,
    cu: 'INR',
    tn: String(transactionRef).trim(),
  });
  return `upi://pay?${params.toString()}`;
}
