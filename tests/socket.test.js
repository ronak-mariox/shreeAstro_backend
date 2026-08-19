/** Live chat over websockets: join, send, receipts, typing, end. */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_socket';
process.env.REDIS_KEY_PREFIX = 'shreeastro-test:';
process.env.NODE_ENV = 'development';

const http = require('http');
const mongoose = require('mongoose');
const ioClient = require('socket.io-client');

const { createApp } = require('../app');
const { initSocket } = require('../socket');
const { CHAT_EVENTS } = require('../models/Chat');

const PORT = 5098;
let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
/** Waits for one event, or gives up. */
const once = (socket, event, ms = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
const emit = (socket, event, payload) =>
  new Promise(resolve => socket.emit(event, payload, resolve));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const server = http.createServer(createApp());
  initSocket(server);
  await new Promise(r => server.listen(PORT, r));

  const User = require('../models/User');
  const Astrologer = require('../models/Astrologer');
  const { ChatSession } = require('../models/Chat');
  const authService = require('../services/auth.service');
  const chatService = require('../services/chat.service');

  const user = await User.create({ name: 'Arjun', phone: { number: '9876543210' }, email: 'a@x.com' });
  const astrologer = await Astrologer.create({
    name: 'Pt. Rajesh', phone: { number: '9811111111' },
    applicationStatus: 'approved', status: 'active',
    services: [{ type: 'chat', isEnabled: true, ratePerMinute: 20 }],
    presence: { isOnline: true },
  });

  const userTokens = authService.issueTokens(user._id, 'user');
  const astroTokens = authService.issueTokens(astrologer._id, 'astrologer');

  const url = `http://127.0.0.1:${PORT}`;

  console.log('\n=== handshake ===');
  const refused = ioClient(url, { auth: { token: 'not-a-token' }, transports: ['websocket'] });
  const refusal = await once(refused, 'connect_error');
  check('a bad token is refused at the handshake', refusal.data?.code === 'invalid_token', refusal.data);
  refused.close();

  const userSocket = ioClient(url, { auth: { token: userTokens.accessToken }, transports: ['websocket'] });
  const astroSocket = ioClient(url, { auth: { token: astroTokens.accessToken }, transports: ['websocket'] });
  await Promise.all([once(userSocket, 'connect'), once(astroSocket, 'connect')]);
  check('both sides connect with a valid token', userSocket.connected && astroSocket.connected);

  // An astrologer holding a socket is what "online" means.
  await new Promise(r => setTimeout(r, 200));
  const presence = await Astrologer.findById(astrologer._id).select('presence');
  check('connecting marks the astrologer online', presence.presence.isOnline === true);

  console.log('\n=== the incoming request reaches the astrologer live ===');
  const incoming = once(astroSocket, 'chat:requested');
  const chat = await chatService.requestChat({
    userId: user._id, astrologerId: astrologer._id, channel: 'chat',
    intake: { topic: 'career-job', question: 'Job change?' },
  });
  const request = await incoming;
  check('the request arrives over the socket', request.chatId === String(chat._id), request);
  check('it carries the intake', request.intake?.topic === 'career-job');

  const started = once(userSocket, 'chat:accepted');
  await chatService.acceptChat({ chatId: chat._id, astrologerId: astrologer._id });
  check('the user is told it was accepted', (await started).chatId === String(chat._id));

  console.log('\n=== joining and messaging ===');
  const userJoin = await emit(userSocket, CHAT_EVENTS.JOIN, { chatId: String(chat._id), lastSeq: 0 });
  check('the user joins the room', userJoin.role === 'user' && userJoin.status === 'active', userJoin);
  check('the join replays what was missed', userJoin.messages.length === 1 && userJoin.messages[0].type === 'system', userJoin.messages);

  const astroJoin = await emit(astroSocket, CHAT_EVENTS.JOIN, { chatId: String(chat._id), lastSeq: 0 });
  check('the astrologer joins the same room', astroJoin.role === 'astrologer');

  const delivered = once(astroSocket, CHAT_EVENTS.NEW);
  const echoed = once(userSocket, CHAT_EVENTS.NEW);
  const ack = await emit(userSocket, CHAT_EVENTS.SEND, {
    chatId: String(chat._id), type: 'text', content: { text: 'Namaste' }, clientMessageId: 'c-1',
  });
  check('the send is acknowledged', ack.message?.content?.text === 'Namaste', ack);
  const atAstro = await delivered;
  check('the other side receives it', atAstro.content.text === 'Namaste' && atAstro.senderRole === 'user');
  const atUser = await echoed;
  check('the sender receives its own message back', atUser.id === atAstro.id);
  check('it carries its client id, so the pending bubble can be matched', atUser.clientMessageId === 'c-1');

  const reply = once(userSocket, CHAT_EVENTS.NEW);
  await emit(astroSocket, CHAT_EVENTS.SEND, { chatId: String(chat._id), content: { text: 'Tell me your birth time.' } });
  const atUser2 = await reply;
  check('the astrologer can reply', atUser2.senderRole === 'astrologer', atUser2.content);
  check('messages keep their order', atUser2.seq > atUser.seq);

  console.log('\n=== what is refused ===');
  const badType = await emit(userSocket, CHAT_EVENTS.SEND, { chatId: String(chat._id), type: 'image', content: { url: 'http://x/y.jpg' } });
  check('non-text messages are refused', /not enabled/.test(badType.error || ''), badType);

  const stranger = await User.create({ name: 'Nosy', phone: { number: '9700000000' } });
  const strangerSocket = ioClient(url, { auth: { token: authService.issueTokens(stranger._id, 'user').accessToken }, transports: ['websocket'] });
  await once(strangerSocket, 'connect');
  const denied = await emit(strangerSocket, CHAT_EVENTS.JOIN, { chatId: String(chat._id) });
  check('a stranger cannot join the room', /not part of this chat/.test(denied.error || ''), denied);
  strangerSocket.close();

  console.log('\n=== typing and receipts ===');
  const typing = once(astroSocket, CHAT_EVENTS.TYPING);
  userSocket.emit(CHAT_EVENTS.TYPING, { chatId: String(chat._id), isTyping: true });
  const typingSeen = await typing;
  check('typing reaches the other side only', typingSeen.role === 'user' && typingSeen.isTyping === true, typingSeen);

  const readSeen = once(userSocket, CHAT_EVENTS.READ);
  await emit(astroSocket, CHAT_EVENTS.READ, { chatId: String(chat._id), seq: atUser2.seq });
  const receipt = await readSeen;
  check('a read receipt reaches the sender', receipt.by === 'astrologer' && receipt.seq === atUser2.seq, receipt);

  const afterRead = await ChatSession.findById(chat._id);
  check('the unread badge clears for the reader', afterRead.unread.astrologer === 0, afterRead.unread);

  console.log('\n=== reconnecting ===');
  const rejoin = await emit(astroSocket, CHAT_EVENTS.JOIN, { chatId: String(chat._id), lastSeq: atUser.seq });
  check('rejoining replays only what was missed', rejoin.messages.length === 1 && rejoin.messages[0].seq === atUser2.seq, rejoin.messages.map(m => m.seq));

  console.log('\n=== ending ===');
  const endedAtUser = once(userSocket, CHAT_EVENTS.ENDED);
  await chatService.endChat({ chatId: chat._id, accountId: astrologer._id, endedBy: 'astrologer' });
  const endEvent = await endedAtUser;
  check('both sides are told it ended', endEvent.chatId === String(chat._id) && endEvent.endedBy === 'astrologer', endEvent);

  const afterEnd = await emit(userSocket, CHAT_EVENTS.SEND, { chatId: String(chat._id), content: { text: 'one more thing' } });
  check('no messages after it ends', /ended/.test(afterEnd.error || ''), afterEnd);

  console.log('\n=== disconnect ===');
  astroSocket.close();
  await new Promise(r => setTimeout(r, 400));
  const offline = await Astrologer.findById(astrologer._id).select('presence');
  check('disconnecting marks the astrologer offline', offline.presence.isOnline === false, offline.presence);

  console.log(`\n${pass} passed, ${fail} failed`);

  userSocket.close();
  server.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e.message); process.exit(1); });
