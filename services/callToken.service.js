/**
 * Voice calls: the Agora RTC token a participant needs to join a `call`
 * consultation's audio channel.
 *
 * A call is a ChatSession with `channel: 'call'` — requested, accepted,
 * billed, paused and ended by services/chat.service.js exactly like a chat.
 * Agora only carries the audio, and this file only mints the credential to
 * join it: one channel per session (named after the session id), a fixed uid
 * per side so each app knows which uid is the peer, and a token that lives
 * `AGORA_TOKEN_TTL_SECONDS` (the apps renew before it runs out).
 *
 * Nothing here charges anything. Whether the seeker can afford the next
 * minute is the billing sweep's business; this just refuses to hand out a
 * token for a session that is not an active call.
 */

const { RtcTokenBuilder, RtcRole } = require('agora-token');

const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { participantChat } = require('./chat.service');

/**
 * Fixed per side, so the seeker's app knows the astrologer is uid 2001 and
 * vice versa, without a lookup. One seeker and one astrologer per session, so
 * two constants are all a channel ever holds.
 */
const CALL_UIDS = Object.freeze({ user: 1001, astrologer: 2001 });

/** Agora's token format version — every token this library builds starts with it. */
const AGORA_TOKEN_VERSION_PREFIX = '007';

/**
 * Builds one RTC token. Pure: no database, no env — every input is a
 * parameter so a test can check the builder on its own.
 *
 * @param {object} p
 * @param {string} p.appId
 * @param {string} p.appCertificate
 * @param {string} p.channelName
 * @param {number} p.uid
 * @param {number} p.ttlSeconds  Both the token's own expiry and the join privilege's.
 * @returns {string}
 */
function buildRtcToken({ appId, appCertificate, channelName, uid, ttlSeconds }) {
  return RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    ttlSeconds,
    ttlSeconds,
  );
}

/**
 * The token for one participant of one active call.
 *
 * @param {{ chatId: string, accountId: string }} p
 * @returns {Promise<{
 *   provider: 'agora', appId: string, channelName: string, uid: number, peerUid: number,
 *   role: 'user'|'astrologer', token: string, expiresAt: string, ttlSeconds: number,
 * }>}
 */
async function issueCallToken({ chatId, accountId }) {
  /** Same guard as every other consultation endpoint: 404 unknown, 403 a stranger. */
  const [chat, role] = await participantChat(chatId, accountId);

  if (chat.channel !== 'call') {
    throw ApiError.badRequest('This consultation is a chat, not a call.', undefined, 'not_a_call');
  }

  if (chat.status !== 'active') {
    throw ApiError.conflict(
      chat.status === 'requested'
        ? 'The call has not started yet.'
        : 'This call is over.',
      undefined,
      'not_active',
    );
  }

  if (!env.agora.enabled) {
    throw new ApiError(503, 'Voice calls are not set up on this server yet.', undefined, 'calls_unconfigured');
  }

  const { appId, appCertificate, tokenTtlSeconds } = env.agora;
  const channelName = String(chat._id);
  const uid = CALL_UIDS[role];
  const peerUid = role === 'user' ? CALL_UIDS.astrologer : CALL_UIDS.user;
  const token = buildRtcToken({ appId, appCertificate, channelName, uid, ttlSeconds: tokenTtlSeconds });

  return {
    provider: 'agora',
    appId,
    channelName,
    uid,
    peerUid,
    role,
    token,
    expiresAt: new Date(Date.now() + tokenTtlSeconds * 1000).toISOString(),
    ttlSeconds: tokenTtlSeconds,
  };
}

module.exports = { issueCallToken, buildRtcToken, CALL_UIDS, AGORA_TOKEN_VERSION_PREFIX };
