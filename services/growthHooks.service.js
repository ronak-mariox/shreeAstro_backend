/**
 * Where the growth programmes plug into the rest of the product.
 *
 * One function per event — a consultation ended, an order was delivered, a
 * puja was completed, an account was registered — each of which awards
 * loyalty points, pays a tier's cashback and settles a referral, in that
 * order. Every step is idempotent on its own (loyalty's dedupe key, the
 * cashback ledger check, the referral row's atomic claim), so a hook may run
 * twice for the same event and pay once.
 *
 * Nothing here may break the thing that triggered it: a seeker's order is
 * delivered whether or not points could be written. Failures are logged.
 */

const loyaltyService = require('./loyalty.service');
const referralService = require('./referral.service');

const guard = (label, work) =>
  work().catch(error => {
    console.error(`[growth] ${label} failed:`, error.message);
    return null;
  });

/**
 * A chat or call finished and its billing is settled. Points at the channel's
 * rate on what was charged, cashback if the seeker's tier earns it, and the
 * referral reward when this was their qualifying first spend.
 */
async function onConsultationEnded(chat) {
  const amount = Math.round(Number(chat?.billing?.amountCharged)) || 0;
  if (!chat || amount <= 0) {
    return { points: null, cashback: null, referral: null };
  }
  const source = { kind: 'consultation', id: chat._id };
  const kind = chat.channel === 'call' ? 'call' : 'chat';

  const points = await guard('loyalty on consultation', () =>
    loyaltyService.awardForSpend({ userId: chat.user, kind, amount, source }),
  );
  const cashback = await guard('cashback on consultation', () =>
    loyaltyService.creditCashback({ userId: chat.user, amount, chatSession: chat._id }),
  );
  const referral = await guard('referral on consultation', () =>
    referralService.onQualifyingSpend({ userId: chat.user, amount, source }),
  );
  return { points, cashback, referral };
}

/** A store order reached `delivered`. */
async function onOrderDelivered(order) {
  const amount = Math.round(Number(order?.total)) || 0;
  if (!order || amount <= 0) {
    return { points: null, referral: null };
  }
  const source = { kind: 'order', id: order._id };
  const points = await guard('loyalty on order', () =>
    loyaltyService.awardForSpend({
      userId: order.user,
      kind: 'order',
      amount,
      source,
      reason: `Store order ${order.reference}`,
    }),
  );
  const referral = await guard('referral on order', () =>
    referralService.onQualifyingSpend({ userId: order.user, amount, source }),
  );
  return { points, referral };
}

/** A puja booking was marked `completed`. */
async function onBookingCompleted(booking) {
  const amount = Math.round(Number(booking?.amount)) || 0;
  if (!booking || amount <= 0) {
    return { points: null, referral: null };
  }
  const source = { kind: 'puja', id: booking._id };
  const points = await guard('loyalty on puja', () =>
    loyaltyService.awardForSpend({
      userId: booking.user,
      kind: 'puja',
      amount,
      source,
      reason: `${booking.pujaSnapshot?.name || 'Puja'} (${booking.reference})`,
    }),
  );
  const referral = await guard('referral on puja', () =>
    referralService.onQualifyingSpend({ userId: booking.user, amount, source }),
  );
  return { points, referral };
}

/** A seeker account was just created; `referralCode` is whatever the form sent. */
async function onUserRegistered({ user, referralCode }) {
  const referralApplied = await guard('referral at registration', () =>
    referralService.applyAtRegistration({ user, referralCode }),
  );
  await guard('signup bonus', () => loyaltyService.awardSignupBonus(user._id));
  return { referralApplied: Boolean(referralApplied) };
}

module.exports = {
  onConsultationEnded,
  onOrderDelivered,
  onBookingCompleted,
  onUserRegistered,
};
